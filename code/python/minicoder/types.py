from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class FinishReason(str, Enum):
    END_TURN = "end_turn"
    TOOL_USE = "tool_use"
    MAX_TOKENS = "max_tokens"
    CONTENT_FILTER = "content_filter"
    ERROR = "error"


class LoopStopReason(str, Enum):
    COMPLETED = "completed"
    MAX_STEPS = "max_steps"
    NO_PROGRESS = "no_progress"
    BUDGET_EXCEEDED = "budget_exceeded"
    CANCELLED = "cancelled"


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    args: dict[str, Any]


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, Any]


@dataclass
class Message:
    role: str
    content: str = ""
    tool_call_id: Optional[str] = None
    tool_calls: list[ToolCall] = field(default_factory=list)


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


@dataclass
class ModelResponse:
    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish_reason: FinishReason = FinishReason.END_TURN
    usage: Usage = field(default_factory=Usage)


@dataclass
class ToolResult:
    ok: bool
    content: str = ""
    error: Optional[str] = None
    error_code: str = ""
    truncated: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_observation(self) -> str:
        body = self.content if self.ok else f"[{self.error_code}] {self.error}"
        if self.truncated:
            body += "\n[结果已截断；请缩小查询范围或分段读取]"
        return body
