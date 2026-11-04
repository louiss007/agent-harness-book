// 第 18 章离线演示：崩溃、恢复、幂等副作用、租约接管与接管包。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DurableRunner,
  DurableStep,
  EffectStore,
  EpochPacer,
  InjectedCrash,
  ProgressLedger,
  StepStatus,
  TaskJournal,
  TaskLeaseManager,
  VerificationGate,
  buildHandoff,
  epochPlan,
  stepOutcome,
  verificationResult,
} from "./durable.ts";
import type { JournalEntry, StepContext, StepOutcome } from "./durable.ts";

function b(value: boolean): string {
  return value ? "true" : "false";
}

function makeSteps(): DurableStep[] {
  return [
    new DurableStep("step-1", "copy schema", "m1"),
    new DurableStep("step-2", "rewrite imports", "m2"),
    new DurableStep("step-3", "run tests", "m3"),
    new DurableStep("step-4", "write report", "m4"),
  ];
}

function main(): void {
  console.log("== MiniCoder durable ==");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minicoder-durable-"));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function run(root: string): void {
  const journal = new TaskJournal(path.join(root, "durable.jsonl"));
  const effects = new EffectStore(path.join(root, "effects.json"));
  const gate = new VerificationGate(["m1", "m2", "m3", "m4"]);
  console.log(`journal  new seq=${journal.seq}`);

  const sink = (entry: JournalEntry): void => {
    if (entry.event === "step_intent") {
      console.log(`step     ${entry.step_id} intent attempt=${entry.data.attempt}`);
    } else if (entry.event === "step_committed") {
      console.log(
        `step     ${entry.step_id} committed evidence=${String(entry.data.evidence ?? "")}`,
      );
    } else if (entry.event === "step_crashed") {
      console.log(`crash    after-effect step=${entry.step_id} commit=missing`);
    }
  };

  const handler = (ctx: StepContext): StepOutcome => {
    const sid = ctx.step.step_id;
    if (sid === "step-1") {
      return stepOutcome({ ok: true, evidence: "cmd:cp exit=0", tokens: 120 });
    }
    if (sid === "step-2") {
      const [, applied] = ctx.effects.applyOnce("migrate-1:step-2:rewrite", "src/app.py");
      if (ctx.attempt === 1) {
        console.log(`effect   applied=${b(applied)} step=${sid} key=rewrite`);
        throw new InjectedCrash("crash after effect");
      }
      console.log(`step     ${sid} replay applied=${b(applied)}`);
      return stepOutcome({
        ok: true,
        evidence: `effect:rewrite applied=${b(applied)}`,
        tokens: 180,
      });
    }
    if (sid === "step-3") {
      const [ok, reason] = gate.verify(verificationResult("m3", "pytest", true, "h-3"));
      console.log(`verify   m3 command=pytest exit=0 -> ${reason}`);
      return stepOutcome({
        ok,
        evidence: ok ? "pytest:exit=0" : reason,
        tokens: 90,
        verified: ok,
      });
    }
    if (sid === "step-4") {
      return stepOutcome({ ok: true, evidence: "artifact:report", tokens: 60 });
    }
    return stepOutcome({ ok: false, detail: "unknown_step" });
  };

  const runner = new DurableRunner(
    "migrate-1",
    "migrate config to v2",
    makeSteps(),
    journal,
    effects,
    { on_event: sink },
  );
  try {
    runner.run(handler, {
      epoch: 1,
      plan: epochPlan({ epoch: 1, token_allowance: 1000, reserve_tokens: 100 }),
      projected_tokens: 180,
    });
  } catch (error) {
    if (!(error instanceof InjectedCrash)) throw error;
  }
  let running = 0;
  for (const step of runner.ledger.steps.values()) {
    if (step.status === StepStatus.RUNNING) running += 1;
  }
  const spent = runner.pacer === null ? 0 : runner.pacer.usage.tokens;
  console.log(
    `epoch1   committed=${runner.ledger.done()} running=${running} spent=${spent}/1000`,
  );

  const journal2 = new TaskJournal(journal.path);
  const effects2 = new EffectStore(effects.path);
  const runner2 = new DurableRunner(
    "migrate-1",
    "migrate config to v2",
    makeSteps(),
    journal2,
    effects2,
    { on_event: sink },
  );
  let replay = 0;
  for (const step of runner2.ledger.steps.values()) {
    if (step.status === StepStatus.RUNNING) replay += 1;
  }
  console.log(
    `resume   journal entries=${journal2.entries.length} last=${journal2.entries[journal2.entries.length - 1].event}`,
  );
  console.log(`resume   skip=${runner2.ledger.done()} replay=${replay} epoch=2`);
  const report = runner2.run(handler, {
    epoch: 2,
    plan: epochPlan({ epoch: 2, token_allowance: 600, reserve_tokens: 60 }),
    projected_tokens: 180,
  });
  console.log(
    `epoch2   committed=${report.committed} total=${runner2.ledger.done()} ` +
      `completed=${b(report.completed)}`,
  );
  console.log(
    `budget   epoch=2 spent=${report.spent_tokens}/600 reserve=60 pacing=${report.pacing}`,
  );
  console.log(
    `effects  applied=${Object.keys(effects2.data).length} suppressed=${effects2.suppressed_count}`,
  );
  runner2.ledger.digest().forEach((line, index) => {
    console.log((index === 0 ? "digest   " : "         ") + line);
  });

  console.log("");
  const leases = new TaskLeaseManager(30_000, 10_000, 3);
  const leaseA = leases.acquire("migrate-1", "worker-a", 1, 0);
  if (leaseA === null) throw new Error("lease a");
  console.log(
    `lease    acquire owner=${leaseA.owner} epoch=${leaseA.epoch} fencing=${leaseA.fencing}`,
  );
  const beat = leases.heartbeat(leaseA, 1, 10_000);
  console.log(`lease    heartbeat seq=${beat.seq} status=${beat.status}`);
  const leaseB = leases.takeover("migrate-1", "worker-b", 2, 40_000);
  if (leaseB === null) throw new Error("lease b");
  console.log(
    `lease    takeover owner=${leaseB.owner} epoch=${leaseB.epoch} fencing=${leaseB.fencing}`,
  );
  const stale = leases.heartbeat(leaseA, 2, 41_000);
  console.log(`lease    stale-heartbeat owner=${stale.owner} status=${stale.status}`);
  const [acceptedA, reasonA] = leases.checkWrite(leaseA, 41_000);
  console.log(
    `lease    stale-write owner=worker-a accepted=${b(acceptedA)} reason=${reasonA}`,
  );
  const [acceptedB] = leases.checkWrite(leaseB, 41_000);
  console.log(`lease    write owner=worker-b accepted=${b(acceptedB)}`);

  const pacer = new EpochPacer(epochPlan({ epoch: 1, token_allowance: 1000, reserve_tokens: 100 }));
  pacer.charge(780);
  console.log(`pacing   done=2/4 spent=780/1000 status=${pacer.pacing(2, 4)}`);
  console.log(`pacing   done=3/4 spent=780/1000 status=${pacer.pacing(3, 4)}`);

  const demoGate = new VerificationGate(["m1", "m2"]);
  const cases = [
    verificationResult("m1", "", true),
    verificationResult("m1", "pytest", true, "h-1"),
    verificationResult("m2", "pytest", false, "h-2"),
  ];
  for (const result of cases) {
    const [ok, reason] = demoGate.verify(result);
    if (result.command === "") {
      console.log(`gate     ${result.milestone} evidence=missing -> blocked`);
    } else if (ok) {
      console.log(`gate     ${result.milestone} command=${result.command} exit=0 -> ${reason}`);
    } else {
      console.log(`gate     ${result.milestone} command=${result.command} exit=1 -> failed`);
    }
  }

  const handoffSteps = new Map<string, DurableStep>();
  for (const [key, step] of runner2.ledger.steps) {
    handoffSteps.set(key, step.clone());
  }
  const handoffLedger = new ProgressLedger(
    runner2.ledger.task_id,
    runner2.ledger.goal,
    handoffSteps,
    2,
    [...runner2.ledger.verified],
  );
  const step3 = handoffLedger.steps.get("step-3");
  if (step3 !== undefined) step3.status = StepStatus.FAILED;
  const step4 = handoffLedger.steps.get("step-4");
  if (step4 !== undefined) step4.status = StepStatus.PENDING;
  handoffLedger.completed = false;
  const handoff = buildHandoff(handoffLedger, {
    reason: "approval_timeout",
    options: ["approve_once", "stop"],
    budget: "780/1000",
    changed_files: ["src/app.py"],
    next_step: "resume step-3 after approval",
  });
  for (const line of handoff.render()) console.log(`handoff  ${line}`);
}

main();
