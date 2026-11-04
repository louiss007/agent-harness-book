// 第 18 章：长时运行任务的持久化执行层。
// 只做加法：不修改 runtime、session、provider 的既有接口。

import fs from "node:fs";
import path from "node:path";

import { canonicalJson } from "./util.ts";

export const StepStatus = {
  PENDING: "pending",
  RUNNING: "running",
  COMMITTED: "committed",
  FAILED: "failed",
} as const;

export type StepStatusValue = (typeof StepStatus)[keyof typeof StepStatus];

export class DurableStep {
  step_id: string;
  title: string;
  milestone: string;
  status: string;
  attempts: number;
  epoch: number;
  evidence: string;
  note: string;

  constructor(
    stepId: string,
    title: string,
    milestone: string,
    status: string = StepStatus.PENDING,
    attempts = 0,
    epoch = 1,
    evidence = "",
    note = "",
  ) {
    this.step_id = stepId;
    this.title = title;
    this.milestone = milestone;
    this.status = status;
    this.attempts = attempts;
    this.epoch = epoch;
    this.evidence = evidence;
    this.note = note;
  }

  clone(): DurableStep {
    return new DurableStep(
      this.step_id,
      this.title,
      this.milestone,
      this.status,
      this.attempts,
      this.epoch,
      this.evidence,
      this.note,
    );
  }
}

export interface JournalEntry {
  seq: number;
  epoch: number;
  event: string;
  step_id: string;
  data: Record<string, unknown>;
}

export class TaskJournal {
  path: string;
  entries: JournalEntry[];
  seq: number;

  constructor(filePath: string) {
    this.path = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.entries = [];
    this.seq = 0;
    if (fs.existsSync(filePath)) {
      const text = fs.readFileSync(filePath, "utf8");
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        const raw = JSON.parse(line) as JournalEntry;
        this.entries.push({
          seq: Number(raw.seq),
          epoch: Number(raw.epoch),
          event: String(raw.event),
          step_id: String(raw.step_id),
          data: raw.data as Record<string, unknown>,
        });
        this.seq = Number(raw.seq);
      }
    }
  }

  append(
    event: string,
    epoch: number,
    stepId: string,
    data: Record<string, unknown>,
  ): JournalEntry {
    this.seq += 1;
    const entry: JournalEntry = {
      seq: this.seq,
      epoch,
      event,
      step_id: stepId,
      data,
    };
    const line = canonicalJson({
      seq: entry.seq,
      epoch: entry.epoch,
      event: entry.event,
      step_id: entry.step_id,
      data: entry.data,
    });
    const fd = fs.openSync(this.path, "a");
    try {
      fs.writeSync(fd, `${line}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.entries.push(entry);
    return entry;
  }
}

export class ProgressLedger {
  task_id: string;
  goal: string;
  steps: Map<string, DurableStep>;
  epoch: number;
  verified: string[];
  suspended: string;
  completed: boolean;

  constructor(
    taskId: string,
    goal: string,
    steps: Map<string, DurableStep>,
    epoch = 1,
    verified: string[] = [],
    suspended = "",
    completed = false,
  ) {
    this.task_id = taskId;
    this.goal = goal;
    this.steps = steps;
    this.epoch = epoch;
    this.verified = verified;
    this.suspended = suspended;
    this.completed = completed;
  }

  static fromJournal(
    taskId: string,
    goal: string,
    steps: Iterable<DurableStep>,
    journal: TaskJournal,
  ): ProgressLedger {
    const map = new Map<string, DurableStep>();
    for (const step of steps) map.set(step.step_id, step.clone());
    const ledger = new ProgressLedger(taskId, goal, map);
    for (const entry of journal.entries) ledger.apply(entry);
    return ledger;
  }

  apply(entry: JournalEntry): void {
    const step = entry.step_id === "" ? undefined : this.steps.get(entry.step_id);
    if (entry.event === "epoch_started") {
      this.epoch = entry.epoch;
    } else if (entry.event === "step_intent" && step !== undefined) {
      step.status = StepStatus.RUNNING;
      step.attempts = Number(entry.data.attempt);
      step.epoch = entry.epoch;
    } else if (entry.event === "step_committed" && step !== undefined) {
      step.status = StepStatus.COMMITTED;
      step.evidence = String(entry.data.evidence ?? "");
    } else if (entry.event === "step_failed" && step !== undefined) {
      step.status = StepStatus.FAILED;
      step.attempts = Number(entry.data.attempt ?? step.attempts);
      step.note = String(entry.data.error ?? "");
    } else if (entry.event === "milestone_verified") {
      const milestone = String(entry.data.milestone ?? "");
      if (milestone !== "" && !this.verified.includes(milestone)) {
        this.verified.push(milestone);
      }
    } else if (entry.event === "task_suspended") {
      this.suspended = String(entry.data.reason ?? "");
    } else if (entry.event === "task_completed") {
      this.completed = true;
    }
  }

  nextStep(): DurableStep | null {
    for (const step of this.steps.values()) {
      if (step.status !== StepStatus.COMMITTED) return step;
    }
    return null;
  }

  done(): number {
    let count = 0;
    for (const step of this.steps.values()) {
      if (step.status === StepStatus.COMMITTED) count += 1;
    }
    return count;
  }

  digest(maxSteps = 8): string[] {
    const lines = [
      `task ${this.task_id} epoch=${this.epoch} done=${this.done()}/${this.steps.size}`,
    ];
    let index = 0;
    for (const step of this.steps.values()) {
      if (index >= maxSteps) break;
      lines.push(`${step.status.padEnd(9)} ${step.step_id} ${step.title}`);
      index += 1;
    }
    return lines;
  }
}

export class EffectStore {
  path: string;
  data: Record<string, string>;
  applied_count: number;
  suppressed_count: number;

  constructor(filePath: string) {
    this.path = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.data = {};
    this.applied_count = 0;
    this.suppressed_count = 0;
    if (fs.existsSync(filePath)) {
      this.data = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, string>;
    }
  }

  applyOnce(key: string, value: string): [string, boolean] {
    if (key in this.data) {
      this.suppressed_count += 1;
      return [this.data[key], false];
    }
    this.data[key] = value;
    this.applied_count += 1;
    const tmp = `${this.path}.tmp`;
    fs.writeFileSync(tmp, canonicalJson(this.data), "utf8");
    fs.renameSync(tmp, this.path);
    return [value, true];
  }
}

export interface EpochPlan {
  epoch: number;
  token_allowance: number;
  reserve_tokens: number;
  cost_allowance_micros: number;
  reserve_micros: number;
}

export function epochPlan(options: {
  epoch: number;
  token_allowance: number;
  reserve_tokens?: number;
  cost_allowance_micros?: number;
  reserve_micros?: number;
}): EpochPlan {
  return {
    epoch: options.epoch,
    token_allowance: options.token_allowance,
    reserve_tokens: options.reserve_tokens ?? 0,
    cost_allowance_micros: options.cost_allowance_micros ?? 0,
    reserve_micros: options.reserve_micros ?? 0,
  };
}

export class EpochPacer {
  plan: EpochPlan;
  usage: { tokens: number; cost_micros: number };

  constructor(plan: EpochPlan) {
    this.plan = plan;
    this.usage = { tokens: 0, cost_micros: 0 };
  }

  canStart(projectedTokens: number, projectedMicros = 0): [boolean, string] {
    const available = this.plan.token_allowance - this.plan.reserve_tokens;
    if (this.usage.tokens + projectedTokens > available) {
      return [false, "epoch_budget"];
    }
    if (this.plan.cost_allowance_micros !== 0) {
      const remaining =
        this.plan.cost_allowance_micros - this.plan.reserve_micros;
      if (this.usage.cost_micros + projectedMicros > remaining) {
        return [false, "cost_budget"];
      }
    }
    return [true, "ok"];
  }

  charge(tokens: number, costMicros = 0): void {
    this.usage.tokens += Math.max(0, tokens);
    this.usage.cost_micros += Math.max(0, costMicros);
  }

  pacing(done: number, total: number, marginPermille = 150): string {
    const allowance = Math.max(1, this.plan.token_allowance);
    const spentPermille = Math.floor((this.usage.tokens * 1000) / allowance);
    const progressPermille = Math.floor((done * 1000) / Math.max(1, total));
    return spentPermille > progressPermille + marginPermille ? "pacing" : "ok";
  }

  line(done: number, total: number): string {
    return (
      `epoch=${this.plan.epoch} spent=${this.usage.tokens}/` +
      `${this.plan.token_allowance} reserve=${this.plan.reserve_tokens} ` +
      `pacing=${this.pacing(done, total)}`
    );
  }
}

export interface VerificationResult {
  milestone: string;
  command: string;
  ok: boolean;
  output_hash: string;
}

export function verificationResult(
  milestone: string,
  command: string,
  ok: boolean,
  outputHash = "",
): VerificationResult {
  return {
    milestone,
    command,
    ok,
    output_hash: outputHash,
  };
}

export class VerificationGate {
  required: string[];
  results: VerificationResult[];

  constructor(milestones: Iterable<string>) {
    this.required = [...milestones];
    this.results = [];
  }

  verify(result: VerificationResult): [boolean, string] {
    if (!this.required.includes(result.milestone)) {
      return [false, "unknown_milestone"];
    }
    if (result.command === "") return [false, "no_command"];
    this.results.push(result);
    if (!result.ok) return [false, "nonzero_exit"];
    return [true, "passed"];
  }
}

export class HandoffPackage {
  task_id: string;
  epoch: number;
  reason: string;
  goal: string;
  done: string[];
  blocked: string[];
  options: string[];
  budget: string;
  changed_files: string[];
  next_step: string;

  constructor(
    taskId: string,
    epoch: number,
    reason: string,
    goal: string,
    done: string[],
    blocked: string[],
    options: string[],
    budget: string,
    changedFiles: string[],
    nextStep: string,
  ) {
    this.task_id = taskId;
    this.epoch = epoch;
    this.reason = reason;
    this.goal = goal;
    this.done = done;
    this.blocked = blocked;
    this.options = options;
    this.budget = budget;
    this.changed_files = changedFiles;
    this.next_step = nextStep;
  }

  render(): string[] {
    const lines = [
      `task=${this.task_id} epoch=${this.epoch} reason=${this.reason}`,
      `done=${this.done.length} blocked=${this.blocked.length} budget=${this.budget}`,
    ];
    for (const item of this.done) lines.push(`  done    ${item}`);
    for (const item of this.blocked) lines.push(`  blocked ${item}`);
    lines.push(`next=${this.next_step}`);
    lines.push(`files=${this.changed_files.join(",")}`);
    lines.push(`options=${this.options.join(",")}`);
    return lines;
  }
}

export function buildHandoff(
  ledger: ProgressLedger,
  options: {
    reason: string;
    options: string[];
    budget: string;
    changed_files: string[];
    next_step: string;
  },
): HandoffPackage {
  const done: string[] = [];
  const blocked: string[] = [];
  for (const step of ledger.steps.values()) {
    if (step.status === StepStatus.COMMITTED) done.push(`${step.step_id} ${step.title}`);
    if (step.status === StepStatus.FAILED || step.status === StepStatus.RUNNING) {
      blocked.push(`${step.step_id} ${step.title}`);
    }
  }
  return new HandoffPackage(
    ledger.task_id,
    ledger.epoch,
    options.reason,
    ledger.goal,
    done,
    blocked,
    options.options,
    options.budget,
    options.changed_files,
    options.next_step,
  );
}

export interface TaskLease {
  task_id: string;
  owner: string;
  epoch: number;
  fencing: number;
  expires_at_ms: number;
}

export interface Heartbeat {
  owner: string;
  fencing: number;
  seq: number;
  at_ms: number;
  status: string;
}

export class TaskLeaseManager {
  lease_ms: number;
  heartbeat_ms: number;
  suspect_after: number;
  leases: Map<string, TaskLease>;
  tokens: Map<string, number>;
  heartbeats: Map<string, Heartbeat>;

  constructor(leaseMs = 30_000, heartbeatMs = 10_000, suspectAfter = 3) {
    this.lease_ms = leaseMs;
    this.heartbeat_ms = heartbeatMs;
    this.suspect_after = suspectAfter;
    this.leases = new Map();
    this.tokens = new Map();
    this.heartbeats = new Map();
  }

  acquire(taskId: string, owner: string, epoch: number, nowMs: number): TaskLease | null {
    const current = this.leases.get(taskId);
    if (current !== undefined && current.expires_at_ms > nowMs) {
      return current.owner === owner ? current : null;
    }
    const fencing = (this.tokens.get(taskId) ?? 0) + 1;
    this.tokens.set(taskId, fencing);
    const lease: TaskLease = {
      task_id: taskId,
      owner,
      epoch,
      fencing,
      expires_at_ms: nowMs + this.lease_ms,
    };
    this.leases.set(taskId, lease);
    return lease;
  }

  heartbeat(lease: TaskLease, seq: number, nowMs: number): Heartbeat {
    const current = this.leases.get(lease.task_id);
    let result: Heartbeat;
    if (
      current === undefined ||
      current.fencing !== lease.fencing ||
      current.expires_at_ms <= nowMs
    ) {
      result = {
        owner: lease.owner,
        fencing: lease.fencing,
        seq,
        at_ms: nowMs,
        status: "stale",
      };
    } else {
      current.expires_at_ms = nowMs + this.lease_ms;
      result = {
        owner: lease.owner,
        fencing: lease.fencing,
        seq,
        at_ms: nowMs,
        status: "ok",
      };
    }
    this.heartbeats.set(lease.task_id, result);
    return result;
  }

  takeover(taskId: string, owner: string, epoch: number, nowMs: number): TaskLease | null {
    const current = this.leases.get(taskId);
    if (current !== undefined && current.expires_at_ms > nowMs) return null;
    return this.acquire(taskId, owner, epoch, nowMs);
  }

  checkWrite(lease: TaskLease, nowMs: number): [boolean, string] {
    const current = this.leases.get(lease.task_id);
    if (current === undefined) return [false, "no_lease"];
    if (current.fencing !== lease.fencing) return [false, "fencing"];
    if (current.expires_at_ms <= nowMs) return [false, "expired"];
    return [true, "ok"];
  }
}

export class InjectedCrash extends Error {}

export interface StepContext {
  task_id: string;
  step: DurableStep;
  attempt: number;
  epoch: number;
  effects: EffectStore;
}

export interface StepOutcome {
  ok: boolean;
  evidence: string;
  detail: string;
  tokens: number;
  cost_micros: number;
  verified: boolean;
}

export function stepOutcome(options: {
  ok: boolean;
  evidence?: string;
  detail?: string;
  tokens?: number;
  cost_micros?: number;
  verified?: boolean;
}): StepOutcome {
  return {
    ok: options.ok,
    evidence: options.evidence ?? "",
    detail: options.detail ?? "",
    tokens: options.tokens ?? 0,
    cost_micros: options.cost_micros ?? 0,
    verified: options.verified ?? false,
  };
}

export type StepHandler = (ctx: StepContext) => StepOutcome;
export type EventSink = (entry: JournalEntry) => void;

export interface RunReport {
  epoch: number;
  committed: number;
  replayed: number;
  skipped: number;
  suspended: string;
  completed: boolean;
  spent_tokens: number;
  pacing: string;
}

export class DurableRunner {
  task_id: string;
  goal: string;
  steps: DurableStep[];
  journal: TaskJournal;
  effects: EffectStore;
  max_attempts: number;
  on_event: EventSink | null;
  ledger: ProgressLedger;
  pacer: EpochPacer | null;

  constructor(
    taskId: string,
    goal: string,
    steps: Iterable<DurableStep>,
    journal: TaskJournal,
    effects: EffectStore,
    options: { max_attempts?: number; on_event?: EventSink } = {},
  ) {
    this.task_id = taskId;
    this.goal = goal;
    this.steps = [...steps].map((step) => step.clone());
    this.journal = journal;
    this.effects = effects;
    this.max_attempts = options.max_attempts ?? 2;
    this.on_event = options.on_event ?? null;
    this.ledger = ProgressLedger.fromJournal(taskId, goal, this.steps, journal);
    this.pacer = null;
    if (journal.seq === 0) {
      this.log("task_started", 1, "", { goal });
    }
  }

  log(event: string, epoch: number, stepId = "", data: Record<string, unknown> = {}): JournalEntry {
    const entry = this.journal.append(event, epoch, stepId, data);
    if (this.on_event !== null) this.on_event(entry);
    this.ledger.apply(entry);
    return entry;
  }

  run(
    handler: StepHandler,
    options: { epoch: number; plan: EpochPlan; projected_tokens?: number },
  ): RunReport {
    const epoch = options.epoch;
    const projectedTokens = options.projected_tokens ?? 120;
    this.pacer = new EpochPacer(options.plan);
    this.log("epoch_started", epoch);

    let skipped = 0;
    let replayed = 0;
    for (const step of this.ledger.steps.values()) {
      if (step.status === StepStatus.COMMITTED) skipped += 1;
      if (step.status === StepStatus.RUNNING) replayed += 1;
    }
    let committed = 0;
    let suspended = "";

    while (true) {
      const step = this.ledger.nextStep();
      if (step === null) break;
      if (step.status === StepStatus.FAILED && step.attempts >= this.max_attempts) {
        suspended = "retry_exhausted";
        this.log("task_suspended", epoch, step.step_id, { reason: suspended });
        break;
      }

      const [allowed, reason] = this.pacer.canStart(projectedTokens);
      if (!allowed) {
        suspended = reason;
        this.log("task_suspended", epoch, step.step_id, { reason });
        break;
      }

      const attempt = step.attempts + 1;
      const key = `${this.task_id}:${step.step_id}`;
      this.log("step_intent", epoch, step.step_id, {
        attempt,
        idempotency_key: key,
      });

      let outcome: StepOutcome;
      try {
        outcome = handler({
          task_id: this.task_id,
          step,
          attempt,
          epoch,
          effects: this.effects,
        });
      } catch (error) {
        if (error instanceof InjectedCrash) {
          this.pacer.charge(projectedTokens, 0);
          this.log("step_crashed", epoch, step.step_id, {
            attempt,
            after_effect: true,
          });
        }
        throw error;
      }

      this.pacer.charge(outcome.tokens, outcome.cost_micros);
      if (outcome.ok) {
        if (outcome.verified) {
          this.log("milestone_verified", epoch, step.step_id, {
            milestone: step.milestone,
            evidence: outcome.evidence,
          });
        }
        this.log("step_committed", epoch, step.step_id, {
          evidence: outcome.evidence,
          tokens: outcome.tokens,
        });
        committed += 1;
      } else {
        this.log("step_failed", epoch, step.step_id, {
          attempt,
          error: outcome.detail !== "" ? outcome.detail : "failed",
        });
      }
    }

    if (this.ledger.nextStep() === null) {
      this.log("task_completed", epoch);
    }

    return {
      epoch,
      committed,
      replayed,
      skipped,
      suspended,
      completed: this.ledger.completed,
      spent_tokens: this.pacer.usage.tokens,
      pacing: this.pacer.pacing(this.ledger.done(), this.ledger.steps.size),
    };
  }
}
