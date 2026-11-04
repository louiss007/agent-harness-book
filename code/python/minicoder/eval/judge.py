from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, Sequence


@dataclass(frozen=True)
class JudgeScore:
    score: int
    max_score: int
    reason: str


@dataclass(frozen=True)
class JudgeRow:
    name: str
    score: int
    max_score: int
    threshold: int
    passed: bool


class Judge(Protocol):
    async def score(self, task: str, answer: str, rubric: str) -> JudgeScore: ...


class ScriptedJudge:
    """离线替身：按脚本返回分数，用于演示 Judge 接口与阈值判定。"""

    def __init__(self, scores: Sequence[int], *, max_score: int = 5) -> None:
        self._scores = list(scores)
        self.max_score = max_score

    async def score(self, task: str, answer: str, rubric: str) -> JudgeScore:
        if not self._scores:
            raise RuntimeError("Judge 分数已用尽")
        return JudgeScore(self._scores.pop(0), self.max_score, "scripted")
