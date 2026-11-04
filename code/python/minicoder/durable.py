"""第 18 章：长时运行任务的持久化执行层。

只做加法：不修改 runtime、session、provider 的既有接口。核心约束：

- 进度、证据与预算都要落在追加式日志里，进程内存只是投影；
- 每一步有稳定 step_id 与幂等键，恢复时跳过已提交、重放未提交；
- 副作用先落幂等存储，再写提交事件；两步之间崩溃只会重放，不会重复生效；
- 心跳表示存活，租约与 fencing token 表示写权限；怀疑死亡不等于立即接管。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Optional


# ---------------------------------------------------------------------------
# 步骤与进度账
# ---------------------------------------------------------------------------


class StepStatus:
    PENDING = "pending"
    RUNNING = "running"
    COMMITTED = "committed"
    FAILED = "failed"


@dataclass
class DurableStep:
    step_id: str
    title: str
    milestone: str
    status: str = StepStatus.PENDING
    attempts: int = 0
    epoch: int = 1
    evidence: str = ""
    note: str = ""

    def clone(self) -> "DurableStep":
        return DurableStep(
            self.step_id,
            self.title,
            self.milestone,
            self.status,
            self.attempts,
            self.epoch,
            self.evidence,
            self.note,
        )


@dataclass(frozen=True)
class JournalEntry:
    seq: int
    epoch: int
    event: str
    step_id: str
    data: dict[str, Any]


class TaskJournal:
    """追加式任务日志。每条 fsync；恢复时只读，不修改历史记录。"""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.entries: list[JournalEntry] = []
        self.seq = 0
        if self.path.exists():
            for line in self.path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    raw = json.loads(line)
                    self.entries.append(
                        JournalEntry(
                            int(raw["seq"]),
                            int(raw["epoch"]),
                            str(raw["event"]),
                            str(raw["step_id"]),
                            dict(raw["data"]),
                        )
                    )
                    self.seq = int(raw["seq"])

    def append(
        self, event: str, *, step_id: str = "", epoch: int = 1, **data: Any
    ) -> JournalEntry:
        self.seq += 1
        entry = JournalEntry(self.seq, epoch, event, step_id, dict(data))
        payload = {
            "seq": entry.seq,
            "epoch": entry.epoch,
            "event": entry.event,
            "step_id": entry.step_id,
            "data": entry.data,
        }
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(
                json.dumps(
                    payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
                )
                + "\n"
            )
            handle.flush()
            os.fsync(handle.fileno())
        self.entries.append(entry)
        return entry


@dataclass
class ProgressLedger:
    task_id: str
    goal: str
    steps: dict[str, DurableStep]
    epoch: int = 1
    verified: list[str] = field(default_factory=list)
    suspended: str = ""
    completed: bool = False

    @classmethod
    def from_journal(
        cls,
        task_id: str,
        goal: str,
        steps: Iterable[DurableStep],
        journal: TaskJournal,
    ) -> "ProgressLedger":
        ledger = cls(task_id, goal, {step.step_id: step.clone() for step in steps})
        for entry in journal.entries:
            ledger.apply(entry)
        return ledger

    def apply(self, entry: JournalEntry) -> None:
        step = self.steps.get(entry.step_id) if entry.step_id else None
        if entry.event == "epoch_started":
            self.epoch = entry.epoch
        elif entry.event == "step_intent" and step is not None:
            step.status = StepStatus.RUNNING
            step.attempts = int(entry.data["attempt"])
            step.epoch = entry.epoch
        elif entry.event == "step_committed" and step is not None:
            step.status = StepStatus.COMMITTED
            step.evidence = str(entry.data.get("evidence", ""))
        elif entry.event == "step_failed" and step is not None:
            step.status = StepStatus.FAILED
            step.attempts = int(entry.data.get("attempt", step.attempts))
            step.note = str(entry.data.get("error", ""))
        elif entry.event == "milestone_verified":
            milestone = str(entry.data.get("milestone", ""))
            if milestone and milestone not in self.verified:
                self.verified.append(milestone)
        elif entry.event == "task_suspended":
            self.suspended = str(entry.data.get("reason", ""))
        elif entry.event == "task_completed":
            self.completed = True

    def next_step(self) -> Optional[DurableStep]:
        for step in self.steps.values():
            if step.status != StepStatus.COMMITTED:
                return step
        return None

    def done(self) -> int:
        return sum(1 for step in self.steps.values() if step.status == StepStatus.COMMITTED)

    def digest(self, max_steps: int = 8) -> list[str]:
        lines = [
            f"task {self.task_id} epoch={self.epoch} done={self.done()}/{len(self.steps)}"
        ]
        for step in list(self.steps.values())[:max_steps]:
            lines.append(f"{step.status:<9} {step.step_id} {step.title}")
        return lines


class EffectStore:
    """幂等副作用存储：同一个 key 只生效一次，重放返回第一次的值。"""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.data: dict[str, str] = {}
        self.applied_count = 0
        self.suppressed_count = 0
        if self.path.exists():
            self.data = json.loads(self.path.read_text(encoding="utf-8"))

    def apply_once(self, key: str, value: str) -> tuple[str, bool]:
        if key in self.data:
            self.suppressed_count += 1
            return self.data[key], False
        self.data[key] = value
        self.applied_count += 1
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(self.data, ensure_ascii=False, sort_keys=True),
            encoding="utf-8",
        )
        os.replace(tmp, self.path)
        return value, True


# ---------------------------------------------------------------------------
# 预算与节奏
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EpochPlan:
    epoch: int
    token_allowance: int
    reserve_tokens: int = 0
    cost_allowance_micros: int = 0
    reserve_micros: int = 0


@dataclass
class EpochUsage:
    tokens: int = 0
    cost_micros: int = 0


class EpochPacer:
    """按 epoch 分配的预算节奏器；金额账仍由 cost.BudgetLedger 承担。"""

    def __init__(self, plan: EpochPlan) -> None:
        self.plan = plan
        self.usage = EpochUsage()

    def can_start(self, projected_tokens: int, projected_micros: int = 0) -> tuple[bool, str]:
        available = self.plan.token_allowance - self.plan.reserve_tokens
        if self.usage.tokens + projected_tokens > available:
            return False, "epoch_budget"
        if self.plan.cost_allowance_micros:
            remaining = self.plan.cost_allowance_micros - self.plan.reserve_micros
            if self.usage.cost_micros + projected_micros > remaining:
                return False, "cost_budget"
        return True, "ok"

    def charge(self, tokens: int, cost_micros: int = 0) -> None:
        self.usage.tokens += max(0, tokens)
        self.usage.cost_micros += max(0, cost_micros)

    def pacing(self, done: int, total: int, margin_permille: int = 150) -> str:
        allowance = max(1, self.plan.token_allowance)
        spent_permille = self.usage.tokens * 1000 // allowance
        progress_permille = done * 1000 // max(1, total)
        if spent_permille > progress_permille + margin_permille:
            return "pacing"
        return "ok"

    def line(self, done: int, total: int) -> str:
        return (
            f"epoch={self.plan.epoch} spent={self.usage.tokens}/"
            f"{self.plan.token_allowance} reserve={self.plan.reserve_tokens} "
            f"pacing={self.pacing(done, total)}"
        )


# ---------------------------------------------------------------------------
# 验证门与接管包
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VerificationResult:
    milestone: str
    command: str
    ok: bool
    output_hash: str = ""


class VerificationGate:
    """里程碑验证：没有命令、命令失败或未知里程碑都不算通过。"""

    def __init__(self, milestones: Iterable[str]) -> None:
        self.required = list(milestones)
        self.results: list[VerificationResult] = []

    def verify(self, result: VerificationResult) -> tuple[bool, str]:
        if result.milestone not in self.required:
            return False, "unknown_milestone"
        if not result.command:
            return False, "no_command"
        self.results.append(result)
        if not result.ok:
            return False, "nonzero_exit"
        return True, "passed"


@dataclass
class HandoffPackage:
    task_id: str
    epoch: int
    reason: str
    goal: str
    done: list[str]
    blocked: list[str]
    options: list[str]
    budget: str
    changed_files: list[str]
    next_step: str

    def render(self) -> list[str]:
        lines = [
            f"task={self.task_id} epoch={self.epoch} reason={self.reason}",
            f"done={len(self.done)} blocked={len(self.blocked)} budget={self.budget}",
        ]
        lines.extend(f"  done    {item}" for item in self.done)
        lines.extend(f"  blocked {item}" for item in self.blocked)
        lines.append(f"next={self.next_step}")
        lines.append(f"files={','.join(self.changed_files)}")
        lines.append(f"options={','.join(self.options)}")
        return lines


def build_handoff(
    ledger: ProgressLedger,
    *,
    reason: str,
    options: Iterable[str],
    budget: str,
    changed_files: Iterable[str],
    next_step: str,
) -> HandoffPackage:
    done = [
        f"{step.step_id} {step.title}"
        for step in ledger.steps.values()
        if step.status == StepStatus.COMMITTED
    ]
    blocked = [
        f"{step.step_id} {step.title}"
        for step in ledger.steps.values()
        if step.status in (StepStatus.FAILED, StepStatus.RUNNING)
    ]
    return HandoffPackage(
        ledger.task_id,
        ledger.epoch,
        reason,
        ledger.goal,
        done,
        blocked,
        list(options),
        budget,
        list(changed_files),
        next_step,
    )


# ---------------------------------------------------------------------------
# 租约与心跳
# ---------------------------------------------------------------------------


@dataclass
class TaskLease:
    task_id: str
    owner: str
    epoch: int
    fencing: int
    expires_at_ms: int


@dataclass(frozen=True)
class Heartbeat:
    owner: str
    fencing: int
    seq: int
    at_ms: int
    status: str


class TaskLeaseManager:
    """长任务租约：心跳续期、过期接管、fencing token 拒绝旧写者。"""

    def __init__(
        self, lease_ms: int = 30_000, heartbeat_ms: int = 10_000, suspect_after: int = 3
    ) -> None:
        self.lease_ms = lease_ms
        self.heartbeat_ms = heartbeat_ms
        self.suspect_after = suspect_after
        self.leases: dict[str, TaskLease] = {}
        self.tokens: dict[str, int] = {}
        self.heartbeats: dict[str, Heartbeat] = {}

    def acquire(self, task_id: str, owner: str, epoch: int, now_ms: int) -> Optional[TaskLease]:
        current = self.leases.get(task_id)
        if current is not None and current.expires_at_ms > now_ms:
            return current if current.owner == owner else None
        fencing = self.tokens.get(task_id, 0) + 1
        self.tokens[task_id] = fencing
        lease = TaskLease(task_id, owner, epoch, fencing, now_ms + self.lease_ms)
        self.leases[task_id] = lease
        return lease

    def heartbeat(self, lease: TaskLease, seq: int, now_ms: int) -> Heartbeat:
        current = self.leases.get(lease.task_id)
        if (
            current is None
            or current.fencing != lease.fencing
            or current.expires_at_ms <= now_ms
        ):
            result = Heartbeat(lease.owner, lease.fencing, seq, now_ms, "stale")
        else:
            current.expires_at_ms = now_ms + self.lease_ms
            result = Heartbeat(lease.owner, lease.fencing, seq, now_ms, "ok")
        self.heartbeats[lease.task_id] = result
        return result

    def takeover(
        self, task_id: str, owner: str, epoch: int, now_ms: int
    ) -> Optional[TaskLease]:
        current = self.leases.get(task_id)
        if current is not None and current.expires_at_ms > now_ms:
            return None
        return self.acquire(task_id, owner, epoch, now_ms)

    def check_write(self, lease: TaskLease, now_ms: int) -> tuple[bool, str]:
        current = self.leases.get(lease.task_id)
        if current is None:
            return False, "no_lease"
        if current.fencing != lease.fencing:
            return False, "fencing"
        if current.expires_at_ms <= now_ms:
            return False, "expired"
        return True, "ok"


# ---------------------------------------------------------------------------
# 执行器
# ---------------------------------------------------------------------------


class InjectedCrash(RuntimeError):
    """演示用：在副作用之后、提交事件之前中断。"""


@dataclass(frozen=True)
class StepContext:
    task_id: str
    step: DurableStep
    attempt: int
    epoch: int
    effects: EffectStore


@dataclass
class StepOutcome:
    ok: bool
    evidence: str = ""
    detail: str = ""
    tokens: int = 0
    cost_micros: int = 0
    verified: bool = False


StepHandler = Callable[[StepContext], StepOutcome]
EventSink = Callable[[JournalEntry], None]


@dataclass
class RunReport:
    epoch: int
    committed: int
    replayed: int
    skipped: int
    suspended: str
    completed: bool
    spent_tokens: int
    pacing: str


class DurableRunner:
    """按步执行、逐步提交；恢复时从日志重建进度并重放未提交步骤。"""

    def __init__(
        self,
        task_id: str,
        goal: str,
        steps: Iterable[DurableStep],
        journal: TaskJournal,
        effects: EffectStore,
        *,
        max_attempts: int = 2,
        on_event: Optional[EventSink] = None,
    ) -> None:
        self.task_id = task_id
        self.goal = goal
        self.steps = [step.clone() for step in steps]
        self.journal = journal
        self.effects = effects
        self.max_attempts = max_attempts
        self.on_event = on_event
        self.ledger = ProgressLedger.from_journal(task_id, goal, self.steps, journal)
        self.pacer: Optional[EpochPacer] = None
        if journal.seq == 0:
            self._log("task_started", epoch=1, goal=goal)

    def _log(self, event: str, *, step_id: str = "", epoch: int = 1, **data: Any) -> JournalEntry:
        entry = self.journal.append(event, step_id=step_id, epoch=epoch, **data)
        if self.on_event is not None:
            self.on_event(entry)
        self.ledger.apply(entry)
        return entry

    def run(
        self,
        handler: StepHandler,
        *,
        epoch: int,
        plan: EpochPlan,
        projected_tokens: int = 120,
    ) -> RunReport:
        self.pacer = EpochPacer(plan)
        self._log("epoch_started", epoch=epoch)
        skipped = sum(
            1 for step in self.ledger.steps.values() if step.status == StepStatus.COMMITTED
        )
        replayed = sum(
            1 for step in self.ledger.steps.values() if step.status == StepStatus.RUNNING
        )
        committed = 0
        suspended = ""

        while True:
            step = self.ledger.next_step()
            if step is None:
                break
            if step.status == StepStatus.FAILED and step.attempts >= self.max_attempts:
                suspended = "retry_exhausted"
                self._log(
                    "task_suspended",
                    step_id=step.step_id,
                    epoch=epoch,
                    reason=suspended,
                )
                break

            ok, reason = self.pacer.can_start(projected_tokens)
            if not ok:
                suspended = reason
                self._log(
                    "task_suspended",
                    step_id=step.step_id,
                    epoch=epoch,
                    reason=reason,
                )
                break

            attempt = step.attempts + 1
            key = f"{self.task_id}:{step.step_id}"
            self._log(
                "step_intent",
                step_id=step.step_id,
                epoch=epoch,
                attempt=attempt,
                idempotency_key=key,
            )
            try:
                outcome = handler(
                    StepContext(self.task_id, step, attempt, epoch, self.effects)
                )
            except InjectedCrash:
                self.pacer.charge(projected_tokens, 0)
                self._log(
                    "step_crashed",
                    step_id=step.step_id,
                    epoch=epoch,
                    attempt=attempt,
                    after_effect=True,
                )
                raise

            self.pacer.charge(outcome.tokens, outcome.cost_micros)
            if outcome.ok:
                if outcome.verified:
                    self._log(
                        "milestone_verified",
                        step_id=step.step_id,
                        epoch=epoch,
                        milestone=step.milestone,
                        evidence=outcome.evidence,
                    )
                self._log(
                    "step_committed",
                    step_id=step.step_id,
                    epoch=epoch,
                    evidence=outcome.evidence,
                    tokens=outcome.tokens,
                )
                committed += 1
            else:
                self._log(
                    "step_failed",
                    step_id=step.step_id,
                    epoch=epoch,
                    attempt=attempt,
                    error=outcome.detail or "failed",
                )

        if self.ledger.next_step() is None:
            self._log("task_completed", epoch=epoch)

        return RunReport(
            epoch,
            committed,
            replayed,
            skipped,
            suspended,
            self.ledger.completed,
            self.pacer.usage.tokens,
            self.pacer.pacing(self.ledger.done(), len(self.ledger.steps)),
        )
