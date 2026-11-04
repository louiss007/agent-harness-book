from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class EvalTask:
    id: str
    goal: str
    constraints: tuple[str, ...]
    fixture: str
    allow_write: tuple[str, ...]
    budget: dict[str, Any]
    script: tuple[dict[str, Any], ...]
    checks: dict[str, Any]


@dataclass(frozen=True)
class CheckResult:
    name: str
    ok: bool
    detail: str


@dataclass
class EvalResult:
    task_id: str
    passed: bool
    checks: list[CheckResult]
    reason: str
    turns: int
    tools_ok: int
    tools_failed: int
    tools_blocked: int
    compactions: int
    input_tokens: int
    output_tokens: int
    answer: str

    @property
    def tokens(self) -> int:
        return self.input_tokens + self.output_tokens

    def fingerprint(self) -> tuple[Any, ...]:
        return (
            self.task_id,
            self.passed,
            self.reason,
            self.turns,
            self.tools_ok,
            self.tools_failed,
            self.tools_blocked,
            self.compactions,
            self.tokens,
            tuple((check.name, check.ok) for check in self.checks),
        )
