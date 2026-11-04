from __future__ import annotations

import fnmatch
import hashlib
import json
from dataclasses import dataclass
from enum import Enum
from typing import Any, Protocol
from urllib.parse import urlparse

from .tools import Tool, ToolFailure, Workspace


class Risk(str, Enum):
    READ = "read"
    WRITE = "write"
    DESTRUCTIVE = "destructive"
    EXTERNAL = "external"


_RANK = {Risk.READ: 0, Risk.WRITE: 1, Risk.DESTRUCTIVE: 2, Risk.EXTERNAL: 3}


class Effect(str, Enum):
    ALLOW = "allow"
    ASK = "ask"
    DENY = "deny"


class DecisionKind(str, Enum):
    ALLOW = "allow"
    ASK = "ask"
    DENY = "deny"


_KIND = {Effect.ALLOW: DecisionKind.ALLOW, Effect.ASK: DecisionKind.ASK, Effect.DENY: DecisionKind.DENY}


def hash_action(tool: str, args: dict[str, Any]) -> str:
    canonical = json.dumps(args, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(f"{tool}|{canonical}".encode("utf-8")).hexdigest()[:12]


_DESTRUCTIVE = (
    ("rm", "-rf"),
    ("git", "push", "--force"),
    ("sudo",),
    ("mkfs",),
    ("dd",),
    ("shutdown",),
    ("reboot",),
)
_EXTERNAL = (("curl",), ("wget",), ("ssh",), ("scp",), ("git", "clone"), ("pip", "install"))


def derive_risk(tool: Tool, args: dict[str, Any]) -> Risk:
    """有效风险：工具声明与实参推导取较高者，绝不降低。"""
    risk = Risk(tool.risk)
    if tool.spec.name == "run_command":
        argv = tuple(str(part) for part in args.get("argv", ()))
        if any(argv[: len(prefix)] == prefix for prefix in _DESTRUCTIVE):
            risk = max(risk, Risk.DESTRUCTIVE, key=_RANK.__getitem__)
        if any(argv[: len(prefix)] == prefix for prefix in _EXTERNAL):
            risk = max(risk, Risk.EXTERNAL, key=_RANK.__getitem__)
    if tool.spec.name.startswith("fetch_"):
        risk = max(risk, Risk.EXTERNAL, key=_RANK.__getitem__)
    return risk


def action_from_tool(tool: Tool, args: dict[str, Any], ws: Workspace) -> "Action":
    target = ""
    argv: tuple[str, ...] = ()
    if tool.spec.name in {"read_file", "write_file", "edit_file"}:
        path = ws.resolve(args.get("path"))
        target = path.relative_to(ws.root).as_posix()
    elif tool.spec.name == "run_command":
        argv = tuple(str(part) for part in args.get("argv", ()))
        target = " ".join(argv)
    elif tool.spec.name.startswith("fetch_"):
        target = (urlparse(str(args.get("url", ""))).hostname or "").lower()
    risk = derive_risk(tool, args)
    return Action(
        tool=tool.spec.name,
        args=dict(args),
        risk=risk,
        target=target,
        argv=argv,
        reversible=risk != Risk.DESTRUCTIVE,
    )


@dataclass(frozen=True)
class Action:
    tool: str
    args: dict[str, Any]
    risk: Risk
    target: str
    argv: tuple[str, ...] = ()
    reversible: bool = True
    claimed: str = ""

    @property
    def id(self) -> str:
        return hash_action(self.tool, self.args)


@dataclass(frozen=True)
class Rule:
    name: str
    effect: Effect
    tools: tuple[str, ...] = ("*",)
    risks: tuple[Risk, ...] = ()
    path_glob: str = ""
    command_prefix: tuple[str, ...] = ()
    reason: str = ""

    def matches(self, action: Action) -> bool:
        if "*" not in self.tools and action.tool not in self.tools:
            return False
        if self.risks and action.risk not in self.risks:
            return False
        if self.path_glob and not fnmatch.fnmatch(action.target, self.path_glob):
            return False
        if self.command_prefix and action.argv[: len(self.command_prefix)] != self.command_prefix:
            return False
        return True


@dataclass(frozen=True)
class Decision:
    kind: DecisionKind
    rule: str
    reason: str
    risk: Risk
    target: str


@dataclass(frozen=True)
class Policy:
    rules: tuple[Rule, ...]
    default: Effect = Effect.DENY

    def evaluate(self, action: Action) -> Decision:
        matched = [rule for rule in self.rules if rule.matches(action)]
        for effect in (Effect.DENY, Effect.ASK, Effect.ALLOW):
            for rule in matched:
                if rule.effect == effect:
                    return Decision(_KIND[effect], rule.name, rule.reason, action.risk, action.target)
        return Decision(_KIND[self.default], "default", "没有匹配的规则，按默认拒绝处理", action.risk, action.target)


@dataclass(frozen=True)
class Grant:
    tool: str
    target: str
    expires_at: int
    rule: str

    def covers(self, action: Action, now: int) -> bool:
        return self.tool == action.tool and self.target == action.target and now < self.expires_at


@dataclass(frozen=True)
class ApprovalRequest:
    action: Action
    reason: str
    deadline: int
    options: tuple[str, ...] = ("allow_once", "allow_session", "deny")

    def render(self) -> str:
        real = " ".join(self.action.argv) if self.action.argv else self.action.target
        return "\n".join(
            [
                f"审批请求 #{self.action.id}",
                f"  工具: {self.action.tool}  风险: {self.action.risk.value}",
                f"  真实动作: {real}",
                f"  目标: {self.action.target}  可逆: {'true' if self.action.reversible else 'false'}",
                f"  原因: {self.reason}",
            ]
        )


@dataclass(frozen=True)
class ApprovalResult:
    decision: str
    note: str = ""


class Approver(Protocol):
    def approve(self, request: ApprovalRequest) -> ApprovalResult: ...


class HeadlessApprover:
    """无交互环境：所有 ask 一律拒绝，不允许静默放行。"""

    def approve(self, request: ApprovalRequest) -> ApprovalResult:
        return ApprovalResult("deny", "headless: no interactive approver")


@dataclass
class AuditRecord:
    seq: int
    action_id: str
    tool: str
    target: str
    risk: str
    decision: str
    rule: str
    approver: str
    reason: str


class PermissionEngine:
    def __init__(self, policy: Policy, approver: Approver, *, session_ttl: int = 10) -> None:
        self.policy = policy
        self.approver = approver
        self.session_ttl = session_ttl
        self.tick = 0
        self.grants: list[Grant] = []
        self.records: list[AuditRecord] = []

    def _record(self, action: Action, decision: str, rule: str, approver: str, reason: str) -> None:
        self.records.append(
            AuditRecord(
                seq=len(self.records) + 1,
                action_id=action.id,
                tool=action.tool,
                target=action.target,
                risk=action.risk.value,
                decision=decision,
                rule=rule,
                approver=approver,
                reason=reason,
            )
        )

    def _grant(self, action: Action) -> Decision | None:
        for grant in self.grants:
            if grant.covers(action, self.tick):
                return Decision(DecisionKind.ALLOW, f"grant:{grant.rule}", "会话授权仍然有效", action.risk, action.target)
        return None

    def check(self, action: Action) -> Decision:
        decision = self.policy.evaluate(action)
        if decision.kind == DecisionKind.DENY:
            return decision
        grant = self._grant(action)
        return grant if grant is not None else decision

    def authorize(self, action: Action) -> Decision:
        decision = self.check(action)
        if decision.kind == DecisionKind.ALLOW:
            self._record(action, "allow", decision.rule, "policy", decision.reason)
            return decision
        if decision.kind == DecisionKind.DENY:
            self._record(action, "deny", decision.rule, "policy", decision.reason)
            return decision

        request = ApprovalRequest(action, decision.reason, deadline=self.tick + 5)
        result = self.approver.approve(request)
        if result.decision == "allow_once":
            self._record(action, "approve_once", decision.rule, "human", result.note)
            return Decision(DecisionKind.ALLOW, "approval:once", "人工单次批准", action.risk, action.target)
        if result.decision == "allow_session":
            self.grants.append(Grant(action.tool, action.target, self.tick + self.session_ttl, decision.rule))
            self._record(action, "approve_session", decision.rule, "human", result.note)
            return Decision(DecisionKind.ALLOW, "approval:session", "人工会话授权", action.risk, action.target)
        if result.decision == "expired":
            self._record(action, "expired", "approval-expired", "timeout", "审批超时，按拒绝处理")
            return Decision(DecisionKind.DENY, "approval-expired", "审批超时", action.risk, action.target)
        self._record(action, "deny_by_human", "approval-denied", "human", result.note)
        return Decision(DecisionKind.DENY, "approval-denied", "人工拒绝", action.risk, action.target)


def default_policy() -> Policy:
    return Policy(
        rules=(
            Rule("protect-secrets", Effect.DENY, path_glob="secrets/*", reason="凭证目录禁止访问"),
            Rule("deny-force-push", Effect.DENY, tools=("run_command",), command_prefix=("git", "push", "--force"), reason="强制推送不可逆"),
            Rule("deny-sudo", Effect.DENY, tools=("run_command",), command_prefix=("sudo",), reason="禁止提权"),
            Rule("read-source", Effect.ALLOW, risks=(Risk.READ,), path_glob="src/*", reason="工作区源码只读"),
            Rule("write-source", Effect.ASK, tools=("write_file", "edit_file"), risks=(Risk.WRITE,), path_glob="src/*", reason="写入工作区源码需确认"),
            Rule("network-review", Effect.ASK, risks=(Risk.EXTERNAL,), reason="外部请求逐次确认"),
            Rule("destructive-review", Effect.ASK, risks=(Risk.DESTRUCTIVE,), reason="破坏性操作需确认"),
            Rule("read-default", Effect.ALLOW, risks=(Risk.READ,), reason="只读操作默认放行"),
        ),
        default=Effect.DENY,
    )


def audit_lines(records: list[AuditRecord]) -> list[str]:
    return [
        f"{r.seq:02d} {r.decision:<14} {r.tool:<12} rule={r.rule}"
        for r in records
    ]
