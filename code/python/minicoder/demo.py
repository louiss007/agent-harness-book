from __future__ import annotations

import asyncio
import json
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

from .context import ContextBudget
from .permissions import ApprovalRequest, ApprovalResult
from .provider import ScriptedProvider, response
from .runtime import HarnessConfig, MiniCoder, make_demo_hooks
from .session import detect_drift
from .types import ToolCall


ORIGINAL = '''"""演示用的迷你应用。"""
TOKEN = "sk-live-123"

def add(a, b):
    return a + b

def sub(a, b):
    return a - b

def mul(a, b):
    return a * b

def div(a, b):
    return a / b

def clamp(value, low, high):
    # TODO: 输入校验
    if value < low:
        return low
    if value > high:
        return high
    return value

def describe(value):
    if value > 0:
        return "positive"
    if value < 0:
        return "negative"
    return "zero"

def main():
    print(add(1, 2))

if __name__ == "__main__":
    main()
'''

FIXED = '''"""演示用的迷你应用。"""
TOKEN = "env:MINICODER_TOKEN"

def add(a, b):
    return a + b

def sub(a, b):
    return a - b

def mul(a, b):
    return a * b

def div(a, b):
    return a / b

def clamp(value, low, high):
    if not isinstance(value, (int, float)):
        raise TypeError("value 必须是数字")
    if low > high:
        raise ValueError("low 不能大于 high")
    if value < low:
        return low
    if value > high:
        return high
    return value

def describe(value):
    if value > 0:
        return "positive"
    if value < 0:
        return "negative"
    return "zero"

def main():
    print(add(1, 2))

if __name__ == "__main__":
    main()
'''


class DemoApprover:
    def __init__(self) -> None:
        self.requests: list[str] = []

    def approve(self, request: ApprovalRequest) -> ApprovalResult:
        action = request.action
        rendered = " ".join(action.argv) if action.argv else action.target
        self.requests.append(f"{action.tool} {rendered}")
        if action.tool == "write_file" and action.target == "src/app.py":
            return ApprovalResult("allow_once", "演示：单次允许修改源码")
        if action.tool == "run_command" and action.argv[:1] == ("python3",):
            return ApprovalResult("allow_session", "演示：本会话允许运行 python3")
        return ApprovalResult("deny", "演示：其余动作拒绝")


def read_events(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def normalize(text: str) -> str:
    text = re.sub(r" in \d+\.\d+s", "", text)
    text = re.sub(r"\[sandbox sbx-\d+\]", "[sandbox]", text)
    return text.strip()


async def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="minicoder-demo-"))
    host = root / "workspace"
    (host / "src").mkdir(parents=True)
    (host / "src" / "app.py").write_text(ORIGINAL, encoding="utf-8")

    approver = DemoApprover()
    coder = MiniCoder(
        HarnessConfig(
            workspace=host,
            session_id="demo-13",
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
        approver=approver,
        hooks=make_demo_hooks(),
    )

    result = await coder.run("修复 src/app.py 中的 TODO 并验证", constraints=("只改 src 下的文件",))
    events = read_events(coder.store.events_path)

    print("== MiniCoder demo ==")
    print(f"loop      {result.reason.value} turns={result.turns} tools={result.tool_calls} compactions={result.compactions}")
    print(f"usage     input={result.usage.input_tokens} output={result.usage.output_tokens}")

    for event in events:
        if event["type"] in {"tool_committed", "tool_failed", "tool_blocked"}:
            data = event["data"]
            status = "ok" if event["type"] == "tool_committed" else "blocked" if event["type"] == "tool_blocked" else "failed"
            detail = data.get("reason") or data.get("error", "")
            print(f"tool      {data['call_id']:<3} {data['tool']:<11} {status:<7} {detail}".rstrip())

    transcript_path = coder.store.dir / "transcript.jsonl"
    transcript = transcript_path.read_text(encoding="utf-8") if transcript_path.exists() else ""
    visible = transcript + "\n" + "\n".join(message.content for message in result.messages)
    print(
        f"read      lines={len(ORIGINAL.splitlines())} "
        f"secret_visible={'sk-live-123' in visible} redacted={'sk-***' in transcript}"
    )

    final_file = coder.ws.root / "src" / "app.py"
    host_file = host / "src" / "app.py"
    print(f"write     chars={len(FIXED)} applied={final_file.read_text(encoding='utf-8') == FIXED}")
    print(f"host      unchanged={host_file.read_text(encoding='utf-8') == ORIGINAL}")

    for event in events:
        if event["type"] == "context_compacted":
            data = event["data"]
            print(
                f"compact   before={data['before_tokens']} after={data['after_tokens']} "
                f"kept_recent={data['kept_recent']} degraded={data['degraded']}"
            )

    for event in events:
        if event["type"] == "hook_finished":
            data = event["data"]
            trace = ",".join(data["trace"])
            print(f"hook      {data['event']:<11} {data['action']:<8} {trace}")

    for line in coder.permissions.records:
        print(f"audit     {line.seq:02d} {line.decision:<14} {line.tool:<11} rule={line.rule}")

    intent = next((e["data"] for e in events if e["type"] == "tool_intent" and e["data"]["call_id"] == "c3"), None)
    if intent is not None:
        print(f"intent    c3 args={intent['args']['argv']} key={intent['idempotency_key']}")

    recovered = coder.recover()
    drift = detect_drift(recovered.state, coder.ws.root)
    print(
        f"recover   source={recovered.source} replayed={recovered.replayed} "
        f"files={len(recovered.state.files)} drift={drift or 'none'}"
    )

    info = coder.close()
    print(f"sandbox   runs={info['runs']} kept={info['kept_workspace']}")
    shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    asyncio.run(main())
