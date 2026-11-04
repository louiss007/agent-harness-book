from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional, Protocol, Sequence

from .types import Message, ModelResponse


def _is_cjk(ch: str) -> bool:
    code = ord(ch)
    return 0x3400 <= code <= 0x9FFF or 0xF900 <= code <= 0xFAFF


def estimate_tokens(text: str) -> int:
    if not text:
        return 1
    cjk = sum(1 for ch in text if _is_cjk(ch))
    other = len(text) - cjk
    return max(1, cjk + math.ceil(other / 4)) + 4


@dataclass(frozen=True)
class ContextBudget:
    window: int = 4000
    output_reserve: int = 700
    safety_margin: int = 120
    tool_result_cap: int = 500
    compact_at: float = 0.85

    @property
    def usable_input(self) -> int:
        return self.window - self.output_reserve - self.safety_margin

    @property
    def compact_threshold(self) -> int:
        return int(self.usable_input * self.compact_at)


@dataclass
class BuildReport:
    messages: list[Message]
    estimated_tokens: int
    fixed_tokens: int
    history_tokens: int
    dropped: int
    externalized: list[str]


class ContextBuilder:
    def __init__(
        self,
        budget: ContextBudget,
        *,
        system_prompt: str,
        tool_specs: str,
        memory: str = "",
        workspace: Path,
    ) -> None:
        self.budget = budget
        self.system_prompt = system_prompt
        self.tool_specs = tool_specs
        self.memory = memory
        self.workspace = workspace
        self.external_dir = workspace / ".minicoder" / "observations"

    def assemble(self, history: Sequence[Message]) -> BuildReport:
        fixed = [Message("system", self.system_prompt)]
        if self.tool_specs:
            fixed.append(Message("system", self.tool_specs))
        if self.memory:
            fixed.append(Message("system", self.memory))
        fixed_tokens = sum(estimate_tokens(m.content) for m in fixed)
        allowance = self.budget.usable_input - fixed_tokens

        kept: list[Message] = []
        used = 0
        dropped = 0
        externalized: list[str] = []
        for message in reversed(history):
            content = message.content
            tokens = estimate_tokens(content)
            if message.role == "tool" and tokens > self.budget.tool_result_cap:
                content, rel = self._externalize(message, content, len(externalized))
                tokens = estimate_tokens(content)
                externalized.append(rel)
            if used + tokens > allowance:
                dropped = len(history) - len(kept)
                break
            kept.append(Message(message.role, content, message.tool_call_id, message.tool_calls))
            used += tokens
        kept.reverse()
        return BuildReport(fixed + kept, fixed_tokens + used, fixed_tokens, used, dropped, externalized)

    def _externalize(self, message: Message, content: str, index: int) -> tuple[str, str]:
        self.external_dir.mkdir(parents=True, exist_ok=True)
        name = f"{message.tool_call_id or 'observation'}-{index}.txt"
        path = self.external_dir / name
        path.write_text(content, encoding="utf-8")
        rel = path.relative_to(self.workspace).as_posix()
        head = "\n".join(content.splitlines()[:5])
        preview = f"[观察已外置] 原始 {len(content)} 字符，写入 {rel}。前 5 行：\n{head}\n需要时用 read_file 分段读取。"
        return preview, rel


def needs_compaction(history: Sequence[Message], budget: ContextBudget, fixed_tokens: int = 0) -> bool:
    return sum(estimate_tokens(m.content) for m in history) + fixed_tokens > budget.compact_threshold


SUMMARY_PROMPT = (
    "你是上下文压缩器。把给定历史压缩成不超过 200 字的摘要，必须保留：\n"
    "1. 任务目标与硬约束；2. 已完成的修改与验证结果；3. 当前计划与未决问题；\n"
    "4. 失败原因与下一步。不要编造未发生的事实。"
)

_MARKERS = ("目标", "约束", "下一步")


@dataclass
class CompactionResult:
    messages: list[Message]
    summary: str
    before_tokens: int
    after_tokens: int
    kept_recent: int
    degraded: bool
    transcript_path: str


def _render(message: Message) -> str:
    if message.role == "tool":
        return f"[tool {message.tool_call_id or ''}] {message.content}"
    return f"[{message.role}] {message.content}"


def _fallback(messages: Sequence[Message]) -> str:
    users = [m.content for m in messages if m.role == "user"]
    last = users[-1][:120] if users else "（无用户消息）"
    return f"摘要生成失败，已降级。最近用户输入：{last}。请以工作区与验证结果为准。"


def _validate(summary: str, limit: int) -> tuple[str, bool]:
    text = summary.strip()
    degraded = False
    if len(text) > limit:
        text = text[:limit] + "…"
        degraded = True
    missing = [marker for marker in _MARKERS if marker not in text]
    if missing:
        degraded = True
        text += "\n[校验提示] 摘要缺少：" + "、".join(missing)
    return text, degraded


async def compact(
    history: Sequence[Message],
    budget: ContextBudget,
    provider: Any,
    *,
    workspace: Path,
    keep_recent: int = 4,
    transcript_path: Optional[Path] = None,
) -> CompactionResult:
    before = sum(estimate_tokens(m.content) for m in history)
    recent = list(history[-keep_recent:])
    older = list(history[:-keep_recent])
    path = transcript_path or (workspace / ".minicoder" / "transcript.jsonl")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        for message in older:
            handle.write(json.dumps(
                {"role": message.role, "content": message.content, "tool_call_id": message.tool_call_id},
                ensure_ascii=False,
            ) + "\n")
    try:
        transcript_rel = path.resolve().relative_to(workspace.resolve()).as_posix()
    except ValueError:
        transcript_rel = str(path)

    if not older:
        return CompactionResult(list(history), "", before, before, len(recent), False, transcript_rel)

    prompt = [Message("system", SUMMARY_PROMPT), Message("user", "\n".join(_render(m) for m in older))]
    degraded = False
    try:
        response: ModelResponse = await provider.complete(prompt, ())
        summary, degraded = _validate(response.text, max(80, budget.usable_input // 6))
        if not summary:
            raise ValueError("empty summary")
    except Exception:
        summary = _fallback(older)
        degraded = True

    summary_message = Message("system", f"[压缩摘要]\n{summary}\n[完整历史] {transcript_rel}")
    new_history = [summary_message] + recent
    after = sum(estimate_tokens(m.content) for m in new_history)
    return CompactionResult(new_history, summary, before, after, len(recent), degraded, transcript_rel)
