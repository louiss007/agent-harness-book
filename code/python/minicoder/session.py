from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from .types import ToolCall

SCHEMA_VERSION = 1


@dataclass
class SessionState:
    session_id: str
    workspace: str
    provider: str
    model: str
    permission_profile: str = "ask"
    created_at: str = ""
    budget_used: dict[str, int] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "workspace": self.workspace,
            "provider": self.provider,
            "model": self.model,
            "permission_profile": self.permission_profile,
            "created_at": self.created_at,
            "budget_used": self.budget_used,
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "SessionState":
        return cls(**data)


@dataclass
class FileRecord:
    path: str
    sha256: str
    size: int
    changed_by: str


@dataclass
class PendingCall:
    call_id: str
    tool: str
    args: dict[str, Any]
    idempotency_key: str
    status: str = "intent"


@dataclass
class TaskState:
    task_id: str
    goal: str
    constraints: list[str] = field(default_factory=list)
    files: dict[str, FileRecord] = field(default_factory=dict)
    pending: dict[str, PendingCall] = field(default_factory=dict)
    completed_calls: dict[str, str] = field(default_factory=dict)
    turns: int = 0
    tool_calls: int = 0
    last_error: str = ""
    updated_seq: int = 0

    def to_json(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "goal": self.goal,
            "constraints": self.constraints,
            "files": {
                path: {"path": r.path, "sha256": r.sha256, "size": r.size, "changed_by": r.changed_by}
                for path, r in self.files.items()
            },
            "pending": {
                cid: {
                    "call_id": c.call_id,
                    "tool": c.tool,
                    "args": c.args,
                    "idempotency_key": c.idempotency_key,
                    "status": c.status,
                }
                for cid, c in self.pending.items()
            },
            "completed_calls": self.completed_calls,
            "turns": self.turns,
            "tool_calls": self.tool_calls,
            "last_error": self.last_error,
            "updated_seq": self.updated_seq,
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "TaskState":
        return cls(
            task_id=data["task_id"],
            goal=data["goal"],
            constraints=list(data.get("constraints", [])),
            files={path: FileRecord(**rec) for path, rec in data.get("files", {}).items()},
            pending={cid: PendingCall(**call) for cid, call in data.get("pending", {}).items()},
            completed_calls=dict(data.get("completed_calls", {})),
            turns=data.get("turns", 0),
            tool_calls=data.get("tool_calls", 0),
            last_error=data.get("last_error", ""),
            updated_seq=data.get("updated_seq", 0),
        )

    def record_file(self, root: Path, rel: str, *, changed_by: str) -> None:
        raw = (root / rel).read_bytes()
        self.files[rel] = FileRecord(rel, hashlib.sha256(raw).hexdigest(), len(raw), changed_by)

    def complete_call(self, call_id: str, summary: str) -> None:
        self.pending.pop(call_id, None)
        self.completed_calls[call_id] = summary
        self.tool_calls += 1


@dataclass
class Event:
    seq: int
    type: str
    ts: str
    data: dict[str, Any]
    schema_version: int = SCHEMA_VERSION


# 只用于审计与追踪、不参与状态重建的事件。恢复时忽略，不得标记为未知事件。
AUDIT_EVENTS = {
    "turn_started",
    "loop_stopped",
    "context_compacted",
    "permission_requested",
    "permission_decided",
    "grant_issued",
    "grant_expired",
    "hook_finished",
    "command_invoked",
    "skill_loaded",
    "sandbox_created",
    "command_started",
    "command_finished",
    "tool_blocked",
    "sandbox_destroyed",
    "subagent_dispatched",
    "subagent_returned",
    "session_ended",
}


class SessionStore:
    def __init__(self, root: str | Path, session_id: str) -> None:
        self.root = Path(root).resolve()
        self.session_id = session_id
        self.dir = self.root / ".minicoder" / "sessions" / session_id
        self.dir.mkdir(parents=True, exist_ok=True)
        self.events_path = self.dir / "events.jsonl"
        self.snapshot_path = self.dir / "snapshot.json"
        self.seq = self._last_seq()

    def _last_seq(self) -> int:
        if not self.events_path.exists():
            return 0
        last = 0
        for line in self.events_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                last = json.loads(line)["seq"]
        return last

    def append(self, type_: str, data: dict[str, Any]) -> Event:
        self.seq += 1
        event = Event(self.seq, type_, "2026-11-03T00:00:00Z", data)
        with self.events_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event.__dict__, ensure_ascii=False, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        return event

    def checkpoint(self, state: TaskState, session: SessionState, *, reason: str) -> Event:
        event = self.append("checkpoint", {"reason": reason})
        state.updated_seq = event.seq
        payload = {
            "schema_version": SCHEMA_VERSION,
            "session_id": self.session_id,
            "seq": event.seq,
            "session": session.to_json(),
            "state": state.to_json(),
        }
        tmp = self.snapshot_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True), encoding="utf-8")
        os.replace(tmp, self.snapshot_path)
        return event

    def recover(self) -> "RecoveryReport":
        state: Optional[TaskState] = None
        session: Optional[SessionState] = None
        snapshot_seq = 0
        source = "event_log"
        if self.snapshot_path.exists():
            payload = json.loads(self.snapshot_path.read_text(encoding="utf-8"))
            if payload.get("schema_version") != SCHEMA_VERSION:
                raise ValueError("快照版本不兼容，需先迁移")
            state = TaskState.from_json(payload["state"])
            session = SessionState.from_json(payload["session"])
            snapshot_seq = int(payload["seq"])
            source = "snapshot"
        replayed = 0
        if self.events_path.exists():
            for line in self.events_path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                event = json.loads(line)
                if event["seq"] <= snapshot_seq:
                    continue
                state, session = apply_event(state, session, event)
                replayed += 1
        if state is None or session is None:
            raise ValueError("会话缺少 session_started 或 task_started 事件")
        return RecoveryReport(state, session, source, snapshot_seq, replayed)


@dataclass
class RecoveryReport:
    state: TaskState
    session: SessionState
    source: str
    snapshot_seq: int
    replayed: int


def apply_event(
    state: Optional[TaskState], session: Optional[SessionState], event: dict[str, Any]
) -> tuple[Optional[TaskState], Optional[SessionState]]:
    kind, data, seq = event["type"], event["data"], event["seq"]
    if kind == "session_started":
        return state, SessionState.from_json(data)
    if kind == "task_started":
        state = TaskState(data["task_id"], data["goal"], list(data.get("constraints", [])))
        state.updated_seq = seq
        return state, session
    if state is None:
        return state, session
    if kind == "state_changed":
        change = data["kind"]
        if change == "file":
            state.files[data["path"]] = FileRecord(
                data["path"], data["sha256"], data["size"], data.get("changed_by", "tool")
            )
        elif change == "drift":
            state.last_error = data["message"]
    elif kind == "tool_intent":
        state.pending[data["call_id"]] = PendingCall(
            data["call_id"], data["tool"], data["args"], data["idempotency_key"]
        )
    elif kind == "tool_committed":
        state.complete_call(data["call_id"], data["summary"])
    elif kind == "tool_failed":
        call = state.pending.pop(data["call_id"], None)
        if call is not None:
            call.status = "failed"
        state.last_error = data["error"]
    elif kind == "turn_finished":
        state.turns += 1
    elif kind == "checkpoint":
        pass
    elif kind in AUDIT_EVENTS:
        pass
    else:
        state.last_error = f"未知事件 {kind}，状态可能不完整"
    return state, session


def idempotency_key(session_id: str, call: ToolCall) -> str:
    canonical = json.dumps(call.args, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    raw = f"{session_id}|{call.id}|{call.name}|{canonical}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


def detect_drift(state: TaskState, root: Path) -> list[str]:
    drift: list[str] = []
    for rel, record in state.files.items():
        path = root / rel
        if not path.exists():
            drift.append(f"{rel}:deleted")
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != record.sha256:
            drift.append(f"{rel}:modified")
    return sorted(drift)
