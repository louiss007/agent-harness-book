from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable


class Event(str, Enum):
    SESSION_START = "session_start"
    USER_PROMPT_SUBMIT = "user_prompt_submit"
    BEFORE_MODEL = "before_model"
    AFTER_MODEL = "after_model"
    BEFORE_TOOL = "before_tool"
    AFTER_TOOL = "after_tool"
    SESSION_END = "session_end"


@dataclass(frozen=True)
class HookResult:
    action: str = "continue"
    payload: dict[str, Any] | None = None
    reason: str = ""


Handler = Callable[[dict[str, Any]], HookResult]


@dataclass(frozen=True)
class Hook:
    name: str
    event: Event
    handler: Handler
    priority: int = 100
    critical: bool = False


@dataclass(frozen=True)
class HookOutcome:
    action: str
    payload: dict[str, Any]
    reason: str
    trace: tuple[str, ...]


class HookRegistry:
    def __init__(self) -> None:
        self._hooks: list[Hook] = []
        self.runs = 0
        self.blocks = 0
        self.errors = 0

    def register(self, hook: Hook) -> None:
        self._hooks.append(hook)

    def run(self, event: Event, payload: dict[str, Any]) -> HookOutcome:
        hooks = sorted(
            (h for h in self._hooks if h.event == event),
            key=lambda h: (h.priority, h.name),
        )
        current = dict(payload)
        trace: list[str] = []
        modified = False
        for hook in hooks:
            self.runs += 1
            try:
                result = hook.handler(dict(current))
            except Exception:
                self.errors += 1
                trace.append(f"{hook.name}=error")
                if hook.critical:
                    self.blocks += 1
                    return HookOutcome("block", current, f"{hook.name}:failed", tuple(trace))
                continue
            trace.append(f"{hook.name}={result.action}")
            if result.action == "modify" or result.payload is not None:
                modified = True
            if result.payload is not None:
                current.update(result.payload)
            if result.action == "block":
                self.blocks += 1
                return HookOutcome("block", current, f"{hook.name}:{result.reason}", tuple(trace))
        return HookOutcome("modify" if modified else "continue", current, "", tuple(trace))
