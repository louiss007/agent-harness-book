"""第 18 章离线演示：崩溃、恢复、幂等副作用、租约接管与接管包。"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from .durable import (
    DurableRunner,
    DurableStep,
    EffectStore,
    EpochPacer,
    EpochPlan,
    InjectedCrash,
    JournalEntry,
    ProgressLedger,
    StepContext,
    StepOutcome,
    TaskJournal,
    TaskLeaseManager,
    VerificationGate,
    VerificationResult,
    build_handoff,
)


def _b(value: bool) -> str:
    return "true" if value else "false"


def _steps() -> list[DurableStep]:
    return [
        DurableStep("step-1", "copy schema", "m1"),
        DurableStep("step-2", "rewrite imports", "m2"),
        DurableStep("step-3", "run tests", "m3"),
        DurableStep("step-4", "write report", "m4"),
    ]


def main() -> None:
    print("== MiniCoder durable ==")
    root = Path(tempfile.mkdtemp(prefix="minicoder-durable-"))
    try:
        run(root)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def run(root: Path) -> None:
    journal = TaskJournal(root / "durable.jsonl")
    effects = EffectStore(root / "effects.json")
    gate = VerificationGate(["m1", "m2", "m3", "m4"])
    print(f"journal  new seq={journal.seq}")

    def sink(entry: JournalEntry) -> None:
        if entry.event == "step_intent":
            print(f"step     {entry.step_id} intent attempt={entry.data['attempt']}")
        elif entry.event == "step_committed":
            print(f"step     {entry.step_id} committed evidence={entry.data.get('evidence', '')}")
        elif entry.event == "step_crashed":
            print(f"crash    after-effect step={entry.step_id} commit=missing")

    def handler(ctx: StepContext) -> StepOutcome:
        sid = ctx.step.step_id
        if sid == "step-1":
            return StepOutcome(True, evidence="cmd:cp exit=0", tokens=120)
        if sid == "step-2":
            _, applied = ctx.effects.apply_once("migrate-1:step-2:rewrite", "src/app.py")
            if ctx.attempt == 1:
                print(f"effect   applied={_b(applied)} step={sid} key=rewrite")
                raise InjectedCrash("crash after effect")
            print(f"step     {sid} replay applied={_b(applied)}")
            return StepOutcome(
                True,
                evidence=f"effect:rewrite applied={_b(applied)}",
                tokens=180,
            )
        if sid == "step-3":
            ok, reason = gate.verify(VerificationResult("m3", "pytest", True, "h-3"))
            print(f"verify   m3 command=pytest exit=0 -> {reason}")
            return StepOutcome(
                ok,
                evidence="pytest:exit=0" if ok else reason,
                tokens=90,
                verified=ok,
            )
        if sid == "step-4":
            return StepOutcome(True, evidence="artifact:report", tokens=60)
        return StepOutcome(False, detail="unknown_step")

    runner = DurableRunner(
        "migrate-1", "migrate config to v2", _steps(), journal, effects, on_event=sink
    )
    try:
        runner.run(handler, epoch=1, plan=EpochPlan(1, 1000, 100), projected_tokens=180)
    except InjectedCrash:
        pass
    running = sum(1 for step in runner.ledger.steps.values() if step.status == "running")
    spent = runner.pacer.usage.tokens if runner.pacer else 0
    print(
        f"epoch1   committed={runner.ledger.done()} running={running} spent={spent}/1000"
    )

    journal2 = TaskJournal(journal.path)
    effects2 = EffectStore(effects.path)
    runner2 = DurableRunner(
        "migrate-1", "migrate config to v2", _steps(), journal2, effects2, on_event=sink
    )
    replay = sum(1 for step in runner2.ledger.steps.values() if step.status == "running")
    print(f"resume   journal entries={len(journal2.entries)} last={journal2.entries[-1].event}")
    print(f"resume   skip={runner2.ledger.done()} replay={replay} epoch=2")
    report = runner2.run(
        handler, epoch=2, plan=EpochPlan(2, 600, 60), projected_tokens=180
    )
    print(
        f"epoch2   committed={report.committed} total={runner2.ledger.done()} "
        f"completed={_b(report.completed)}"
    )
    print(
        f"budget   epoch=2 spent={report.spent_tokens}/600 reserve=60 pacing={report.pacing}"
    )
    print(
        f"effects  applied={len(effects2.data)} suppressed={effects2.suppressed_count}"
    )
    for index, line in enumerate(runner2.ledger.digest()):
        prefix = "digest   " if index == 0 else "         "
        print(prefix + line)

    print()
    leases = TaskLeaseManager(lease_ms=30_000, heartbeat_ms=10_000, suspect_after=3)
    lease_a = leases.acquire("migrate-1", "worker-a", 1, 0)
    assert lease_a is not None
    print(f"lease    acquire owner={lease_a.owner} epoch={lease_a.epoch} fencing={lease_a.fencing}")
    beat = leases.heartbeat(lease_a, 1, 10_000)
    print(f"lease    heartbeat seq={beat.seq} status={beat.status}")
    lease_b = leases.takeover("migrate-1", "worker-b", 2, 40_000)
    assert lease_b is not None
    print(f"lease    takeover owner={lease_b.owner} epoch={lease_b.epoch} fencing={lease_b.fencing}")
    stale = leases.heartbeat(lease_a, 2, 41_000)
    print(f"lease    stale-heartbeat owner={stale.owner} status={stale.status}")
    accepted_a, reason_a = leases.check_write(lease_a, 41_000)
    print(
        f"lease    stale-write owner=worker-a accepted={_b(accepted_a)} reason={reason_a}"
    )
    accepted_b, _ = leases.check_write(lease_b, 41_000)
    print(f"lease    write owner=worker-b accepted={_b(accepted_b)}")

    pacer = EpochPacer(EpochPlan(1, 1000, 100))
    pacer.charge(780)
    print(f"pacing   done=2/4 spent=780/1000 status={pacer.pacing(2, 4)}")
    print(f"pacing   done=3/4 spent=780/1000 status={pacer.pacing(3, 4)}")

    demo_gate = VerificationGate(["m1", "m2"])
    cases = [
        VerificationResult("m1", "", True),
        VerificationResult("m1", "pytest", True, "h-1"),
        VerificationResult("m2", "pytest", False, "h-2"),
    ]
    for result in cases:
        ok, reason = demo_gate.verify(result)
        if not result.command:
            print(f"gate     {result.milestone} evidence=missing -> blocked")
        elif ok:
            print(f"gate     {result.milestone} command={result.command} exit=0 -> {reason}")
        else:
            print(f"gate     {result.milestone} command={result.command} exit=1 -> failed")

    handoff_ledger = ProgressLedger(
        runner2.ledger.task_id,
        runner2.ledger.goal,
        {key: step.clone() for key, step in runner2.ledger.steps.items()},
        epoch=2,
        verified=list(runner2.ledger.verified),
    )
    handoff_ledger.steps["step-3"].status = "failed"
    handoff_ledger.steps["step-4"].status = "pending"
    handoff_ledger.completed = False
    package = build_handoff(
        handoff_ledger,
        reason="approval_timeout",
        options=["approve_once", "stop"],
        budget="780/1000",
        changed_files=["src/app.py"],
        next_step="resume step-3 after approval",
    )
    for line in package.render():
        print(f"handoff  {line}")


if __name__ == "__main__":
    main()
