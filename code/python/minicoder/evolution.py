"""第 19 章：责任分配与脚手架退场的判定模型。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

MODEL = "model"
HARNESS = "harness"
EXTERNAL = "external"


@dataclass(frozen=True)
class Responsibility:
    """一个需要决定由谁负责的能力点。"""

    name: str
    failure_cost: int  # 1..5
    frequency: int  # 1..5
    self_verifiable: bool


@dataclass(frozen=True)
class Allocation:
    name: str
    owner: str
    risk: int
    reason: str


@dataclass(frozen=True)
class Scaffold:
    """一段 Harness 代码及其在新模型上的能力探针结果。"""

    name: str
    kind: str  # compensation / invariant / interface
    failure_cost: int
    frequency: int
    self_verifiable: bool
    baseline: float  # 旧模型带着脚手架时的通过率
    probe: float  # 新模型不使用脚手架时的通过率
    regression_budget: float = 0.02


@dataclass(frozen=True)
class Decision:
    name: str
    kind: str
    risk: int
    action: str
    reason: str
    delta: float


@dataclass(frozen=True)
class Contract:
    """跨版本仍需保持兼容的接口。"""

    name: str
    since: int
    policy: str


def allocate(item: Responsibility) -> Allocation:
    risk = item.failure_cost * item.frequency
    if risk >= 16:
        owner, reason = EXTERNAL, "irreversible_or_adversarial"
    elif risk >= 8:
        owner, reason = HARNESS, "guarded_by_verification"
    elif not item.self_verifiable:
        owner, reason = HARNESS, "needs_external_feedback"
    else:
        owner, reason = MODEL, "cheap_and_self_verifiable"
    return Allocation(item.name, owner, risk, reason)


def decide(item: Scaffold) -> Decision:
    risk = item.failure_cost * item.frequency
    delta = item.probe - item.baseline
    if item.kind == "invariant":
        action = "harden" if risk >= 16 else "keep"
        reason = "world_constraint"
    elif item.kind == "interface":
        action, reason = "keep", "compatibility"
    elif item.probe >= 0.90 and delta >= -item.regression_budget:
        action, reason = "retire", "probe_meets_bar"
    elif item.probe >= 0.85 and delta >= -(item.regression_budget * 3):
        action, reason = "thin", "partial_gap"
    else:
        action, reason = "keep", "probe_regression"
    return Decision(item.name, item.kind, risk, action, reason, delta)


def summarize(decisions: Iterable[Decision]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for decision in decisions:
        counts[decision.action] = counts.get(decision.action, 0) + 1
    return counts


def _b(value: bool) -> str:
    return "true" if value else "false"


def main() -> None:
    print("== MiniCoder evolution ==")
    print("gate     probe=without-scaffold shadow=on regression_budget=0.02 rollback=on")

    responsibilities = [
        Responsibility("format-repair", 2, 3, True),
        Responsibility("verify-changes", 4, 3, False),
        Responsibility("prod-write", 5, 4, False),
    ]
    for item in responsibilities:
        result = allocate(item)
        print(
            f"allocate {result.name:<18} risk={result.risk:<2} "
            f"self_verify={_b(item.self_verifiable):<5} -> "
            f"{result.owner} reason={result.reason}"
        )

    scaffolds = [
        Scaffold("format-hint", "compensation", 1, 3, True, 0.82, 0.94),
        Scaffold("repo-map", "compensation", 2, 4, True, 0.84, 0.86),
        Scaffold("plan-template", "compensation", 3, 3, False, 0.81, 0.78),
        Scaffold("test-gate", "invariant", 4, 5, False, 0.00, 0.00),
        Scaffold("sandbox", "invariant", 5, 5, False, 0.00, 0.00),
        Scaffold("event-schema", "interface", 4, 4, True, 0.00, 0.00),
    ]
    decisions: list[Decision] = []
    for item in scaffolds:
        decision = decide(item)
        decisions.append(decision)
        print(
            f"scaffold {decision.name:<18} kind={decision.kind:<12} "
            f"risk={decision.risk:<2} probe={item.probe:.2f} "
            f"baseline={item.baseline:.2f} -> {decision.action} "
            f"delta={decision.delta:+.2f}"
        )

    contracts = [
        Contract("Provider.complete", 3, "versioned"),
        Contract("ToolResult", 5, "versioned"),
        Contract("SessionStore.events", 7, "append-only"),
        Contract("Action/Decision", 11, "versioned"),
        Contract("step_id/journal", 18, "append-only"),
    ]
    for contract in contracts:
        print(
            f"contract {contract.name:<24} since={contract.since:<2} "
            f"policy={contract.policy}"
        )

    counts = summarize(decisions)
    print(
        f"summary  retire={counts.get('retire', 0)} thin={counts.get('thin', 0)} "
        f"keep={counts.get('keep', 0)} harden={counts.get('harden', 0)} "
        f"total={len(decisions)}"
    )


if __name__ == "__main__":
    main()
