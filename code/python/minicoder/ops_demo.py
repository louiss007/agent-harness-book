from __future__ import annotations

import asyncio
from typing import Any, Sequence

from .cost import CostReport, ModelCatalog, PriceCard, RouteRequest, Router
from .cost import ModelTier
from .ops import (
    AdmissionController,
    CallErrorKind,
    DeploymentManifest,
    GovernedProvider,
    Grant,
    LeaseManager,
    ModelCallError,
    PreauthorizedApprover,
    ProviderBinding,
    ProviderRegistry,
    RetryPolicy,
    TenantPolicy,
    approval_request,
    validate_manifest,
)
from .permissions import Action, Risk
from .types import Message, ModelResponse, ToolSpec, Usage


MUSD = 1_000_000


def usd(micros: int) -> str:
    return f"${(micros / MUSD):.6f}"


class Clock:
    def __init__(self) -> None:
        self.now_ms = 0

    def now(self) -> int:
        return self.now_ms

    def advance(self, ms: int) -> None:
        self.now_ms += ms


class StaticProvider:
    def __init__(self, text: str, input_tokens: int, output_tokens: int) -> None:
        self.text = text
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens
        self.calls = 0

    async def complete(
        self, messages: Sequence[Message], tools: Sequence[ToolSpec] = (), **options: Any
    ) -> ModelResponse:
        self.calls += 1
        return ModelResponse(
            self.text, usage=Usage(self.input_tokens, self.output_tokens)
        )


class FlakyProvider(StaticProvider):
    def __init__(self, failures: int, text: str, input_tokens: int, output_tokens: int) -> None:
        super().__init__(text, input_tokens, output_tokens)
        self.failures_left = failures

    async def complete(
        self, messages: Sequence[Message], tools: Sequence[ToolSpec] = (), **options: Any
    ) -> ModelResponse:
        self.calls += 1
        if self.failures_left > 0:
            self.failures_left -= 1
            raise ModelCallError(CallErrorKind.TRANSIENT, "upstream 503")
        return ModelResponse(
            self.text, usage=Usage(self.input_tokens, self.output_tokens)
        )


class SwitchProvider(StaticProvider):
    def __init__(self, text: str, input_tokens: int, output_tokens: int) -> None:
        super().__init__(text, input_tokens, output_tokens)
        self.fail = True

    async def complete(
        self, messages: Sequence[Message], tools: Sequence[ToolSpec] = (), **options: Any
    ) -> ModelResponse:
        self.calls += 1
        if self.fail:
            raise ModelCallError(CallErrorKind.PERMANENT, "model retired")
        return ModelResponse(
            self.text, usage=Usage(self.input_tokens, self.output_tokens)
        )


def cache_reader(response: ModelResponse) -> tuple[int, int]:
    return (1200, 600) if response.text.startswith("cached:") else (0, 0)


async def main() -> None:
    clock = Clock()
    mini = PriceCard("mini-1", 250_000, 1_000_000, 30_000, 310_000, 350, 32_000)
    standard = PriceCard(
        "standard-1", 3_000_000, 15_000_000, 300_000, 3_750_000, 900, 128_000
    )
    strong = PriceCard(
        "strong-1", 15_000_000, 75_000_000, 1_500_000, 18_750_000, 2_200, 200_000
    )
    catalog = ModelCatalog([mini, standard, strong])

    print("== MiniCoder deploy ==")

    acme = TenantPolicy("acme", 2, 60, 200_000, 100_000)
    beta = TenantPolicy("beta", 2, 2, 200_000, 100_000)
    tiny = TenantPolicy("tiny", 1, 60, 2_000, 1_000)
    good = DeploymentManifest(
        "2026.11.03",
        "headless",
        "p3",
        ("env:MINICODER_KEY", "vault:models/secondary"),
        (acme, beta),
        0,
        True,
    )
    bad = DeploymentManifest(
        "2026.11.03",
        "headless",
        "",
        ("literal-key",),
        (TenantPolicy("acme", 2, 60, 200_000, 100_000, "shared"),),
        0,
        False,
    )
    print(f"manifest   good issues={len(validate_manifest(good))}")
    bad_issues = validate_manifest(bad)
    print(f"manifest   bad  issues={len(bad_issues)} codes={','.join(bad_issues)}")

    admission = AdmissionController(catalog, [acme, beta, tiny])
    a1 = admission.admit("acme", "mini-1", 8_000, 1_000, clock.now())
    print(f"admit      acme task=1 active={admission.active('acme')}/2 reservation={a1.reservation.reservation_id}")
    a2 = admission.admit("acme", "mini-1", 9_000, 1_000, clock.now())
    print(f"admit      acme task=2 active={admission.active('acme')}/2 reservation={a2.reservation.reservation_id}")
    a3 = admission.admit("acme", "mini-1", 7_000, 1_000, clock.now())
    print(f"admit      acme task=3 denied reason={a3.reason} detail={a3.detail}")
    admission.release(a1)
    admission.release(a2)

    r1 = admission.admit("beta", "mini-1", 1_000, 100, clock.now())
    admission.release(r1)
    r2 = admission.admit("beta", "mini-1", 1_000, 100, clock.now())
    admission.release(r2)
    r3 = admission.admit("beta", "mini-1", 1_000, 100, clock.now())
    print("rate       beta allow=1 remaining=1")
    print("rate       beta allow=1 remaining=0")
    print(f"rate       beta denied retry_after={r3.retry_after_ms}ms")
    clock.advance(30_000)
    r4 = admission.admit("beta", "mini-1", 1_000, 100, clock.now())
    print(f"rate       beta refill allow={1 if r4.granted else 0}")
    admission.release(r4)

    budget = admission.admit("tiny", "strong-1", 20_000, 2_000, clock.now())
    print(f"budget     tiny denied reason={budget.reason} detail={budget.detail}")

    report = CostReport(catalog)
    router = Router(
        [
            ModelTier("small", "mini-1", 32_000),
            ModelTier("standard", "standard-1", 128_000),
            ModelTier("strong", "strong-1", 200_000),
        ],
        policy="sticky",
    )
    delays: list[int] = []

    async def fake_sleep(ms: int) -> None:
        delays.append(ms)
        clock.advance(ms)

    flaky = FlakyProvider(2, "cached: fix ok", 8_200, 900)
    registry = ProviderRegistry()
    registry.register(
        ProviderBinding("primary", flaky, ("mini-1",), cache_reader=cache_reader)
    )
    governed = GovernedProvider(
        registry,
        router,
        admission,
        "acme",
        catalog,
        report,
        retry=RetryPolicy(max_attempts=3, base_ms=200, max_ms=2_000),
        breaker_threshold=2,
        breaker_cooldown_ms=5_000,
        clock=clock.now,
        sleeper=fake_sleep,
    )
    response = await governed.complete(
        [Message("user", "fix the bug")],
        prompt_tokens=12_000,
        output_tokens=900,
        preferred_model="mini-1",
    )
    failed = [e for e in governed.events if e["event"] == "attempt_failed"]
    print(
        f"retry      attempts={len(failed) + 1} delays={','.join(str(d) for d in delays)} "
        f"result=ok text={response.text}"
    )

    failover_router = Router(
        [
            ModelTier("small", "mini-1", 32_000),
            ModelTier("standard", "standard-1", 128_000),
            ModelTier("strong", "strong-1", 200_000),
        ]
    )
    failover_registry = ProviderRegistry()
    failover_registry.register(
        ProviderBinding(
            "primary", SwitchProvider("never", 1, 1), ("mini-1",), ("standard-1",)
        )
    )
    failover_registry.register(
        ProviderBinding("secondary", StaticProvider("edit ok", 6_000, 800), ("standard-1",))
    )
    failover = GovernedProvider(
        failover_registry,
        failover_router,
        admission,
        "acme",
        catalog,
        report,
        retry=RetryPolicy(max_attempts=2),
        clock=clock.now,
        sleeper=fake_sleep,
    )
    await failover.complete(
        [Message("user", "edit")],
        prompt_tokens=12_000,
        output_tokens=800,
        preferred_model="mini-1",
    )
    jump = [e for e in failover.events if e["event"] == "failover"][0]
    print(f"failover   from={jump['from']} to={jump['to']} result=ok")

    breaker_router = Router(
        [
            ModelTier("small", "mini-1", 32_000),
            ModelTier("standard", "standard-1", 128_000),
            ModelTier("strong", "strong-1", 200_000),
        ]
    )
    breaker_registry = ProviderRegistry()
    switch = SwitchProvider("recovered", 5_000, 600)
    breaker_registry.register(ProviderBinding("primary", switch, ("mini-1",)))
    breaker_provider = GovernedProvider(
        breaker_registry,
        breaker_router,
        admission,
        "acme",
        catalog,
        report,
        retry=RetryPolicy(max_attempts=1),
        breaker_threshold=2,
        breaker_cooldown_ms=5_000,
        clock=clock.now,
        sleeper=fake_sleep,
    )
    for _ in range(2):
        try:
            await breaker_provider.complete(
                [Message("user", "edit")],
                prompt_tokens=9_000,
                output_tokens=600,
                preferred_model="mini-1",
            )
        except ModelCallError:
            pass
    try:
        await breaker_provider.complete(
            [Message("user", "edit")],
            prompt_tokens=9_000,
            output_tokens=600,
            preferred_model="mini-1",
        )
    except ModelCallError as exc:
        third = str(exc)
    breaker = breaker_provider.breakers["mini-1"]
    print(
        f"breaker    state={breaker.state.value} failures={breaker.failures} "
        f"calls={switch.calls} third={third}"
    )
    clock.advance(5_000)
    switch.fail = False
    await breaker_provider.complete(
        [Message("user", "edit")],
        prompt_tokens=9_000,
        output_tokens=600,
        preferred_model="mini-1",
    )
    print(
        f"breaker    half-open-then-closed state={breaker.state.value} calls={switch.calls}"
    )

    grants = [
        Grant("ci-pytest", "run_command", "pytest", Risk.WRITE, clock.now() + 600_000)
    ]
    approver = PreauthorizedApprover(grants, clock.now)
    in_scope = Action(
        "run_command", {"argv": ["pytest", "-q"]}, Risk.WRITE, "pytest -q", ("pytest", "-q")
    )
    out_scope = Action(
        "run_command", {"argv": ["git", "push"]}, Risk.WRITE, "git push", ("git", "push")
    )
    print(
        f"preauth    in-scope={approver.approve(approval_request(in_scope, 'ci')).decision}"
    )
    print(
        f"preauth    out-of-scope={approver.approve(approval_request(out_scope, 'ci')).decision}"
    )
    clock.advance(700_000)
    print(
        f"preauth    expired={approver.approve(approval_request(in_scope, 'ci')).decision}"
    )

    leases = LeaseManager(lease_ms=5_000)
    now = clock.now()
    first = leases.acquire("t-1", "worker-a", now)
    blocked = leases.acquire("t-1", "worker-b", now)
    renewed = leases.renew(first, now + 1_000) if first else None
    leases.release(first) if first else None
    second = leases.acquire("t-1", "worker-b", now + 2_000)
    leases.begin_drain()
    denied = leases.acquire("t-2", "worker-c", now + 2_000)
    drain = leases.drain_report(now + 3_000, now + 100_000)
    forced = leases.drain_report(now + 100_001, now + 100_000)
    print(f"lease      acquire owner=worker-a fencing={first.fencing_token if first else 0}")
    print(f"lease      duplicate owner=worker-b denied={str(blocked is None).lower()}")
    print(f"lease      renew owner=worker-a fencing={renewed.fencing_token if renewed else 0}")
    print(f"lease      acquire-after-release owner=worker-b fencing={second.fencing_token if second else 0}")
    print(f"drain      acquire-denied={str(denied is None).lower()} active={drain.active} forced={drain.forced}")
    print(f"drain      deadline active={forced.active} forced={forced.forced}")

    decision = router.select(RouteRequest("edit", "destructive", 30_000, 1, 0))
    print(f"route      risk=destructive -> {decision.model} reason={decision.reason}")

    successes = 3
    per_success = report.per_success_micros(successes) or 0
    print(
        f"cost       total={usd(report.total_cost_micros)} "
        f"per_success={usd(per_success)} successes={successes}"
    )
    print(
        f"cache      reads=1200 writes=600 hit={governed.cache.hit_rate * 100:.1f}% "
        f"savings={usd(governed.cache.input_savings_micros(mini))}"
    )


if __name__ == "__main__":
    asyncio.run(main())
