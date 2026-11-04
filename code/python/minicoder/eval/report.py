from __future__ import annotations

from .judge import JudgeRow
from .types import EvalResult


def render_report(
    results: list[EvalResult],
    judge_rows: list[JudgeRow],
    rerun_identical: bool,
) -> list[str]:
    lines = ["== MiniCoder eval =="]
    for result in results:
        status = "pass" if result.passed else "fail"
        lines.append(
            f"task      {result.task_id:<20} {status:<5} reason={result.reason:<14} "
            f"tools={result.tools_ok}/{result.tools_failed}/{result.tools_blocked} "
            f"turns={result.turns} tokens={result.tokens}"
        )
        for check in result.checks:
            lines.append(
                f"check     {check.name:<20} {('pass' if check.ok else 'fail'):<5} {check.detail}"
            )
    passed = sum(1 for result in results if result.passed)
    lines.append(f"summary   pass={passed}/{len(results)}")
    for row in judge_rows:
        lines.append(
            f"judge     {row.name:<20} {row.score}/{row.max_score} "
            f"threshold={row.threshold} {('pass' if row.passed else 'fail')}"
        )
    lines.append(
        f"golden    rerun_identical={'True' if rerun_identical else 'False'} tasks={len(results)}"
    )
    return lines
