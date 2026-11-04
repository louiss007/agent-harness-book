from __future__ import annotations

from typing import Any, Protocol, Sequence

from .types import Message, ModelResponse, ToolCall, ToolSpec, Usage


class Provider(Protocol):
    async def complete(
        self, messages: Sequence[Message], tools: Sequence[ToolSpec] = (), **options: Any
    ) -> ModelResponse: ...


class ScriptedProvider:
    """离线测试替身：按脚本依次返回响应，不访问网络。"""

    def __init__(self, responses: list[ModelResponse]) -> None:
        self._responses = list(responses)
        self.calls = 0

    async def complete(
        self, messages: Sequence[Message], tools: Sequence[ToolSpec] = (), **options: Any
    ) -> ModelResponse:
        self.calls += 1
        if not self._responses:
            raise RuntimeError("脚本响应已用尽")
        return self._responses.pop(0)


class FixedSummaryProvider:
    """压缩专用：返回固定摘要，避免与主响应脚本互相消耗。"""

    def __init__(self, summary: str) -> None:
        self.summary = summary
        self.calls = 0

    async def complete(
        self, messages: Sequence[Message], tools: Sequence[ToolSpec] = (), **options: Any
    ) -> ModelResponse:
        self.calls += 1
        return ModelResponse(self.summary, usage=Usage(input_tokens=120, output_tokens=40))


def response(
    text: str = "", calls: list[ToolCall] | None = None, *, input_tokens: int = 100, output_tokens: int = 20
) -> ModelResponse:
    from .types import FinishReason

    return ModelResponse(
        text=text,
        tool_calls=list(calls or []),
        finish_reason=FinishReason.TOOL_USE if calls else FinishReason.END_TURN,
        usage=Usage(input_tokens, output_tokens),
    )
