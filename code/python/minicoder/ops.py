"""生产控制层：部署清单、准入、限流、熔断、重试、多 Provider 网关、租约与预授权。

本模块只增加部署期能力，不修改 runtime、Provider、Usage 等既有接口。
它把第 16 章的成本层接进调用路径：路由选模型、准入预扣、调用后结算。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Awaitable, Callable, Optional, Sequence

from .context import estimate_tokens
from .cost import (
    BudgetExceeded,
    BudgetLedger,
    CacheStats,
    CostReport,
    CostUsage,
    ModelCatalog,
    Reservation,
    RouteDecision,
    RouteRequest,
    Router,
    TaskBudget,
)
from .permissions import Action, ApprovalRequest, ApprovalResult, Risk
from .provider import Provider
from .types import Message, ModelResponse, ToolSpec


TOPOLOGIES = ("headless", "service", "worker")
SANDBOX_SCOPES = ("task", "session")


@dataclass(frozen=True)
class TenantPolicy:
    tenant: str
    max_concurrent: int = 1
    requests_per_minute: int = 60
    daily_token_budget: int = 1_000_000
    daily_cost_micros: int = 5_000_000
    sandbox_scope: str = "task"


@dataclass(frozen=True)
class DeploymentManifest:
    version: str
    topology: str
    policy_version: str
    secret_refs: tuple[str, ...]
    tenants: tuple[TenantPolicy, ...]
    canary_percent: int = 0
    headless_preauthorized: bool = False


def validate_manifest(manifest: DeploymentManifest) -> tuple[str, ...]:
    """返回稳定的问题代码；空元组表示可以发布。"""
    issues: list[str] = []
    if manifest.topology not in TOPOLOGIES:
        issues.append("topology")
    if not manifest.version:
        issues.append("version")
    if not manifest.policy_version:
        issues.append("policy-version")
    if not 0 <= manifest.canary_percent <= 100:
        issues.append("canary-percent")
    if not manifest.tenants:
        issues.append("tenants")

    seen: set[str] = set()
    for tenant in manifest.tenants:
        if tenant.tenant in seen:
            issues.append(f"duplicate-tenant:{tenant.tenant}")
        seen.add(tenant.tenant)
        if tenant.sandbox_scope not in SANDBOX_SCOPES:
            issues.append(f"sandbox-scope:{tenant.tenant}")
        if tenant.max_concurrent < 1:
            issues.append(f"concurrency:{tenant.tenant}")
        if tenant.requests_per_minute < 1:
            issues.append(f"rate:{tenant.tenant}")

    for ref in manifest.secret_refs:
        if not ref.startswith(("env:", "vault:", "file:")):
            issues.append(f"secret-ref:{ref}")

    if manifest.topology == "headless" and not manifest.headless_preauthorized:
        issues.append("headless-preauth")
    return tuple(issues)


@dataclass(frozen=True)
class RateDecision:
    allowed: bool
    remaining: int
    retry_after_ms: int = 0


@dataclass
class _Bucket:
    tokens_milli: int
    updated_ms: int


class RateLimiter:
    """整数毫 token 的令牌桶；按请求计数，不按 token 计数。"""

    def __init__(self, capacity: int, refill_per_minute: int) -> None:
        if capacity < 1 or refill_per_minute < 1:
            raise ValueError("限流容量与速率必须为正")
        self.capacity_milli = capacity * 1000
        self.refill_per_minute = refill_per_minute
        self._buckets: dict[str, _Bucket] = {}

    def take(self, key: str, tokens: int, now_ms: int) -> RateDecision:
        if tokens < 1:
            raise ValueError("请求数必须为正")
        bucket = self._buckets.get(key)
        if bucket is None:
            bucket = _Bucket(self.capacity_milli, now_ms)
            self._buckets[key] = bucket
        elapsed = max(0, now_ms - bucket.updated_ms)
        refill = (self.refill_per_minute * elapsed) // 60
        available = min(self.capacity_milli, bucket.tokens_milli + refill)
        cost = tokens * 1000
        bucket.updated_ms = now_ms
        if available >= cost:
            bucket.tokens_milli = available - cost
            return RateDecision(True, bucket.tokens_milli // 1000)
        need = cost - available
        retry_after = (need * 60 + self.refill_per_minute - 1) // self.refill_per_minute
        bucket.tokens_milli = available
        return RateDecision(False, available // 1000, retry_after)


@dataclass(frozen=True)
class Admission:
    granted: bool
    tenant: str
    reason: str
    reservation: Optional[Reservation] = None
    retry_after_ms: int = 0
    detail: str = ""


@dataclass
class _TenantState:
    policy: TenantPolicy
    limiter: RateLimiter
    ledger: BudgetLedger
    active: int = 0
    closed: set[int] = field(default_factory=set)


class AdmissionController:
    """并发、限流、预算三件事必须在调用前一起判定。"""

    def __init__(self, catalog: ModelCatalog, policies: Sequence[TenantPolicy]) -> None:
        self.catalog = catalog
        self._states: dict[str, _TenantState] = {}
        for policy in policies:
            if policy.tenant in self._states:
                raise ValueError(f"重复的租户：{policy.tenant}")
            self._states[policy.tenant] = _TenantState(
                policy,
                RateLimiter(policy.requests_per_minute, policy.requests_per_minute),
                BudgetLedger(
                    TaskBudget(
                        policy.daily_cost_micros,
                        policy.daily_token_budget,
                        policy.daily_token_budget,
                    ),
                    catalog,
                ),
            )

    def _state(self, tenant: str) -> _TenantState:
        try:
            return self._states[tenant]
        except KeyError as exc:
            raise ValueError(f"未知租户：{tenant}") from exc

    def active(self, tenant: str) -> int:
        return self._state(tenant).active

    def admit(
        self, tenant: str, model: str, prompt_tokens: int, output_tokens: int, now_ms: int
    ) -> Admission:
        state = self._state(tenant)
        policy = state.policy
        if state.active >= policy.max_concurrent:
            return Admission(
                False, tenant, "concurrency", detail=f"{state.active}/{policy.max_concurrent}"
            )
        rate = state.limiter.take(tenant, 1, now_ms)
        if not rate.allowed:
            return Admission(
                False,
                tenant,
                "rate_limit",
                retry_after_ms=rate.retry_after_ms,
                detail=f"remaining={rate.remaining}",
            )
        try:
            reservation = state.ledger.reserve(
                model, prompt_tokens=prompt_tokens, output_tokens=output_tokens
            )
        except BudgetExceeded as exc:
            return Admission(
                False,
                tenant,
                "budget",
                detail=f"{exc.scope}:{exc.requested}>{exc.remaining}",
            )
        state.active += 1
        return Admission(True, tenant, "admitted", reservation)

    def settle(self, admission: Admission, usage: CostUsage) -> int:
        if not admission.granted or admission.reservation is None:
            raise ValueError("未准入的请求不能结算")
        state = self._state(admission.tenant)
        key = admission.reservation.reservation_id
        if key in state.closed:
            raise RuntimeError("重复结算预算预留")
        state.closed.add(key)
        state.active -= 1
        return state.ledger.settle(admission.reservation, usage)

    def release(self, admission: Admission) -> int:
        if not admission.granted or admission.reservation is None:
            return 0
        state = self._state(admission.tenant)
        key = admission.reservation.reservation_id
        if key in state.closed:
            raise RuntimeError("重复释放预算预留")
        state.closed.add(key)
        state.active -= 1
        return state.ledger.release(admission.reservation)


class BreakerState(str, Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


@dataclass(frozen=True)
class BreakerSnapshot:
    state: BreakerState
    failures: int
    opened_at_ms: int


class CircuitBreaker:
    def __init__(self, failure_threshold: int = 2, cooldown_ms: int = 1_000) -> None:
        if failure_threshold < 1 or cooldown_ms < 0:
            raise ValueError("熔断参数不合法")
        self.failure_threshold = failure_threshold
        self.cooldown_ms = cooldown_ms
        self.state = BreakerState.CLOSED
        self.failures = 0
        self.opened_at_ms = 0
        self._trial = False

    def allow(self, now_ms: int) -> bool:
        if self.state == BreakerState.OPEN:
            if now_ms - self.opened_at_ms < self.cooldown_ms:
                return False
            self.state = BreakerState.HALF_OPEN
            self._trial = False
        if self.state == BreakerState.HALF_OPEN:
            if self._trial:
                return False
            self._trial = True
            return True
        return True

    def record_success(self) -> None:
        self.state = BreakerState.CLOSED
        self.failures = 0
        self.opened_at_ms = 0
        self._trial = False

    def record_failure(self, now_ms: int) -> None:
        self.failures += 1
        self._trial = False
        if self.state == BreakerState.HALF_OPEN or self.failures >= self.failure_threshold:
            self.state = BreakerState.OPEN
            self.opened_at_ms = now_ms

    def snapshot(self) -> BreakerSnapshot:
        return BreakerSnapshot(self.state, self.failures, self.opened_at_ms)


class CallErrorKind(str, Enum):
    TRANSIENT = "transient"
    RATE_LIMITED = "rate_limited"
    TIMEOUT = "timeout"
    PERMANENT = "permanent"


class ModelCallError(RuntimeError):
    def __init__(
        self, kind: CallErrorKind, message: str, *, retry_after_ms: int = 0
    ) -> None:
        self.kind = kind
        self.retry_after_ms = retry_after_ms
        super().__init__(message)


@dataclass(frozen=True)
class RetryPolicy:
    max_attempts: int = 3
    base_ms: int = 200
    max_ms: int = 2_000
    jitter_permille: int = 200

    def retryable(self, kind: CallErrorKind) -> bool:
        return kind in (CallErrorKind.TRANSIENT, CallErrorKind.RATE_LIMITED, CallErrorKind.TIMEOUT)

    def delay_ms(self, attempt: int, seed: int) -> int:
        exponent = min(20, max(0, attempt - 1))
        base = min(self.max_ms, self.base_ms * (1 << exponent))
        noise = (seed * 1_103_515_245 + attempt * 12_345) & 0x7FFFFFFF
        jitter = (base * self.jitter_permille * (noise % 1000)) // 100_000
        return base + jitter


def no_cache(_response: ModelResponse) -> tuple[int, int]:
    return (0, 0)


@dataclass(frozen=True)
class ProviderBinding:
    name: str
    provider: Provider
    models: tuple[str, ...]
    fallbacks: tuple[str, ...] = ()
    cache_reader: Callable[[ModelResponse], tuple[int, int]] = no_cache


class ProviderRegistry:
    def __init__(self) -> None:
        self._by_model: dict[str, ProviderBinding] = {}

    def register(self, binding: ProviderBinding) -> None:
        for model in binding.models:
            if model in self._by_model:
                raise ValueError(f"模型重复注册：{model}")
            self._by_model[model] = binding

    def binding_for(self, model: str) -> ProviderBinding:
        try:
            return self._by_model[model]
        except KeyError as exc:
            raise ValueError(f"没有为模型注册 Provider：{model}") from exc

    def models(self) -> tuple[str, ...]:
        return tuple(sorted(self._by_model))


def _estimate_prompt(messages: Sequence[Message]) -> int:
    return sum(estimate_tokens(message.content) + 4 for message in messages)


async def _default_sleep(ms: int) -> None:
    await asyncio.sleep(ms / 1000)


class GovernedProvider:
    """实现 Provider 协议：路由、准入、重试、熔断、故障转移与成本结算。"""

    def __init__(
        self,
        registry: ProviderRegistry,
        router: Router,
        admission: AdmissionController,
        tenant: str,
        catalog: ModelCatalog,
        cost_report: CostReport,
        *,
        retry: Optional[RetryPolicy] = None,
        breaker_threshold: int = 2,
        breaker_cooldown_ms: int = 1_000,
        clock: Optional[Callable[[], int]] = None,
        sleeper: Optional[Callable[[int], Awaitable[None]]] = None,
        seed: int = 7,
    ) -> None:
        self.registry = registry
        self.router = router
        self.admission = admission
        self.tenant = tenant
        self.catalog = catalog
        self.cost_report = cost_report
        self.retry = retry or RetryPolicy()
        self.breaker_threshold = breaker_threshold
        self.breaker_cooldown_ms = breaker_cooldown_ms
        self.clock = clock or (lambda: 0)
        self.sleeper = sleeper or _default_sleep
        self.seed = seed
        self.current_model = ""
        self.cache = CacheStats()
        self.events: list[dict[str, Any]] = []
        self.breakers: dict[str, CircuitBreaker] = {}

    async def complete(
        self, messages: Sequence[Message], tools: Sequence[ToolSpec] = (), **options: Any
    ) -> ModelResponse:
        prompt_tokens = int(options.get("prompt_tokens") or _estimate_prompt(messages))
        output_tokens = int(options.get("output_tokens") or 512)
        preferred = str(options.get("preferred_model") or "")

        if preferred:
            decision = RouteDecision(
                preferred,
                "pinned",
                "pinned:preferred",
                switched=bool(self.current_model) and preferred != self.current_model,
            )
        else:
            decision = self.router.select(
                RouteRequest(
                    str(options.get("phase", "edit")),
                    str(options.get("risk", "write")),
                    prompt_tokens,
                    int(options.get("turn", 1)),
                    int(options.get("failures", 0)),
                ),
                current_model=self.current_model,
            )
        self.current_model = decision.model
        self.events.append(
            {
                "event": "model_routed",
                "model": decision.model,
                "reason": decision.reason,
                "switched": decision.switched,
                "prompt_tokens": prompt_tokens,
            }
        )

        first = self.registry.binding_for(decision.model)
        candidates = [decision.model]
        for fallback in first.fallbacks:
            if fallback not in candidates:
                candidates.append(fallback)

        last_error: Optional[ModelCallError] = None
        for index, model in enumerate(candidates):
            binding = self.registry.binding_for(model)
            breaker = self.breakers.setdefault(
                model, CircuitBreaker(self.breaker_threshold, self.breaker_cooldown_ms)
            )
            if not breaker.allow(self.clock()):
                last_error = ModelCallError(CallErrorKind.PERMANENT, "circuit_open")
                self.events.append({"event": "breaker_open", "model": model})
                continue

            stop_all = False
            for attempt in range(1, self.retry.max_attempts + 1):
                admission = self.admission.admit(
                    self.tenant, model, prompt_tokens, output_tokens, self.clock()
                )
                if not admission.granted:
                    last_error = ModelCallError(
                        CallErrorKind.RATE_LIMITED
                        if admission.reason == "rate_limit"
                        else CallErrorKind.PERMANENT,
                        admission.reason,
                    )
                    self.events.append(
                        {
                            "event": "admission_denied",
                            "reason": admission.reason,
                            "detail": admission.detail,
                        }
                    )
                    stop_all = True
                    break

                self.events.append(
                    {
                        "event": "admitted",
                        "model": model,
                        "reservation": admission.reservation.reservation_id
                        if admission.reservation
                        else 0,
                    }
                )
                try:
                    response = await binding.provider.complete(
                        messages, tools, model=model, **options
                    )
                except ModelCallError as exc:
                    refund = self.admission.release(admission)
                    breaker.record_failure(self.clock())
                    last_error = exc
                    self.events.append(
                        {
                            "event": "attempt_failed",
                            "model": model,
                            "attempt": attempt,
                            "kind": exc.kind.value,
                            "refund": refund,
                        }
                    )
                    if self.retry.retryable(exc.kind) and attempt < self.retry.max_attempts:
                        delay = exc.retry_after_ms or self.retry.delay_ms(attempt, self.seed)
                        self.events.append({"event": "retry_scheduled", "delay_ms": delay})
                        await self.sleeper(delay)
                        continue
                    break
                except Exception as exc:  # 适配器未归一化的异常一律视为不可重试
                    refund = self.admission.release(admission)
                    breaker.record_failure(self.clock())
                    last_error = ModelCallError(CallErrorKind.PERMANENT, str(exc))
                    self.events.append(
                        {
                            "event": "attempt_failed",
                            "model": model,
                            "attempt": attempt,
                            "kind": "permanent",
                            "refund": refund,
                        }
                    )
                    break

                cache_read, cache_write = binding.cache_reader(response)
                usage = CostUsage.from_usage(
                    response.usage, cache_read=cache_read, cache_write=cache_write
                )
                refund = self.admission.settle(admission, usage)
                breaker.record_success()
                self.cost_report.record(model, usage)
                self.cache.observe(usage)
                self.events.append(
                    {
                        "event": "call_succeeded",
                        "model": model,
                        "attempt": attempt,
                        "refund": refund,
                        "cost_micros": self.catalog.get(model).cost_micros(usage),
                    }
                )
                return response

            if stop_all:
                break
            if index + 1 < len(candidates):
                self.events.append(
                    {"event": "failover", "from": model, "to": candidates[index + 1]}
                )

        raise last_error or ModelCallError(CallErrorKind.PERMANENT, "no provider available")


@dataclass(frozen=True)
class Lease:
    task_id: str
    owner: str
    fencing_token: int
    expires_at_ms: int


@dataclass(frozen=True)
class DrainReport:
    draining: bool
    active: int
    forced: int


class LeaseManager:
    """任务所有权与优雅停机：fencing token 防止旧 worker 复活后继续写。"""

    def __init__(self, lease_ms: int = 5_000) -> None:
        self.lease_ms = lease_ms
        self._leases: dict[str, Lease] = {}
        self._next_token = 1
        self.draining = False

    def acquire(self, task_id: str, owner: str, now_ms: int) -> Optional[Lease]:
        if self.draining:
            return None
        current = self._leases.get(task_id)
        if current is not None and current.expires_at_ms > now_ms:
            return current if current.owner == owner else None
        lease = Lease(task_id, owner, self._next_token, now_ms + self.lease_ms)
        self._next_token += 1
        self._leases[task_id] = lease
        return lease

    def renew(self, lease: Lease, now_ms: int) -> Optional[Lease]:
        current = self._leases.get(lease.task_id)
        if (
            current is None
            or current.owner != lease.owner
            or current.fencing_token != lease.fencing_token
            or current.expires_at_ms <= now_ms
        ):
            return None
        renewed = Lease(lease.task_id, lease.owner, lease.fencing_token, now_ms + self.lease_ms)
        self._leases[lease.task_id] = renewed
        return renewed

    def release(self, lease: Lease) -> bool:
        current = self._leases.get(lease.task_id)
        if current is None or current.fencing_token != lease.fencing_token:
            return False
        del self._leases[lease.task_id]
        return True

    def begin_drain(self) -> None:
        self.draining = True

    def drain_report(self, now_ms: int, deadline_ms: int) -> DrainReport:
        active = sum(1 for lease in self._leases.values() if lease.expires_at_ms > now_ms)
        forced = 0
        if now_ms >= deadline_ms:
            forced = len(self._leases)
            self._leases.clear()
        return DrainReport(self.draining, active, forced)


_RISK_RANK = {Risk.READ: 0, Risk.WRITE: 1, Risk.DESTRUCTIVE: 2, Risk.EXTERNAL: 3}


@dataclass(frozen=True)
class Grant:
    ticket: str
    tool: str
    target_prefix: str
    max_risk: Risk
    expires_at_ms: int


class PreauthorizedApprover:
    """Headless 预授权：只放行明确列出的工具与目标范围，过期即拒。"""

    def __init__(self, grants: Sequence[Grant], clock: Callable[[], int]) -> None:
        self.grants = tuple(grants)
        self.clock = clock

    def approve(self, request: ApprovalRequest) -> ApprovalResult:
        now = self.clock()
        for grant in self.grants:
            if now > grant.expires_at_ms:
                continue
            if request.action.tool != grant.tool:
                continue
            if not request.action.target.startswith(grant.target_prefix):
                continue
            if _RISK_RANK[request.action.risk] > _RISK_RANK[grant.max_risk]:
                continue
            return ApprovalResult("allow_once", f"preauth:{grant.ticket}")
        return ApprovalResult("deny", "no matching preauthorization")


def approval_request(action: Action, reason: str, deadline_ms: int = 0) -> ApprovalRequest:
    return ApprovalRequest(action, reason, deadline_ms)
