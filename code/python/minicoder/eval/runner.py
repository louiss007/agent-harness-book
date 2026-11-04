from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path
from typing import Any

from ..context import ContextBudget
from ..permissions import ApprovalResult
from ..permissions import ApprovalRequest, Approver
from ..provider import ScriptedProvider, response
from ..runtime import HarnessConfig, MiniCoder, make_demo_hooks
from ..trace import build_trace, summarize
from ..types import ToolCall
from .dataset import resolve_refs
from .types import CheckResult, EvalResult, EvalTask


CHECK_ORDER = (
    "reason",
    "files",
    "files_unchanged",
    "tools_ok",
    "tools_failed",
    "tools_blocked",
    "compactions_min",
    "answer_contains",
    "required_tools",
    "trace_no_secret",
    "trace_has_mask",
)


class EvalApprover:
    def __init__(self, allow_write: tuple[str, ...]) -> None:
        self.allow_write = set(allow_write)

    def approve(self, request: ApprovalRequest) -> ApprovalResult:
        action = request.action
        if action.tool in {"write_file", "edit_file"} and action.target in self.allow_write:
            return ApprovalResult("allow_once", "eval: 允许写入预设路径")
        if action.tool == "run_command" and action.argv[:1] in (("python3",), ("python",)):
            return ApprovalResult("allow_session", "eval: 本会话允许运行 Python")
        return ApprovalResult("deny", "eval: 其余动作拒绝")


def read_events(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _trace_text(trace: Any) -> str:
    payload = [
        {"name": span.name, "attributes": span.attributes, "events": span.events}
        for span in trace.spans
    ]
    return json.dumps(payload, ensure_ascii=False, sort_keys=True)


def _tool_names(events: list[dict[str, Any]]) -> set[str]:
    names: set[str] = set()
    for event in events:
        if str(event.get("type", "")) in {"tool_intent", "tool_committed", "tool_failed", "tool_blocked"}:
            name = (event.get("data") or {}).get("tool")
            if name:
                names.add(str(name))
    return names


def _file_text(root: Path, relative: str) -> str | None:
    path = root / relative
    return path.read_text(encoding="utf-8") if path.exists() else None


def evaluate_checks(
    task: EvalTask,
    result: Any,
    summary: Any,
    events: list[dict[str, Any]],
    trace: Any,
    baseline: dict[str, str],
    workspace: Path,
) -> list[CheckResult]:
    checks: list[CheckResult] = []
    spec = task.checks

    for name in CHECK_ORDER:
        if name not in spec:
            continue
        expected = spec[name]

        if name == "reason":
            checks.append(CheckResult(name, result.reason.value == expected, result.reason.value))
        elif name == "files":
            ok = True
            details: list[str] = []
            for relative, needles in dict(expected).items():
                text = _file_text(workspace, relative)
                if text is None:
                    ok = False
                    details.append(f"{relative}=missing")
                    continue
                missing = [needle for needle in needles if needle not in text]
                if missing:
                    ok = False
                    details.append(f"{relative} missing: {','.join(missing)}")
                else:
                    details.append(f"{relative}=ok")
            checks.append(CheckResult(name, ok, "; ".join(details)))
        elif name == "files_unchanged":
            ok = True
            details = []
            for relative in expected:
                text = _file_text(workspace, relative)
                unchanged = text is not None and text == baseline.get(relative)
                ok = ok and unchanged
                details.append(f"{relative}={'unchanged' if unchanged else 'changed'}")
            checks.append(CheckResult(name, ok, "; ".join(details)))
        elif name in {"tools_ok", "tools_failed", "tools_blocked"}:
            attribute = {"tools_ok": "tool_ok", "tools_failed": "tool_failed", "tools_blocked": "tool_blocked"}[name]
            actual = int(getattr(summary, attribute))
            checks.append(
                CheckResult(name, actual == int(expected), f"expected={int(expected)} actual={actual}")
            )
        elif name == "compactions_min":
            actual = int(summary.compactions)
            checks.append(
                CheckResult(name, actual >= int(expected), f"expected>={int(expected)} actual={actual}")
            )
        elif name == "answer_contains":
            found = str(expected) in result.answer
            checks.append(CheckResult(name, found, "found" if found else "not_found"))
        elif name == "required_tools":
            used = _tool_names(events)
            missing = [tool for tool in expected if tool not in used]
            detail = "missing: " + ",".join(missing) if missing else ",".join(str(tool) for tool in expected)
            checks.append(CheckResult(name, not missing, detail))
        elif name == "trace_no_secret":
            leaked = "sk-live-123" in _trace_text(trace)
            ok = (not leaked) == bool(expected)
            checks.append(CheckResult(name, ok, "leaked" if leaked else "clean"))
        elif name == "trace_has_mask":
            masked = "sk-***" in _trace_text(trace)
            ok = masked == bool(expected)
            checks.append(CheckResult(name, ok, "masked" if masked else "missing"))

    return checks


async def run_task(task: EvalTask, fixtures_root: str | Path) -> EvalResult:
    root = Path(tempfile.mkdtemp(prefix=f"minicoder-eval-{task.id}-"))
    host = root / "workspace"
    fixture = Path(fixtures_root) / task.fixture
    shutil.copytree(fixture, host)
    baseline = {
        path.relative_to(host).as_posix(): path.read_text(encoding="utf-8")
        for path in host.rglob("*")
        if path.is_file()
    }

    responses = []
    for turn in task.script:
        if "calls" in turn:
            calls = [
                ToolCall(
                    str(call["id"]),
                    str(call["name"]),
                    dict(resolve_refs(call.get("args") or {}, fixtures_root)),
                )
                for call in turn["calls"]
            ]
            responses.append(response("", calls))
        else:
            responses.append(response(str(turn.get("text", ""))))

    budget = ContextBudget(**task.budget) if task.budget else ContextBudget()
    coder = MiniCoder(
        HarnessConfig(
            workspace=host,
            session_id=f"eval-{task.id}",
            budget=budget,
            keep_sandbox_workspace=False,
        ),
        ScriptedProvider(responses),
        approver=EvalApprover(task.allow_write),
        hooks=make_demo_hooks(),
    )
    result = await coder.run(task.goal, constraints=task.constraints)
    events = read_events(coder.store.events_path)
    trace = build_trace(events, session_id=f"eval-{task.id}")
    summary = summarize(
        trace,
        input_tokens=result.usage.input_tokens,
        output_tokens=result.usage.output_tokens,
    )
    checks = evaluate_checks(task, result, summary, events, trace, baseline, coder.ws.root)
    record = EvalResult(
        task_id=task.id,
        passed=all(check.ok for check in checks),
        checks=checks,
        reason=result.reason.value,
        turns=result.turns,
        tools_ok=summary.tool_ok,
        tools_failed=summary.tool_failed,
        tools_blocked=summary.tool_blocked,
        compactions=summary.compactions,
        input_tokens=result.usage.input_tokens,
        output_tokens=result.usage.output_tokens,
        answer=result.answer,
    )
    coder.close()
    shutil.rmtree(root, ignore_errors=True)
    return record


async def run_suite(tasks: list[EvalTask], fixtures_root: str | Path) -> list[EvalResult]:
    return [await run_task(task, fixtures_root) for task in tasks]
