from __future__ import annotations

import asyncio
from pathlib import Path

from .eval.dataset import load_tasks
from .eval.judge import JudgeRow, ScriptedJudge
from .eval.report import render_report
from .eval.runner import run_suite


ROOT = Path(__file__).resolve().parents[2]
TASKS = ROOT / "eval" / "tasks.jsonl"
FIXTURES = ROOT / "eval" / "fixtures"


async def main() -> None:
    tasks = load_tasks(TASKS)
    first = await run_suite(tasks, FIXTURES)
    second = await run_suite(tasks, FIXTURES)
    identical = [item.fingerprint() for item in first] == [item.fingerprint() for item in second]

    judge = ScriptedJudge([2, 5])
    rubric = "答案必须说明修改内容与验证结果"
    rows: list[JudgeRow] = []
    for name, answer in (
        ("vague-answer", "我改好了。"),
        ("specific-answer", "修复了 clamp 的输入校验，运行 python3 src/app.py 输出 3。"),
    ):
        score = await judge.score("修复 TODO", answer, rubric)
        rows.append(JudgeRow(name, score.score, score.max_score, 4, score.score >= 4))

    for line in render_report(first, rows, identical):
        print(line)


if __name__ == "__main__":
    asyncio.run(main())
