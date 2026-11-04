from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional

SECRET = re.compile(r"sk-[A-Za-z0-9_-]+")
SENSITIVE_KEYS = ("token", "secret", "password", "authorization", "api_key", "apikey")


@dataclass
class Span:
    trace_id: str
    span_id: str
    parent_span_id: Optional[str]
    name: str
    kind: str
    scope: str
    start_seq: int
    end_seq: int = 0
    status: str = "ok"
    attributes: dict[str, Any] = field(default_factory=dict)
    events: list[dict[str, Any]] = field(default_factory=list)

    def close(self, seq: int, status: str = "ok", **attributes: Any) -> None:
        self.end_seq = seq
        self.status = status
        self.attributes.update(attributes)


@dataclass
class Trace:
    trace_id: str
    session_id: str
    root_span_id: str
    spans: list[Span]

    def span(self, span_id: str) -> Optional[Span]:
        return next((item for item in self.spans if item.span_id == span_id), None)

    def children(self, span_id: str) -> list[Span]:
        return [item for item in self.spans if item.parent_span_id == span_id]


@dataclass
class TraceSummary:
    turns: int = 0
    tool_attempts: int = 0
    tool_ok: int = 0
    tool_failed: int = 0
    tool_blocked: int = 0
    approvals: int = 0
    approval_wait: int = 0
    compactions: int = 0
    subagents: int = 0
    reason: str = ""
    input_tokens: int = 0
    output_tokens: int = 0

    @property
    def tool_success_rate(self) -> float:
        return self.tool_ok / self.tool_attempts if self.tool_attempts else 0.0


def _span_id(trace_id: str, scope: str, seq: int, kind: str, counter: int) -> str:
    raw = f"{trace_id}|{scope}|{seq}|{kind}|{counter}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


def trace_id_for(session_id: str) -> str:
    # 子会话沿用父会话的 trace：去掉 `--<delegation_id>` 后缀。
    root = session_id.split("--", 1)[0]
    return hashlib.sha256(root.encode("utf-8")).hexdigest()[:32]


def traceparent(trace_id: str, span_id: str, sampled: bool = True) -> str:
    if len(trace_id) != 32 or len(span_id) != 16:
        raise ValueError("traceparent 需要 32 位 trace-id 与 16 位 span-id")
    return f"00-{trace_id}-{span_id}-{'01' if sampled else '00'}"


def parse_traceparent(header: str) -> tuple[str, str, bool]:
    version, trace_id, span_id, flags = (header or "").split("-")
    if version != "00" or len(trace_id) != 32 or len(span_id) != 16:
        return "0" * 32, "0" * 16, False
    return trace_id, span_id, bool(int(flags, 16) & 0x01)


def redact_text(text: Any, *, max_chars: int = 160) -> str:
    value = SECRET.sub("sk-***", str(text))
    return value if len(value) <= max_chars else value[:max_chars] + "…"


def redact_args(tool: str, args: dict[str, Any]) -> dict[str, Any]:
    clean: dict[str, Any] = {}
    for key, value in args.items():
        lower = key.lower()
        if lower == "content":
            clean[key] = f"<{len(str(value))} chars>"
        elif any(word in lower for word in SENSITIVE_KEYS):
            clean[key] = "***"
        elif isinstance(value, str):
            clean[key] = redact_text(value)
        elif isinstance(value, (list, tuple)):
            clean[key] = [redact_text(item) if isinstance(item, str) else item for item in value]
        else:
            clean[key] = value
    argv = clean.get("argv")
    if tool == "run_command" and isinstance(argv, list):
        for index, item in enumerate(argv):
            if item in {"--token", "--password", "--api-key"} and index + 1 < len(argv):
                argv[index + 1] = "***"
    return clean


def _status_for_turn(stop: str) -> str:
    if stop in {"no_progress", "budget_exceeded", "cancelled"}:
        return stop
    return "ok"


def _status_for_session(reason: str) -> str:
    return "ok" if reason == "completed" else (reason or "incomplete")


class TraceBuilder:
    """把事件日志投影为 Span 树；只读，不执行任何副作用。"""

    def __init__(
        self,
        trace_id: Optional[str] = None,
        *,
        session_id: str = "",
        root_parent_id: Optional[str] = None,
        create_session_span: bool = True,
    ) -> None:
        self.trace_id = trace_id or trace_id_for(session_id or "session")
        self.session_id = session_id
        self.root_parent_id = root_parent_id
        self.create_session_span = create_session_span
        self.spans: list[Span] = []
        self._counter = 0
        self.root: Optional[Span] = None
        self.task: Optional[Span] = None
        self.turn: Optional[Span] = None
        self.tools: dict[str, Span] = {}
        self.approvals: dict[str, Span] = {}
        self.sandbox: Optional[Span] = None
        self.subagents: dict[str, Span] = {}
        self.commands: list[Span] = []
        self.last_seq = 0

    def _new(
        self,
        name: str,
        kind: str,
        parent: Optional[Span],
        seq: int,
        **attributes: Any,
    ) -> Span:
        self._counter += 1
        span = Span(
            self.trace_id,
            _span_id(self.trace_id, self.session_id or "session", seq, kind, self._counter),
            parent.span_id if parent else self.root_parent_id,
            name,
            kind,
            self.session_id,
            seq,
            attributes=attributes,
        )
        self.spans.append(span)
        return span

    def _parent(self) -> Optional[Span]:
        return self.turn or self.task or self.root

    def _point(self, name: str, seq: int, data: dict[str, Any]) -> None:
        parent = self.turn or self.task or self.root
        target = self.tools and next(reversed(self.tools.values()), None) or parent
        if target is not None:
            target.events.append({"seq": seq, "name": name, "attributes": dict(data)})

    def feed(self, event: dict[str, Any] | Iterable[dict[str, Any]]) -> "TraceBuilder":
        events = [event] if isinstance(event, dict) else list(event)
        for item in events:
            self._feed_one(item)
        return self

    def _feed_one(self, event: dict[str, Any]) -> None:
        typ = str(event.get("type", ""))
        data = dict(event.get("data") or {})
        seq = int(event.get("seq", 0))
        self.last_seq = max(self.last_seq, seq)

        delegation_id = ""
        if typ.startswith("sub:") and typ.count(":") >= 2:
            _, delegation_id, typ = typ.split(":", 2)
        if typ == "tool_finished":
            typ = "tool_committed" if data.get("ok", True) else "tool_failed"
        if not typ:
            return

        if typ == "session_started":
            self.session_id = str(data.get("session_id", self.session_id))
            self.root = self._new(
                "session",
                "session",
                None,
                seq,
                session_id=self.session_id,
                workspace=redact_text(data.get("workspace", "")),
                provider=data.get("provider", ""),
                model=data.get("model", ""),
                permission_profile=data.get("permission_profile", ""),
            )
        elif typ == "task_started":
            if self.root is None:
                self.root = self._new("session", "session", None, seq, synthetic=True)
            self.task = self._new(
                "task",
                "task",
                self.root,
                seq,
                task_id=data.get("task_id", ""),
                goal=redact_text(data.get("goal", "")),
                constraints=[redact_text(item) for item in data.get("constraints", [])],
            )
        elif typ == "turn_started":
            self.turn = self._new(
                "turn",
                "turn",
                self.task or self.root,
                seq,
                turn=data.get("turn", 0),
                estimated_input=data.get("estimated_input", 0),
            )
        elif typ == "turn_finished":
            if self.turn is not None:
                stop = str(data.get("stop", ""))
                self.turn.close(seq, _status_for_turn(stop), tools=data.get("tools", 0), stop=stop or "continued")
                self.turn = None
        elif typ == "tool_intent":
            if delegation_id and self.root_parent_id is None and delegation_id not in self.subagents:
                self.subagents[delegation_id] = self._new(
                    f"subagent.{delegation_id}", "subagent", self._parent(), seq, delegation_id=delegation_id
                )
            parent = self.subagents.get(delegation_id) or self._parent()
            tool = str(data.get("tool", "tool"))
            span = self._new(
                f"tool.{tool}",
                "tool",
                parent,
                seq,
                call_id=data.get("call_id", ""),
                tool=tool,
                args=redact_args(tool, dict(data.get("args") or {})),
                idempotency_key=data.get("idempotency_key", ""),
                session_id=self.session_id,
            )
            self.tools[str(data.get("call_id", ""))] = span
        elif typ == "tool_committed":
            span = self.tools.pop(str(data.get("call_id", "")), None)
            if span is not None:
                span.close(seq, "ok", summary=redact_text(data.get("summary", "")))
        elif typ == "tool_failed":
            span = self.tools.pop(str(data.get("call_id", "")), None)
            if span is not None:
                span.close(seq, "error", error=redact_text(data.get("error", "")))
        elif typ == "tool_blocked":
            parent = self._parent()
            span = self._new(
                f"tool.{data.get('tool', 'tool')}",
                "tool",
                parent,
                seq,
                call_id=data.get("call_id", ""),
                tool=data.get("tool", ""),
                blocked=True,
            )
            span.close(seq, "blocked", reason=redact_text(data.get("reason", "")))
        elif typ == "permission_requested":
            action_id = str(data.get("action_id", ""))
            span = self._new(
                f"approval.{data.get('tool', 'tool')}",
                "approval",
                self.tools and next(reversed(self.tools.values()), None) or self._parent(),
                seq,
                action_id=action_id,
                tool=data.get("tool", ""),
                target=redact_text(data.get("target", "")),
                risk=data.get("risk", ""),
            )
            self.approvals[action_id] = span
        elif typ == "permission_decided":
            action_id = str(data.get("action_id", ""))
            span = self.approvals.pop(action_id, None)
            if span is None:
                span = self._new(
                    f"approval.{data.get('tool', 'tool')}",
                    "approval",
                    self.tools and next(reversed(self.tools.values()), None) or self._parent(),
                    seq,
                    action_id=action_id,
                    tool=data.get("tool", ""),
                    risk=data.get("risk", ""),
                )
            kind = str(data.get("kind", "allow"))
            span.close(seq, "denied" if kind == "deny" else "ok", decision=kind, rule=data.get("rule", ""))
        elif typ == "context_compacted":
            span = self._new(
                "compaction",
                "compaction",
                self._parent(),
                seq,
                before_tokens=data.get("before_tokens", 0),
                after_tokens=data.get("after_tokens", 0),
                kept_recent=data.get("kept_recent", 0),
            )
            span.close(seq, "degraded" if data.get("degraded") else "ok")
        elif typ == "hook_finished":
            self._point("hook_finished", seq, data)
        elif typ == "command_invoked":
            self._point("command_invoked", seq, data)
        elif typ == "skill_loaded":
            self._point("skill_loaded", seq, data)
        elif typ == "sandbox_created":
            self.sandbox = self._new(
                "sandbox", "sandbox", self.root, seq, sandbox_id=data.get("sandbox_id", ""), backend=data.get("backend", "")
            )
        elif typ == "sandbox_destroyed":
            if self.sandbox is not None:
                self.sandbox.close(seq, "ok", runs=data.get("runs", 0))
                self.sandbox = None
        elif typ == "command_started":
            parent = next(reversed(self.tools.values()), None) or self.sandbox or self._parent()
            argv = [redact_text(item) for item in data.get("argv", [])]
            span = self._new(
                "command",
                "command",
                parent,
                seq,
                argv=argv,
                executable=argv[0] if argv else "shell",
                cwd=redact_text(data.get("cwd", "")),
                sandbox_id=data.get("sandbox_id", ""),
            )
            self.commands.append(span)
        elif typ == "command_finished":
            if self.commands:
                span = self.commands.pop()
                ok = data.get("exit_code") == 0 and not data.get("timed_out")
                span.close(
                    seq,
                    "ok" if ok else "error",
                    exit_code=data.get("exit_code"),
                    timed_out=bool(data.get("timed_out")),
                    duration_ms=data.get("duration_ms", 0),
                    stdout_chars=data.get("stdout_chars", 0),
                    stderr_chars=data.get("stderr_chars", 0),
                )
        elif typ == "subagent_dispatched":
            delegation = str(data.get("delegation_id", delegation_id))
            span = self._new(
                f"subagent.{data.get('role', delegation)}",
                "subagent",
                self._parent(),
                seq,
                delegation_id=delegation,
                role=data.get("role", ""),
                tools=list(data.get("tools", [])),
            )
            self.subagents[delegation] = span
        elif typ == "subagent_returned":
            delegation = str(data.get("delegation_id", delegation_id))
            span = self.subagents.pop(delegation, None)
            if span is not None:
                status = str(data.get("status", "completed"))
                span.close(
                    seq,
                    "ok" if status == "completed" else ("error" if status == "invalid_artifact" else status),
                    result_status=status,
                    ok=bool(data.get("ok", False)),
                )
        elif typ == "state_changed":
            self._point("state_changed", seq, data)
        elif typ == "loop_stopped":
            self._point("loop_stopped", seq, data)
        elif typ == "checkpoint":
            self._point("checkpoint", seq, data)
        elif typ == "session_ended":
            reason = str(data.get("reason", ""))
            self._point("session_ended", seq, data)
            if self.turn is not None:
                self.turn.close(seq, "incomplete")
                self.turn = None
            if self.task is not None:
                self.task.close(seq, _status_for_session(reason), turns=data.get("turns", 0))
            if self.root is not None:
                self.root.close(
                    seq,
                    _status_for_session(reason),
                    reason=reason,
                    turns=data.get("turns", 0),
                    tool_calls=data.get("tool_calls", 0),
                )
        else:
            self._point(typ, seq, data)

    def finish(self) -> Trace:
        seq = max(self.last_seq, 1)
        for span in self.spans:
            if span.end_seq == 0:
                span.close(seq, "incomplete")
        if self.root is None and self.create_session_span:
            self.root = self._new("session", "session", None, seq, synthetic=True)
        root_id = self.root.span_id if self.root is not None else (self.root_parent_id or "")
        return Trace(self.trace_id, self.session_id, root_id, self.spans)


def build_trace(events: Iterable[dict[str, Any]], *, session_id: str = "", trace_id: Optional[str] = None) -> Trace:
    builder = TraceBuilder(trace_id, session_id=session_id)
    builder.feed(list(events))
    return builder.finish()


def merge_child(
    trace: Trace,
    delegation_id: str,
    events: Iterable[dict[str, Any]],
    *,
    role: str = "worker",
) -> int:
    """把子会话事件合并进父 trace；子 Span 挂在对应 subagent Span 下。"""
    parent = next(
        (span for span in trace.spans if span.kind == "subagent" and span.attributes.get("delegation_id") == delegation_id),
        None,
    )
    base = max([span.end_seq for span in trace.spans] + [span.start_seq for span in trace.spans])
    if parent is None:
        task = next((span for span in trace.spans if span.kind == "task"), None) or trace.span(trace.root_span_id)
        parent = Span(
            trace.trace_id,
            _span_id(trace.trace_id, "merge", base, "subagent", len(trace.spans)),
            task.span_id if task else None,
            f"subagent.{role}",
            "subagent",
            "merge",
            base,
            attributes={"delegation_id": delegation_id, "role": role, "synthetic": True},
        )
        trace.spans.append(parent)
    shifted = [{**event, "seq": base + int(event.get("seq", 0))} for event in events]
    builder = TraceBuilder(
        trace.trace_id,
        session_id=f"{trace.session_id}--{delegation_id}",
        root_parent_id=parent.span_id,
        create_session_span=False,
    )
    builder.feed(shifted)
    child = builder.finish()
    trace.spans.extend(child.spans)
    end = max([parent.end_seq] + [span.end_seq for span in child.spans])
    parent.close(end, "ok")
    return len(child.spans)


def _inside_subagent(span: Span, by_id: dict[str, Span]) -> bool:
    current: Optional[Span] = span
    while current is not None and current.parent_span_id:
        current = by_id.get(current.parent_span_id)
        if current is not None and current.kind == "subagent":
            return True
    return False


def summarize(trace: Trace, *, input_tokens: int = 0, output_tokens: int = 0) -> TraceSummary:
    by_id = {span.span_id: span for span in trace.spans}
    main = [span for span in trace.spans if not _inside_subagent(span, by_id)]
    tools = [span for span in main if span.kind == "tool"]
    approvals = [span for span in main if span.kind == "approval"]
    root = trace.span(trace.root_span_id)
    return TraceSummary(
        turns=sum(1 for span in main if span.kind == "turn"),
        tool_attempts=len(tools),
        tool_ok=sum(1 for span in tools if span.status == "ok"),
        tool_failed=sum(1 for span in tools if span.status == "error"),
        tool_blocked=sum(1 for span in tools if span.status == "blocked"),
        approvals=len(approvals),
        approval_wait=sum(1 for span in approvals if span.end_seq > span.start_seq),
        compactions=sum(1 for span in main if span.kind == "compaction"),
        subagents=sum(1 for span in trace.spans if span.kind == "subagent"),
        reason=str(root.attributes.get("reason", "")) if root else "",
        input_tokens=input_tokens,
        output_tokens=output_tokens,
    )


def render_tree(trace: Trace) -> list[str]:
    depths = {trace.root_span_id: 0}
    for span in trace.spans:
        if span.span_id not in depths:
            depths[span.span_id] = depths.get(span.parent_span_id or "", 0) + 1 if span.parent_span_id else 0
    lines: list[str] = []
    for span in trace.spans:
        indent = "  " * depths.get(span.span_id, 0)
        lines.append(f"{indent}{span.name:<24} {span.status:<10} seq={span.start_seq}..{span.end_seq}")
    return lines


def replay(trace: Trace, *, limit: int = 20) -> list[str]:
    rows: list[tuple[int, int, str]] = []
    for index, span in enumerate(trace.spans):
        rows.append((span.start_seq, index, f"{span.name} start status={span.status}"))
        if span.end_seq:
            rows.append((span.end_seq, index + 1000, f"{span.name} end status={span.status}"))
        for item in span.events:
            rows.append((int(item["seq"]), index + 2000, f"{span.name} event={item['name']}"))
    rows.sort()
    lines = [f"{seq:>3} {text}" for seq, _, text in rows]
    return lines[:limit]
