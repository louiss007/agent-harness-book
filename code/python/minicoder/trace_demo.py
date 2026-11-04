from __future__ import annotations

import asyncio
import json
import shutil
import tempfile
from pathlib import Path
from typing import Any

from .context import ContextBudget
from .demo import FIXED, ORIGINAL, DemoApprover
from .provider import ScriptedProvider, response
from .runtime import HarnessConfig, MiniCoder, make_demo_hooks
from .trace import build_trace, merge_child, redact_args, render_tree, replay, summarize
from .types import ToolCall


def read_events(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


async def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="minicoder-trace-"))
    host = root / "workspace"
    (host / "src").mkdir(parents=True)
    (host / "src" / "app.py").write_text(ORIGINAL, encoding="utf-8")

    coder = MiniCoder(
        HarnessConfig(
            workspace=host,
            session_id="demo-14",
            budget=ContextBudget(
                window=900,
                output_reserve=220,
                safety_margin=68,
                tool_result_cap=500,
                compact_at=0.85,
            ),
            keep_sandbox_workspace=False,
        ),
        ScriptedProvider(
            [
                response(calls=[ToolCall("c1", "read_file", {"path": "src/app.py"})]),
                response(calls=[ToolCall("c2", "write_file", {"path": "src/app.py", "content": FIXED})]),
                response(calls=[ToolCall("c3", "run_command", {"argv": ["python3", "src/app.py"]})]),
                response(calls=[ToolCall("c4", "run_command", {"argv": ["rm", "-rf", "build"]})]),
                response(text="已修复 src/app.py 的 TODO，并运行 python3 src/app.py 验证通过。"),
            ]
        ),
        approver=DemoApprover(),
        hooks=make_demo_hooks(),
    )
    result = await coder.run("修复 src/app.py 中的 TODO 并验证", constraints=("只改 src 下的文件",))
    trace = build_trace(read_events(coder.store.events_path), session_id="demo-14")

    child = [
        {
            "seq": 1,
            "type": "sub:dg-1:tool_intent",
            "data": {"call_id": "d1", "tool": "read_file", "args": {"path": "src/app.py"}},
        },
        {
            "seq": 2,
            "type": "sub:dg-1:tool_finished",
            "data": {"call_id": "d1", "tool": "read_file", "ok": True, "summary": "read src/app.py"},
        },
    ]
    merged = merge_child(trace, "dg-1", child, role="investigator")
    summary = summarize(trace, input_tokens=result.usage.input_tokens, output_tokens=result.usage.output_tokens)

    print("== Trace demo ==")
    print(f"trace     id={trace.trace_id[:8]} spans={len(trace.spans)}")
    for line in render_tree(trace):
        print("span      " + line)
    print(
        f"metrics   turns={summary.turns} tools={summary.tool_attempts} ok={summary.tool_ok} "
        f"failed={summary.tool_failed} blocked={summary.tool_blocked} approvals={summary.approvals} "
        f"wait={summary.approval_wait} compactions={summary.compactions} subagents={summary.subagents} "
        f"reason={summary.reason} tokens={summary.input_tokens}/{summary.output_tokens}"
    )

    sample = redact_args(
        "run_command",
        {"argv": ["curl", "-H", "Authorization: Bearer sk-live-999", "--token", "sk-live-999"], "cwd": "."},
    )
    leaked = "sk-live-999" in json.dumps(sample, ensure_ascii=False)
    print(f"redact    secret_visible={leaked} argv={sample['argv']}")

    print(f"child     merged={merged} parent=subagent.investigator status={trace.spans[-1].status}")
    for line in replay(trace, limit=9):
        print("replay    " + line)

    coder.close()
    shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
