from __future__ import annotations

import json
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Optional

from .commands import Command, CommandError, CommandRegistry
from .context import (
    CompactionResult,
    ContextBudget,
    ContextBuilder,
    compact,
    needs_compaction,
)
from .hooks import Event as HookEvent
from .hooks import Hook, HookRegistry, HookResult
from .permissions import (
    Action,
    ApprovalResult,
    Approver,
    DecisionKind,
    HeadlessApprover,
    PermissionEngine,
    action_from_tool,
    default_policy,
)
from .provider import FixedSummaryProvider, Provider
from .sandbox import SandboxHandle, SandboxSpec, create_sandbox, destroy_sandbox, manifest, run_command
from .session import PendingCall, SessionState, SessionStore, TaskState, idempotency_key
from .tools import Tool, ToolCall, ToolExecutor, ToolFailure, ToolResult, ToolSpec, Workspace, build_registry
from .types import FinishReason, LoopStopReason, Message, ModelResponse, Usage


SYSTEM_PROMPT = """你是 MiniCoder，一个在沙箱工作区内工作的编码助手。

工作方式：
- 先读后改；修改前用 read_file 确认上下文。
- 一次只做一个可验证的动作；写文件后运行命令验证。
- 工具结果里的 [error_code] 是可行动的失败原因，不要忽略。

工具规则：
- 路径一律相对工作区；不要尝试访问工作区之外。
- run_command 只接受 argv 数组，不拼接 shell 字符串。

约束：
- 只修改任务要求的文件；不确定时先问。
- 不要伪造测试结果；完成声明必须附证据。

输出：
- 完成后用一句话总结改了什么、验证结果是什么。"""


@dataclass
class HarnessConfig:
    workspace: Path
    session_id: str = "s-001"
    provider_name: str = "scripted"
    model: str = "demo"
    max_steps: int = 8
    max_identical: int = 2
    budget: ContextBudget = field(
        default_factory=lambda: ContextBudget(window=1000, output_reserve=200, safety_margin=60, compact_at=0.85)
    )
    permission_profile: str = "ask"
    headless: bool = False
    keep_sandbox_workspace: bool = True


@dataclass
class LoopResult:
    reason: LoopStopReason
    answer: str
    messages: list[Message]
    usage: Usage
    turns: int
    tool_calls: int
    compactions: int


class MiniCoder:
    """把 Provider、工具、上下文、会话、权限、沙箱与扩展装配成一个运行时。"""

    def __init__(
        self,
        config: HarnessConfig,
        provider: Provider,
        *,
        approver: Optional[Approver] = None,
        summarizer: Optional[Provider] = None,
        hooks: Optional[HookRegistry] = None,
        commands: Optional[CommandRegistry] = None,
    ) -> None:
        self.config = config
        self.host = Path(config.workspace).resolve()
        self.sandbox: SandboxHandle = create_sandbox(
            SandboxSpec(
                read_only_base=self.host,
                timeout_s=20.0,
                max_output_chars=2000,
                keep_workspace=config.keep_sandbox_workspace,
            )
        )
        self.ws = Workspace(self.sandbox.workspace)
        self.registry = build_registry(self.ws)
        self.registry.register(self._make_run_command())
        self.provider = provider
        self.summarizer = summarizer or FixedSummaryProvider(
            "目标：修复工作区代码；约束：只改 src 下的文件；下一步：运行验证命令。"
        )
        self.hooks = hooks or HookRegistry()
        self.commands = commands or CommandRegistry([])
        self.permissions = PermissionEngine(
            default_policy(),
            approver or HeadlessApprover(),
            session_ttl=10,
        )
        self.store = SessionStore(self.host, config.session_id)
        self.executor = ToolExecutor(self.registry, authorize=self._authorize)
        specs = "\n".join(f"- {spec.name}: {spec.description}" for spec in self.registry.specs())
        self.context = ContextBuilder(
            config.budget,
            system_prompt=SYSTEM_PROMPT,
            tool_specs="可用工具：\n" + specs,
            workspace=self.ws.root,
        )
        self.session = SessionState(
            session_id=config.session_id,
            workspace=str(self.host),
            provider=config.provider_name,
            model=config.model,
            permission_profile="deny" if config.headless else config.permission_profile,
            created_at="2026-11-03T00:00:00Z",
        )
        self.task: Optional[TaskState] = None
        self.compactions = 0
        self.closed = False

    def _make_run_command(self) -> Tool:
        async def handler(args: dict[str, Any]) -> ToolResult:
            result = run_command(self.sandbox, args["argv"], timeout_s=15.0)
            ok = result.exit_code == 0 and not result.timed_out
            return ToolResult(
                ok=ok,
                content=result.to_observation(),
                error=None if ok else "命令执行失败",
                error_code="" if ok else ("timeout" if result.timed_out else "execution_failed"),
                truncated=result.truncated,
                metadata={"sandbox_id": result.sandbox_id, "exit_code": result.exit_code},
            )

        return Tool(
            ToolSpec(
                "run_command",
                "在沙箱内执行 argv 数组形式的命令；默认需要审批。",
                {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["argv"],
                    "properties": {"argv": {"type": "array", "items": {"type": "string"}}},
                },
            ),
            handler,
            parallel_safe=False,
            risk="destructive",
            timeout_s=20.0,
        )

    async def run(self, task: str, *, constraints: tuple[str, ...] = ()) -> LoopResult:
        if self.task is not None:
            raise RuntimeError("一个 MiniCoder 实例只运行一个任务；新任务请新建会话")
        self.task = TaskState("t-001", task, list(constraints))
        history = [Message("user", task)]
        self.store.append("session_started", self.session.to_json())
        self.store.append(
            "task_started",
            {"task_id": self.task.task_id, "goal": task, "constraints": list(constraints)},
        )
        start = self.hooks.run(HookEvent.SESSION_START, {"session_id": self.config.session_id, "task": task})
        if start.action == "block":
            return self._finish(LoopStopReason.CANCELLED, "", history, Usage(), "session_start hook blocked")

        usage = Usage()
        answer = ""
        reason = LoopStopReason.MAX_STEPS
        seen: dict[str, int] = {}

        for _ in range(self.config.max_steps):
            report = self.context.assemble(history)
            if needs_compaction(history, self.config.budget, report.fixed_tokens):
                result: CompactionResult = await compact(
                    history,
                    self.config.budget,
                    self.summarizer,
                    workspace=self.host,
                    keep_recent=2,
                    transcript_path=self.store.dir / "transcript.jsonl",
                )
                history = result.messages
                self.compactions += 1
                self.store.append(
                    "context_compacted",
                    {
                        "before_tokens": result.before_tokens,
                        "after_tokens": result.after_tokens,
                        "kept_recent": result.kept_recent,
                        "degraded": result.degraded,
                        "transcript": result.transcript_path,
                    },
                )

            model_hook = self.hooks.run(
                HookEvent.BEFORE_MODEL, {"messages": len(report.messages), "estimated_tokens": report.estimated_tokens}
            )
            if model_hook.action == "block":
                return self._finish(LoopStopReason.CANCELLED, "", history, usage, "before_model hook blocked")

            response: ModelResponse = await self.provider.complete(report.messages, self.registry.specs())
            usage.input_tokens += response.usage.input_tokens
            usage.output_tokens += response.usage.output_tokens
            self.task.turns += 1
            self.store.append("turn_started", {"turn": self.task.turns, "estimated_input": report.estimated_tokens})

            if not response.tool_calls:
                answer = response.text
                history.append(Message("assistant", answer))
                self.store.append("turn_finished", {"turn": self.task.turns, "tools": 0, "stop": "completed"})
                reason = LoopStopReason.COMPLETED
                break

            history.append(Message("assistant", response.text, tool_calls=response.tool_calls))
            results: list[ToolResult] = []
            for call in response.tool_calls:
                result = await self._execute(call)
                results.append(result)
                history.append(Message("tool", result.to_observation(), tool_call_id=call.id))
                if call.name == "write_file" and result.ok:
                    rel = str(result.metadata.get("path", ""))
                    if rel:
                        self.task.record_file(self.ws.root, rel, changed_by="write_file")
                        record = self.task.files[rel]
                        self.store.append(
                            "state_changed",
                            {
                                "kind": "file",
                                "path": rel,
                                "sha256": record.sha256,
                                "size": record.size,
                                "changed_by": "write_file",
                            },
                        )

            self.store.append(
                "turn_finished",
                {"turn": self.task.turns, "tools": len(response.tool_calls), "stop": ""},
            )
            signature = "|".join(
                f"{call.name}:{json.dumps(call.args, sort_keys=True)}:{result.to_observation()[:80]}"
                for call, result in zip(response.tool_calls, results)
            )
            seen[signature] = seen.get(signature, 0) + 1
            if seen[signature] >= self.config.max_identical:
                reason = LoopStopReason.NO_PROGRESS
                break
            if usage.total_tokens >= self.config.budget.window * 4:
                reason = LoopStopReason.BUDGET_EXCEEDED
                break

        return self._finish(reason, answer, history, usage, "")

    def _finish(
        self, reason: LoopStopReason, answer: str, history: list[Message], usage: Usage, detail: str
    ) -> LoopResult:
        assert self.task is not None
        self.store.append("loop_stopped", {"reason": reason.value, "detail": detail})
        self.store.checkpoint(self.task, self.session, reason="run_end")
        self.hooks.run(HookEvent.SESSION_END, {"session_id": self.config.session_id, "reason": reason.value})
        self.store.append(
            "session_ended",
            {"reason": reason.value, "turns": self.task.turns, "tool_calls": self.task.tool_calls},
        )
        return LoopResult(
            reason=reason,
            answer=answer,
            messages=history,
            usage=usage,
            turns=self.task.turns,
            tool_calls=self.task.tool_calls,
            compactions=self.compactions,
        )

    async def _execute(self, call: ToolCall) -> ToolResult:
        pre = self.hooks.run(HookEvent.BEFORE_TOOL, {"tool": call.name, "args": dict(call.args)})
        self.store.append(
            "hook_finished",
            {"event": "before_tool", "action": pre.action, "trace": list(pre.trace)},
        )
        if pre.action == "block":
            self.store.append(
                "tool_blocked",
                {
                    "call_id": call.id,
                    "tool": call.name,
                    "reason": pre.reason,
                    "trace": list(pre.trace),
                },
            )
            return ToolResult(False, error=f"扩展阻断：{pre.reason}", error_code="hook_blocked")
        if pre.action == "modify" and "args" in pre.payload:
            call = replace(call, args=dict(pre.payload["args"]))

        key = idempotency_key(self.config.session_id, call)
        assert self.task is not None
        self.task.pending[call.id] = PendingCall(call.id, call.name, dict(call.args), key)
        self.store.append(
            "tool_intent",
            {"call_id": call.id, "tool": call.name, "args": call.args, "idempotency_key": key},
        )
        result = await self.executor.execute(call)
        if result.ok:
            self.task.complete_call(call.id, result.content[:80])
            self.store.append(
                "tool_committed",
                {"call_id": call.id, "tool": call.name, "summary": result.content[:80]},
            )
        else:
            self.task.pending.pop(call.id, None)
            self.task.last_error = result.to_observation()[:200]
            self.store.append(
                "tool_failed",
                {"call_id": call.id, "tool": call.name, "error": result.to_observation()[:200]},
            )

        post = self.hooks.run(
            HookEvent.AFTER_TOOL,
            {"tool": call.name, "result": result.content, "ok": result.ok},
        )
        self.store.append(
            "hook_finished",
            {"event": "after_tool", "action": post.action, "trace": list(post.trace)},
        )
        if post.action == "modify" and result.ok:
            result = replace(result, content=str(post.payload.get("result", result.content)))
        return result

    def _authorize(self, tool: Tool, args: dict[str, Any]) -> Optional[ToolResult]:
        try:
            action = action_from_tool(tool, args, self.ws)
        except ToolFailure as exc:
            return ToolResult(False, error=str(exc), error_code=exc.code)

        preview = self.permissions.check(action)
        if preview.kind == DecisionKind.ASK:
            self.store.append(
                "permission_requested",
                {"action_id": action.id, "tool": action.tool, "target": action.target, "risk": action.risk.value},
            )
        decision = self.permissions.authorize(action)
        self.store.append(
            "permission_decided",
            {
                "action_id": action.id,
                "tool": action.tool,
                "kind": decision.kind.value,
                "rule": decision.rule,
                "risk": action.risk.value,
            },
        )
        if decision.kind == DecisionKind.ALLOW:
            return None
        return ToolResult(
            False,
            error=f"权限拒绝：{decision.reason}",
            error_code="permission_denied",
            metadata={"action_id": action.id, "rule": decision.rule},
        )

    def changed_files(self) -> list[str]:
        return sorted(self.task.files) if self.task else []

    def close(self) -> dict[str, Any]:
        if self.closed:
            return {"already_closed": True}
        self.closed = True
        return destroy_sandbox(self.sandbox)

    def recover(self):
        return self.store.recover()


def make_demo_hooks() -> HookRegistry:
    registry = HookRegistry()

    def add_unbuffered(payload: dict[str, Any]) -> HookResult:
        args = dict(payload["args"])
        argv = list(args.get("argv", []))
        if argv[:1] in (["python"], ["python3"]) and "-u" not in argv:
            argv.insert(1, "-u")
            return HookResult("modify", {"args": {**args, "argv": argv}})
        return HookResult("continue")

    def block_rm(payload: dict[str, Any]) -> HookResult:
        argv = list(payload["args"].get("argv", []))
        if argv[:2] == ["rm", "-rf"]:
            return HookResult("block", reason="递归删除")
        return HookResult("continue")

    def redact(payload: dict[str, Any]) -> HookResult:
        text = str(payload.get("result", ""))
        if "sk-live-123" in text:
            return HookResult("modify", {"result": text.replace("sk-live-123", "sk-***")})
        return HookResult("continue")

    registry.register(Hook("add-unbuffered", HookEvent.BEFORE_TOOL, add_unbuffered, priority=10))
    registry.register(Hook("block-rm", HookEvent.BEFORE_TOOL, block_rm, priority=20))
    registry.register(Hook("redact-secret", HookEvent.AFTER_TOOL, redact, priority=10))
    return registry
