import { sha256Hex } from "./util.ts";

const SECRET = /sk-[A-Za-z0-9_-]+/g;
const SENSITIVE_KEYS = ["token", "secret", "password", "authorization", "api_key", "apikey"];

export type StoredEvent = {
  seq: number;
  type: string;
  ts?: string;
  data: Record<string, unknown>;
};

export type SpanEvent = {
  seq: number;
  name: string;
  attributes: Record<string, unknown>;
};

export class Span {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: string;
  scope: string;
  start_seq: number;
  end_seq: number;
  status: string;
  attributes: Record<string, unknown>;
  events: SpanEvent[];

  constructor(
    trace_id: string,
    span_id: string,
    parent_span_id: string | null,
    name: string,
    kind: string,
    scope: string,
    start_seq: number,
    attributes: Record<string, unknown> = {},
  ) {
    this.trace_id = trace_id;
    this.span_id = span_id;
    this.parent_span_id = parent_span_id;
    this.name = name;
    this.kind = kind;
    this.scope = scope;
    this.start_seq = start_seq;
    this.end_seq = 0;
    this.status = "ok";
    this.attributes = attributes;
    this.events = [];
  }

  close(seq: number, status = "ok", attributes: Record<string, unknown> = {}): void {
    this.end_seq = seq;
    this.status = status;
    this.attributes = { ...this.attributes, ...attributes };
  }
}

export class Trace {
  trace_id: string;
  session_id: string;
  root_span_id: string;
  spans: Span[];

  constructor(trace_id: string, session_id: string, root_span_id: string, spans: Span[]) {
    this.trace_id = trace_id;
    this.session_id = session_id;
    this.root_span_id = root_span_id;
    this.spans = spans;
  }

  span(span_id: string): Span | undefined {
    return this.spans.find((item) => item.span_id === span_id);
  }
}

export class TraceSummary {
  turns = 0;
  tool_attempts = 0;
  tool_ok = 0;
  tool_failed = 0;
  tool_blocked = 0;
  approvals = 0;
  approval_wait = 0;
  compactions = 0;
  subagents = 0;
  reason = "";
  input_tokens = 0;
  output_tokens = 0;

  get tool_success_rate(): number {
    return this.tool_attempts === 0 ? 0 : this.tool_ok / this.tool_attempts;
  }
}

function spanId(traceId: string, scope: string, seq: number, kind: string, counter: number): string {
  return sha256Hex(`${traceId}|${scope}|${seq}|${kind}|${counter}`).slice(0, 16);
}

export function traceIdFor(sessionId: string): string {
  const root = sessionId.split("--")[0];
  return sha256Hex(root).slice(0, 32);
}

export function traceparent(traceId: string, spanIdValue: string, sampled = true): string {
  if (traceId.length !== 32 || spanIdValue.length !== 16) {
    throw new Error("traceparent 需要 32 位 trace-id 与 16 位 span-id");
  }
  return `00-${traceId}-${spanIdValue}-${sampled ? "01" : "00"}`;
}

export function parseTraceparent(header: string): [string, string, boolean] {
  const parts = (header ?? "").split("-");
  if (parts.length !== 4) return ["0".repeat(32), "0".repeat(16), false];
  const [version, traceId, spanIdValue, flags] = parts;
  if (version !== "00" || traceId.length !== 32 || spanIdValue.length !== 16) {
    return ["0".repeat(32), "0".repeat(16), false];
  }
  return [traceId, spanIdValue, (parseInt(flags, 16) & 0x01) === 1];
}

export function redactText(value: unknown, maxChars = 160): string {
  const text = String(value).replace(SECRET, "sk-***");
  return text.length <= maxChars ? text : text.slice(0, maxChars) + "…";
}

export function redactArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const lower = key.toLowerCase();
    if (lower === "content") {
      clean[key] = `<${String(value).length} chars>`;
    } else if (SENSITIVE_KEYS.some((word) => lower.includes(word))) {
      clean[key] = "***";
    } else if (typeof value === "string") {
      clean[key] = redactText(value);
    } else if (Array.isArray(value)) {
      clean[key] = value.map((item) => (typeof item === "string" ? redactText(item) : item));
    } else {
      clean[key] = value;
    }
  }
  if (tool === "run_command" && Array.isArray(clean.argv)) {
    const argv = clean.argv as unknown[];
    for (let index = 0; index < argv.length; index += 1) {
      if (["--token", "--password", "--api-key"].includes(String(argv[index])) && index + 1 < argv.length) {
        argv[index + 1] = "***";
      }
    }
  }
  return clean;
}

function statusForTurn(stop: string): string {
  return ["no_progress", "budget_exceeded", "cancelled"].includes(stop) ? stop : "ok";
}

function statusForSession(reason: string): string {
  return reason === "completed" ? "ok" : reason || "incomplete";
}

function lastTool(tools: Map<string, Span>): Span | undefined {
  const values = Array.from(tools.values());
  return values.length === 0 ? undefined : values[values.length - 1];
}

export class TraceBuilder {
  trace_id: string;
  session_id: string;
  root_parent_id: string | null;
  create_session_span: boolean;
  spans: Span[] = [];
  private counter = 0;
  root: Span | null = null;
  task: Span | null = null;
  turn: Span | null = null;
  tools = new Map<string, Span>();
  approvals = new Map<string, Span>();
  sandbox: Span | null = null;
  subagents = new Map<string, Span>();
  commands: Span[] = [];
  last_seq = 0;

  constructor(
    traceId?: string,
    options: { session_id?: string; root_parent_id?: string | null; create_session_span?: boolean } = {},
  ) {
    this.session_id = options.session_id ?? "";
    this.trace_id = traceId ?? traceIdFor(this.session_id || "session");
    this.root_parent_id = options.root_parent_id ?? null;
    this.create_session_span = options.create_session_span ?? true;
  }

  private newSpan(
    name: string,
    kind: string,
    parent: Span | null,
    seq: number,
    attributes: Record<string, unknown> = {},
  ): Span {
    this.counter += 1;
    const span = new Span(
      this.trace_id,
      spanId(this.trace_id, this.session_id || "session", seq, kind, this.counter),
      parent !== null ? parent.span_id : this.root_parent_id,
      name,
      kind,
      this.session_id,
      seq,
      attributes,
    );
    this.spans.push(span);
    return span;
  }

  private parent(): Span | null {
    return this.turn ?? this.task ?? this.root;
  }

  private point(name: string, seq: number, data: Record<string, unknown>): void {
    const parent = this.turn ?? this.task ?? this.root;
    const target = lastTool(this.tools) ?? parent;
    if (target !== null) {
      target.events.push({ seq, name, attributes: { ...data } });
    }
  }

  feed(event: StoredEvent | StoredEvent[]): TraceBuilder {
    const events = Array.isArray(event) ? event : [event];
    for (const item of events) this.feedOne(item);
    return this;
  }

  private feedOne(event: StoredEvent): void {
    let typ = String(event.type ?? "");
    const data: Record<string, unknown> = { ...(event.data ?? {}) };
    const seq = Number(event.seq ?? 0);
    this.last_seq = Math.max(this.last_seq, seq);

    let delegationId = "";
    if (typ.startsWith("sub:") && typ.split(":").length >= 3) {
      const parts = typ.split(":");
      delegationId = parts[1];
      typ = parts.slice(2).join(":");
    }
    if (typ === "tool_finished") typ = data.ok === false ? "tool_failed" : "tool_committed";
    if (typ === "") return;

    if (typ === "session_started") {
      this.session_id = String(data.session_id ?? this.session_id);
      this.root = this.newSpan("session", "session", null, seq, {
        session_id: this.session_id,
        workspace: redactText(data.workspace ?? ""),
        provider: data.provider ?? "",
        model: data.model ?? "",
        permission_profile: data.permission_profile ?? "",
      });
    } else if (typ === "task_started") {
      if (this.root === null) this.root = this.newSpan("session", "session", null, seq, { synthetic: true });
      this.task = this.newSpan("task", "task", this.root, seq, {
        task_id: data.task_id ?? "",
        goal: redactText(data.goal ?? ""),
        constraints: (data.constraints as unknown[] | undefined)?.map((item) => redactText(item)) ?? [],
      });
    } else if (typ === "turn_started") {
      this.turn = this.newSpan("turn", "turn", this.task ?? this.root, seq, {
        turn: data.turn ?? 0,
        estimated_input: data.estimated_input ?? 0,
      });
    } else if (typ === "turn_finished") {
      if (this.turn !== null) {
        const stop = String(data.stop ?? "");
        this.turn.close(seq, statusForTurn(stop), { tools: data.tools ?? 0, stop: stop || "continued" });
        this.turn = null;
      }
    } else if (typ === "tool_intent") {
      if (delegationId !== "" && this.root_parent_id === null && !this.subagents.has(delegationId)) {
        this.subagents.set(
          delegationId,
          this.newSpan(`subagent.${delegationId}`, "subagent", this.parent(), seq, { delegation_id: delegationId }),
        );
      }
      const parent = this.subagents.get(delegationId) ?? this.parent();
      const tool = String(data.tool ?? "tool");
      const span = this.newSpan(`tool.${tool}`, "tool", parent, seq, {
        call_id: data.call_id ?? "",
        tool,
        args: redactArgs(tool, (data.args as Record<string, unknown> | undefined) ?? {}),
        idempotency_key: data.idempotency_key ?? "",
        session_id: this.session_id,
      });
      this.tools.set(String(data.call_id ?? ""), span);
    } else if (typ === "tool_committed") {
      const span = this.tools.get(String(data.call_id ?? ""));
      if (span !== undefined) {
        this.tools.delete(String(data.call_id ?? ""));
        span.close(seq, "ok", { summary: redactText(data.summary ?? "") });
      }
    } else if (typ === "tool_failed") {
      const span = this.tools.get(String(data.call_id ?? ""));
      if (span !== undefined) {
        this.tools.delete(String(data.call_id ?? ""));
        span.close(seq, "error", { error: redactText(data.error ?? "") });
      }
    } else if (typ === "tool_blocked") {
      const span = this.newSpan(`tool.${data.tool ?? "tool"}`, "tool", this.parent(), seq, {
        call_id: data.call_id ?? "",
        tool: data.tool ?? "",
        blocked: true,
      });
      span.close(seq, "blocked", { reason: redactText(data.reason ?? "") });
    } else if (typ === "permission_requested") {
      const actionId = String(data.action_id ?? "");
      const span = this.newSpan(
        `approval.${data.tool ?? "tool"}`,
        "approval",
        lastTool(this.tools) ?? this.parent(),
        seq,
        {
          action_id: actionId,
          tool: data.tool ?? "",
          target: redactText(data.target ?? ""),
          risk: data.risk ?? "",
        },
      );
      this.approvals.set(actionId, span);
    } else if (typ === "permission_decided") {
      const actionId = String(data.action_id ?? "");
      let span = this.approvals.get(actionId);
      if (span !== undefined) this.approvals.delete(actionId);
      if (span === undefined) {
        span = this.newSpan(`approval.${data.tool ?? "tool"}`, "approval", lastTool(this.tools) ?? this.parent(), seq, {
          action_id: actionId,
          tool: data.tool ?? "",
          risk: data.risk ?? "",
        });
      }
      const kind = String(data.kind ?? "allow");
      span.close(seq, kind === "deny" ? "denied" : "ok", { decision: kind, rule: data.rule ?? "" });
    } else if (typ === "context_compacted") {
      const span = this.newSpan("compaction", "compaction", this.parent(), seq, {
        before_tokens: data.before_tokens ?? 0,
        after_tokens: data.after_tokens ?? 0,
        kept_recent: data.kept_recent ?? 0,
      });
      span.close(seq, data.degraded === true ? "degraded" : "ok");
    } else if (typ === "hook_finished") {
      this.point("hook_finished", seq, data);
    } else if (typ === "command_invoked") {
      this.point("command_invoked", seq, data);
    } else if (typ === "skill_loaded") {
      this.point("skill_loaded", seq, data);
    } else if (typ === "sandbox_created") {
      this.sandbox = this.newSpan("sandbox", "sandbox", this.root, seq, {
        sandbox_id: data.sandbox_id ?? "",
        backend: data.backend ?? "",
      });
    } else if (typ === "sandbox_destroyed") {
      if (this.sandbox !== null) {
        this.sandbox.close(seq, "ok", { runs: data.runs ?? 0 });
        this.sandbox = null;
      }
    } else if (typ === "command_started") {
      const parent = lastTool(this.tools) ?? this.sandbox ?? this.parent();
      const argv = ((data.argv as unknown[] | undefined) ?? []).map((item) => redactText(item));
      const span = this.newSpan("command", "command", parent, seq, {
        argv,
        executable: argv.length > 0 ? String(argv[0]) : "shell",
        cwd: redactText(data.cwd ?? ""),
        sandbox_id: data.sandbox_id ?? "",
      });
      this.commands.push(span);
    } else if (typ === "command_finished") {
      if (this.commands.length > 0) {
        const span = this.commands.pop() as Span;
        const ok = data.exit_code === 0 && data.timed_out !== true;
        span.close(seq, ok ? "ok" : "error", {
          exit_code: data.exit_code ?? null,
          timed_out: data.timed_out === true,
          duration_ms: data.duration_ms ?? 0,
          stdout_chars: data.stdout_chars ?? 0,
          stderr_chars: data.stderr_chars ?? 0,
        });
      }
    } else if (typ === "subagent_dispatched") {
      const delegation = String(data.delegation_id ?? delegationId);
      const span = this.newSpan(
        `subagent.${data.role ?? delegation}`,
        "subagent",
        this.parent(),
        seq,
        {
          delegation_id: delegation,
          role: data.role ?? "",
          tools: data.tools ?? [],
        },
      );
      this.subagents.set(delegation, span);
    } else if (typ === "subagent_returned") {
      const delegation = String(data.delegation_id ?? delegationId);
      const span = this.subagents.get(delegation);
      if (span !== undefined) {
        this.subagents.delete(delegation);
        const status = String(data.status ?? "completed");
        const mapped = status === "completed" ? "ok" : status === "invalid_artifact" ? "error" : status;
        span.close(seq, mapped, { result_status: status, ok: data.ok === true });
      }
    } else if (typ === "state_changed") {
      this.point("state_changed", seq, data);
    } else if (typ === "loop_stopped") {
      this.point("loop_stopped", seq, data);
    } else if (typ === "checkpoint") {
      this.point("checkpoint", seq, data);
    } else if (typ === "session_ended") {
      const reason = String(data.reason ?? "");
      this.point("session_ended", seq, data);
      if (this.turn !== null) {
        this.turn.close(seq, "incomplete");
        this.turn = null;
      }
      if (this.task !== null) {
        this.task.close(seq, statusForSession(reason), { turns: data.turns ?? 0 });
      }
      if (this.root !== null) {
        this.root.close(seq, statusForSession(reason), {
          reason,
          turns: data.turns ?? 0,
          tool_calls: data.tool_calls ?? 0,
        });
      }
    } else {
      this.point(typ, seq, data);
    }
  }

  finish(): Trace {
    const seq = Math.max(this.last_seq, 1);
    for (const span of this.spans) {
      if (span.end_seq === 0) span.close(seq, "incomplete");
    }
    if (this.root === null && this.create_session_span) {
      this.root = this.newSpan("session", "session", null, seq, { synthetic: true });
    }
    const rootId = this.root !== null ? this.root.span_id : this.root_parent_id ?? "";
    return new Trace(this.trace_id, this.session_id, rootId, this.spans);
  }
}

export function buildTrace(events: StoredEvent[], options: { session_id?: string; trace_id?: string } = {}): Trace {
  const builder = new TraceBuilder(options.trace_id, { session_id: options.session_id ?? "" });
  builder.feed(events);
  return builder.finish();
}

export function mergeChild(trace: Trace, delegationId: string, events: StoredEvent[], role = "worker"): number {
  let parent = trace.spans.find(
    (span) => span.kind === "subagent" && span.attributes.delegation_id === delegationId,
  );
  const base = Math.max(...trace.spans.map((span) => Math.max(span.start_seq, span.end_seq)));
  if (parent === undefined) {
    const task = trace.spans.find((span) => span.kind === "task") ?? trace.span(trace.root_span_id);
    parent = new Span(
      trace.trace_id,
      spanId(trace.trace_id, "merge", base, "subagent", trace.spans.length),
      task !== undefined ? task.span_id : null,
      `subagent.${role}`,
      "subagent",
      "merge",
      base,
      { delegation_id: delegationId, role, synthetic: true },
    );
    trace.spans.push(parent);
  }
  const shifted = events.map((event) => ({ ...event, seq: base + Number(event.seq ?? 0) }));
  const builder = new TraceBuilder(trace.trace_id, {
    session_id: `${trace.session_id}--${delegationId}`,
    root_parent_id: parent.span_id,
    create_session_span: false,
  });
  builder.feed(shifted);
  const child = builder.finish();
  trace.spans.push(...child.spans);
  const end = Math.max(parent.end_seq, ...child.spans.map((span) => span.end_seq));
  parent.close(end, "ok");
  return child.spans.length;
}

function insideSubagent(span: Span, byId: Map<string, Span>): boolean {
  let current: Span | undefined = span;
  while (current !== undefined && current.parent_span_id !== null) {
    current = byId.get(current.parent_span_id);
    if (current !== undefined && current.kind === "subagent") return true;
  }
  return false;
}

export function summarize(trace: Trace, inputTokens = 0, outputTokens = 0): TraceSummary {
  const byId = new Map(trace.spans.map((span) => [span.span_id, span]));
  const main = trace.spans.filter((span) => !insideSubagent(span, byId));
  const tools = main.filter((span) => span.kind === "tool");
  const approvals = main.filter((span) => span.kind === "approval");
  const root = trace.span(trace.root_span_id);
  const summary = new TraceSummary();
  summary.turns = main.filter((span) => span.kind === "turn").length;
  summary.tool_attempts = tools.length;
  summary.tool_ok = tools.filter((span) => span.status === "ok").length;
  summary.tool_failed = tools.filter((span) => span.status === "error").length;
  summary.tool_blocked = tools.filter((span) => span.status === "blocked").length;
  summary.approvals = approvals.length;
  summary.approval_wait = approvals.filter((span) => span.end_seq > span.start_seq).length;
  summary.compactions = main.filter((span) => span.kind === "compaction").length;
  summary.subagents = trace.spans.filter((span) => span.kind === "subagent").length;
  summary.reason = root !== undefined ? String(root.attributes.reason ?? "") : "";
  summary.input_tokens = inputTokens;
  summary.output_tokens = outputTokens;
  return summary;
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

export function renderTree(trace: Trace): string[] {
  const depths = new Map<string, number>([[trace.root_span_id, 0]]);
  for (const span of trace.spans) {
    if (!depths.has(span.span_id)) {
      const parentDepth = span.parent_span_id !== null ? depths.get(span.parent_span_id) ?? 0 : 0;
      depths.set(span.span_id, span.parent_span_id !== null ? parentDepth + 1 : 0);
    }
  }
  return trace.spans.map((span) => {
    const indent = "  ".repeat(depths.get(span.span_id) ?? 0);
    return `${indent}${padRight(span.name, 24)} ${padRight(span.status, 10)} seq=${span.start_seq}..${span.end_seq}`;
  });
}

export function replay(trace: Trace, limit = 20): string[] {
  const rows: Array<[number, number, string]> = [];
  trace.spans.forEach((span, index) => {
    rows.push([span.start_seq, index, `${span.name} start status=${span.status}`]);
    if (span.end_seq) rows.push([span.end_seq, index + 1000, `${span.name} end status=${span.status}`]);
    for (const item of span.events) {
      rows.push([item.seq, index + 2000, `${span.name} event=${item.name}`]);
    }
  });
  rows.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  return rows.slice(0, limit).map(([seq, , text]) => `${String(seq).padStart(3)} ${text}`);
}
