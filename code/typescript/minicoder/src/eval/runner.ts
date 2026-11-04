import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ContextBudget } from "../context.ts";
import { ApprovalResult } from "../permissions.ts";
import type { ApprovalRequest, Approver } from "../permissions.ts";
import { ScriptedProvider, response } from "../provider.ts";
import { HarnessConfig, MiniCoder, makeDemoHooks } from "../runtime.ts";
import type { LoopResult } from "../runtime.ts";
import { buildTrace, summarize } from "../trace.ts";
import type { StoredEvent, Trace, TraceSummary } from "../trace.ts";
import type { ToolCall } from "../types.ts";
import { resolveRefs } from "./dataset.ts";
import type { CheckResult, EvalResult, EvalTask } from "./types.ts";

const CHECK_ORDER = [
  "reason",
  "files",
  "files_unchanged",
  "tools_ok",
  "tools_failed",
  "tools_blocked",
  "compactions_min",
  "answer_contains",
  "required_tools",
  "trace_no_secret",
  "trace_has_mask",
] as const;

export class EvalApprover implements Approver {
  allowWrite: Set<string>;

  constructor(allowWrite: string[]) {
    this.allowWrite = new Set(allowWrite);
  }

  approve(request: ApprovalRequest): ApprovalResult {
    const action = request.action;
    if (
      (action.tool === "write_file" || action.tool === "edit_file") &&
      this.allowWrite.has(action.target)
    ) {
      return new ApprovalResult("allow_once", "eval: 允许写入预设路径");
    }
    if (action.tool === "run_command" && (action.argv[0] === "python3" || action.argv[0] === "python")) {
      return new ApprovalResult("allow_session", "eval: 本会话允许运行 Python");
    }
    return new ApprovalResult("deny", "eval: 其余动作拒绝");
  }
}

export function readEvents(file: string): StoredEvent[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as StoredEvent);
}

function traceText(trace: Trace): string {
  return JSON.stringify(
    trace.spans.map((span) => ({
      name: span.name,
      attributes: span.attributes,
      events: span.events,
    })),
  );
}

function toolNames(events: StoredEvent[]): Set<string> {
  const names = new Set<string>();
  for (const event of events) {
    if (["tool_intent", "tool_committed", "tool_failed", "tool_blocked"].includes(event.type)) {
      const name = event.data.tool;
      if (name !== undefined) names.add(String(name));
    }
  }
  return names;
}

function fileText(workspace: string, relative: string): string | null {
  const full = path.join(workspace, relative);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
}

export function evaluateChecks(
  task: EvalTask,
  result: LoopResult,
  summary: TraceSummary,
  events: StoredEvent[],
  trace: Trace,
  baseline: Map<string, string>,
  workspace: string,
): CheckResult[] {
  const checks: CheckResult[] = [];
  const spec = task.checks;

  for (const name of CHECK_ORDER) {
    if (!Object.prototype.hasOwnProperty.call(spec, name)) continue;
    const expected = spec[name];

    if (name === "reason") {
      const actual = result.reason;
      checks.push({ name, ok: actual === String(expected), detail: actual });
    } else if (name === "files") {
      let ok = true;
      const details: string[] = [];
      for (const [relative, needles] of Object.entries(expected as Record<string, string[]>)) {
        const text = fileText(workspace, relative);
        if (text === null) {
          ok = false;
          details.push(`${relative}=missing`);
          continue;
        }
        const missing = needles.filter((needle) => !text.includes(needle));
        if (missing.length > 0) {
          ok = false;
          details.push(`${relative} missing: ${missing.join(",")}`);
        } else {
          details.push(`${relative}=ok`);
        }
      }
      checks.push({ name, ok, detail: details.join("; ") });
    } else if (name === "files_unchanged") {
      let ok = true;
      const details: string[] = [];
      for (const relative of expected as string[]) {
        const text = fileText(workspace, relative);
        const unchanged = text !== null && text === baseline.get(relative);
        ok = ok && unchanged;
        details.push(`${relative}=${unchanged ? "unchanged" : "changed"}`);
      }
      checks.push({ name, ok, detail: details.join("; ") });
    } else if (name === "tools_ok" || name === "tools_failed" || name === "tools_blocked") {
      const attribute = name === "tools_ok" ? summary.tool_ok : name === "tools_failed" ? summary.tool_failed : summary.tool_blocked;
      const target = Number(expected);
      checks.push({ name, ok: attribute === target, detail: `expected=${target} actual=${attribute}` });
    } else if (name === "compactions_min") {
      const target = Number(expected);
      checks.push({
        name,
        ok: summary.compactions >= target,
        detail: `expected>=${target} actual=${summary.compactions}`,
      });
    } else if (name === "answer_contains") {
      const found = result.answer.includes(String(expected));
      checks.push({ name, ok: found, detail: found ? "found" : "not_found" });
    } else if (name === "required_tools") {
      const used = toolNames(events);
      const missing = (expected as string[]).filter((tool) => !used.has(tool));
      const detail = missing.length > 0 ? `missing: ${missing.join(",")}` : (expected as string[]).join(",");
      checks.push({ name, ok: missing.length === 0, detail });
    } else if (name === "trace_no_secret") {
      const leaked = traceText(trace).includes("sk-live-123");
      const ok = !leaked === Boolean(expected);
      checks.push({ name, ok, detail: leaked ? "leaked" : "clean" });
    } else if (name === "trace_has_mask") {
      const masked = traceText(trace).includes("sk-***");
      const ok = masked === Boolean(expected);
      checks.push({ name, ok, detail: masked ? "masked" : "missing" });
    }
  }

  return checks;
}

function walkFiles(directory: string, base = directory): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(full, base));
    } else {
      files.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return files;
}

function makeBudget(data: Record<string, unknown>): ContextBudget {
  return new ContextBudget(
    Number(data.window ?? 4000),
    Number(data.output_reserve ?? 700),
    Number(data.safety_margin ?? 120),
    Number(data.tool_result_cap ?? 500),
    Number(data.compact_at ?? 0.85),
  );
}

export async function runTask(task: EvalTask, fixturesRoot: string): Promise<EvalResult> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `minicoder-eval-${task.id}-`));
  const host = path.join(root, "workspace");
  fs.cpSync(path.join(fixturesRoot, task.fixture), host, { recursive: true });
  const baseline = new Map(
    walkFiles(host).map((relative) => [relative, fs.readFileSync(path.join(host, relative), "utf8")]),
  );

  const responses = task.script.map((turn) => {
    const calls = turn.calls as Array<Record<string, unknown>> | undefined;
    if (calls !== undefined) {
      const mapped: ToolCall[] = calls.map((call) => ({
        id: String(call.id),
        name: String(call.name),
        args: resolveRefs(call.args ?? {}, fixturesRoot) as Record<string, unknown>,
      }));
      return response("", mapped);
    }
    return response(String(turn.text ?? ""));
  });

  const coder = new MiniCoder(
    new HarnessConfig({
      workspace: host,
      session_id: `eval-${task.id}`,
      budget: makeBudget(task.budget),
      keep_sandbox_workspace: false,
    }),
    new ScriptedProvider(responses),
    { approver: new EvalApprover(task.allow_write), hooks: makeDemoHooks() },
  );

  const result = await coder.run(task.goal, task.constraints);
  const events = readEvents(coder.store.events_path);
  const trace = buildTrace(events, { session_id: `eval-${task.id}` });
  const summary = summarize(trace, result.usage.input_tokens, result.usage.output_tokens);
  const checks = evaluateChecks(task, result, summary, events, trace, baseline, coder.ws.root);
  const record: EvalResult = {
    task_id: task.id,
    passed: checks.every((check) => check.ok),
    checks,
    reason: result.reason,
    turns: result.turns,
    tools_ok: summary.tool_ok,
    tools_failed: summary.tool_failed,
    tools_blocked: summary.tool_blocked,
    compactions: summary.compactions,
    input_tokens: result.usage.input_tokens,
    output_tokens: result.usage.output_tokens,
    answer: result.answer,
  };
  coder.close();
  fs.rmSync(root, { recursive: true, force: true });
  return record;
}

export async function runSuite(tasks: EvalTask[], fixturesRoot: string): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const task of tasks) {
    results.push(await runTask(task, fixturesRoot));
  }
  return results;
}
