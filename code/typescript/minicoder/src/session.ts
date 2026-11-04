import fs from "node:fs";
import path from "node:path";

import type { ToolCall } from "./types.ts";
import { canonicalJson, sha256Hex } from "./util.ts";

export const SCHEMA_VERSION = 1;

export class SessionState {
  session_id: string;
  workspace: string;
  provider: string;
  model: string;
  permission_profile: string;
  created_at: string;
  budget_used: Record<string, number>;

  constructor(
    session_id: string,
    workspace: string,
    provider: string,
    model: string,
    permission_profile = "ask",
    created_at = "",
    budget_used: Record<string, number> = {},
  ) {
    this.session_id = session_id;
    this.workspace = workspace;
    this.provider = provider;
    this.model = model;
    this.permission_profile = permission_profile;
    this.created_at = created_at;
    this.budget_used = budget_used;
  }

  toJSON(): Record<string, unknown> {
    return {
      session_id: this.session_id,
      workspace: this.workspace,
      provider: this.provider,
      model: this.model,
      permission_profile: this.permission_profile,
      created_at: this.created_at,
      budget_used: this.budget_used,
    };
  }

  static fromJSON(data: Record<string, unknown>): SessionState {
    return new SessionState(
      String(data.session_id),
      String(data.workspace),
      String(data.provider),
      String(data.model),
      String(data.permission_profile ?? "ask"),
      String(data.created_at ?? ""),
      (data.budget_used as Record<string, number> | undefined) ?? {},
    );
  }
}

export class FileRecord {
  path: string;
  sha256: string;
  size: number;
  changed_by: string;

  constructor(path: string, sha256: string, size: number, changed_by: string) {
    this.path = path;
    this.sha256 = sha256;
    this.size = size;
    this.changed_by = changed_by;
  }
}

export class PendingCall {
  call_id: string;
  tool: string;
  args: Record<string, unknown>;
  idempotency_key: string;
  status: string;

  constructor(call_id: string, tool: string, args: Record<string, unknown>, idempotency_key: string, status = "intent") {
    this.call_id = call_id;
    this.tool = tool;
    this.args = args;
    this.idempotency_key = idempotency_key;
    this.status = status;
  }
}

export class TaskState {
  task_id: string;
  goal: string;
  constraints: string[];
  files: Record<string, FileRecord> = {};
  pending: Record<string, PendingCall> = {};
  completed_calls: Record<string, string> = {};
  turns = 0;
  tool_calls = 0;
  last_error = "";
  updated_seq = 0;

  constructor(task_id: string, goal: string, constraints: string[] = []) {
    this.task_id = task_id;
    this.goal = goal;
    this.constraints = constraints;
  }

  toJSON(): Record<string, unknown> {
    const files: Record<string, unknown> = {};
    for (const [rel, record] of Object.entries(this.files)) {
      files[rel] = { path: record.path, sha256: record.sha256, size: record.size, changed_by: record.changed_by };
    }
    const pending: Record<string, unknown> = {};
    for (const [callId, call] of Object.entries(this.pending)) {
      pending[callId] = {
        call_id: call.call_id,
        tool: call.tool,
        args: call.args,
        idempotency_key: call.idempotency_key,
        status: call.status,
      };
    }
    return {
      task_id: this.task_id,
      goal: this.goal,
      constraints: this.constraints,
      files,
      pending,
      completed_calls: this.completed_calls,
      turns: this.turns,
      tool_calls: this.tool_calls,
      last_error: this.last_error,
      updated_seq: this.updated_seq,
    };
  }

  static fromJSON(data: Record<string, unknown>): TaskState {
    const state = new TaskState(String(data.task_id), String(data.goal), ((data.constraints as string[] | undefined) ?? []).slice());
    for (const [rel, raw] of Object.entries((data.files as Record<string, Record<string, unknown>> | undefined) ?? {})) {
      state.files[rel] = new FileRecord(String(raw.path), String(raw.sha256), Number(raw.size), String(raw.changed_by));
    }
    for (const [callId, raw] of Object.entries((data.pending as Record<string, Record<string, unknown>> | undefined) ?? {})) {
      state.pending[callId] = new PendingCall(
        String(raw.call_id),
        String(raw.tool),
        (raw.args as Record<string, unknown>) ?? {},
        String(raw.idempotency_key),
        String(raw.status ?? "intent"),
      );
    }
    state.completed_calls = { ...((data.completed_calls as Record<string, string> | undefined) ?? {}) };
    state.turns = Number(data.turns ?? 0);
    state.tool_calls = Number(data.tool_calls ?? 0);
    state.last_error = String(data.last_error ?? "");
    state.updated_seq = Number(data.updated_seq ?? 0);
    return state;
  }

  recordFile(root: string, rel: string, changed_by: string): void {
    const raw = fs.readFileSync(path.join(root, rel));
    this.files[rel] = new FileRecord(rel, sha256Hex(raw), raw.length, changed_by);
  }

  completeCall(callId: string, summary: string): void {
    delete this.pending[callId];
    this.completed_calls[callId] = summary;
    this.tool_calls += 1;
  }
}

export class Event {
  seq: number;
  type: string;
  ts: string;
  data: Record<string, unknown>;
  schema_version: number;

  constructor(seq: number, type: string, ts: string, data: Record<string, unknown>, schema_version = SCHEMA_VERSION) {
    this.seq = seq;
    this.type = type;
    this.ts = ts;
    this.data = data;
    this.schema_version = schema_version;
  }

  toJSON(): Record<string, unknown> {
    return { seq: this.seq, type: this.type, ts: this.ts, data: this.data, schema_version: this.schema_version };
  }
}

export const AUDIT_EVENTS = new Set([
  "turn_started",
  "loop_stopped",
  "context_compacted",
  "permission_requested",
  "permission_decided",
  "grant_issued",
  "grant_expired",
  "hook_finished",
  "command_invoked",
  "skill_loaded",
  "sandbox_created",
  "command_started",
  "command_finished",
  "tool_blocked",
  "sandbox_destroyed",
  "subagent_dispatched",
  "subagent_returned",
  "session_ended",
]);

export class SessionStore {
  root: string;
  session_id: string;
  dir: string;
  events_path: string;
  snapshot_path: string;
  seq: number;

  constructor(root: string, session_id: string) {
    this.root = fs.realpathSync(path.resolve(root));
    this.session_id = session_id;
    this.dir = path.join(this.root, ".minicoder", "sessions", session_id);
    fs.mkdirSync(this.dir, { recursive: true });
    this.events_path = path.join(this.dir, "events.jsonl");
    this.snapshot_path = path.join(this.dir, "snapshot.json");
    this.seq = this.lastSeq();
  }

  private lastSeq(): number {
    if (!fs.existsSync(this.events_path)) return 0;
    let last = 0;
    for (const line of fs.readFileSync(this.events_path, "utf8").split("\n")) {
      if (line.trim() !== "") last = Number(JSON.parse(line).seq);
    }
    return last;
  }

  append(type: string, data: Record<string, unknown>): Event {
    this.seq += 1;
    const event = new Event(this.seq, type, "2026-11-03T00:00:00Z", data);
    const fd = fs.openSync(this.events_path, "a");
    try {
      fs.writeSync(fd, canonicalJson(event.toJSON()) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return event;
  }

  checkpoint(state: TaskState, session: SessionState, reason: string): Event {
    const event = this.append("checkpoint", { reason });
    state.updated_seq = event.seq;
    const payload = {
      schema_version: SCHEMA_VERSION,
      session_id: this.session_id,
      seq: event.seq,
      session: session.toJSON(),
      state: state.toJSON(),
    };
    const tmp = `${this.snapshot_path}.tmp`;
    fs.writeFileSync(tmp, canonicalJson(payload), "utf8");
    fs.renameSync(tmp, this.snapshot_path);
    return event;
  }

  recover(): RecoveryReport {
    let state: TaskState | null = null;
    let session: SessionState | null = null;
    let snapshotSeq = 0;
    let source = "event_log";
    if (fs.existsSync(this.snapshot_path)) {
      const payload = JSON.parse(fs.readFileSync(this.snapshot_path, "utf8")) as Record<string, unknown>;
      if (payload.schema_version !== SCHEMA_VERSION) throw new Error("快照版本不兼容，需先迁移");
      state = TaskState.fromJSON(payload.state as Record<string, unknown>);
      session = SessionState.fromJSON(payload.session as Record<string, unknown>);
      snapshotSeq = Number(payload.seq);
      source = "snapshot";
    }
    let replayed = 0;
    if (fs.existsSync(this.events_path)) {
      for (const line of fs.readFileSync(this.events_path, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        const event = JSON.parse(line) as Record<string, unknown>;
        if (Number(event.seq) <= snapshotSeq) continue;
        [state, session] = applyEvent(state, session, event);
        replayed += 1;
      }
    }
    if (state === null || session === null) throw new Error("会话缺少 session_started 或 task_started 事件");
    return new RecoveryReport(state, session, source, snapshotSeq, replayed);
  }
}

export class RecoveryReport {
  state: TaskState;
  session: SessionState;
  source: string;
  snapshot_seq: number;
  replayed: number;

  constructor(state: TaskState, session: SessionState, source: string, snapshot_seq: number, replayed: number) {
    this.state = state;
    this.session = session;
    this.source = source;
    this.snapshot_seq = snapshot_seq;
    this.replayed = replayed;
  }
}

export function applyEvent(
  state: TaskState | null,
  session: SessionState | null,
  event: Record<string, unknown>,
): [TaskState | null, SessionState | null] {
  const kind = String(event.type);
  const data = event.data as Record<string, unknown>;
  const seq = Number(event.seq);
  if (kind === "session_started") return [state, SessionState.fromJSON(data)];
  if (kind === "task_started") {
    const next = new TaskState(String(data.task_id), String(data.goal), ((data.constraints as string[] | undefined) ?? []).slice());
    next.updated_seq = seq;
    return [next, session];
  }
  if (state === null) return [state, session];
  if (kind === "state_changed") {
    const change = String(data.kind);
    if (change === "file") {
      state.files[String(data.path)] = new FileRecord(
        String(data.path),
        String(data.sha256),
        Number(data.size),
        String(data.changed_by ?? "tool"),
      );
    } else if (change === "drift") {
      state.last_error = String(data.message);
    }
  } else if (kind === "tool_intent") {
    const callId = String(data.call_id);
    state.pending[callId] = new PendingCall(
      callId,
      String(data.tool),
      (data.args as Record<string, unknown>) ?? {},
      String(data.idempotency_key),
    );
  } else if (kind === "tool_committed") {
    state.completeCall(String(data.call_id), String(data.summary));
  } else if (kind === "tool_failed") {
    delete state.pending[String(data.call_id)];
    state.last_error = String(data.error);
  } else if (kind === "turn_finished") {
    state.turns += 1;
  } else if (kind === "checkpoint") {
    // 快照边界，不改变状态
  } else if (AUDIT_EVENTS.has(kind)) {
    // 审计事件不参与状态重建
  } else {
    state.last_error = `未知事件 ${kind}，状态可能不完整`;
  }
  return [state, session];
}

export function idempotencyKey(sessionId: string, call: ToolCall): string {
  const raw = `${sessionId}|${call.id}|${call.name}|${canonicalJson(call.args)}`;
  return sha256Hex(raw).slice(0, 16);
}

export function detectDrift(state: TaskState, root: string): string[] {
  const drift: string[] = [];
  for (const [rel, record] of Object.entries(state.files)) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) {
      drift.push(`${rel}:deleted`);
      continue;
    }
    if (sha256Hex(fs.readFileSync(file)) !== record.sha256) drift.push(`${rel}:modified`);
  }
  return drift.sort();
}
