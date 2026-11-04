"""离线演示：缓存、预算、路由、延迟与成本报告。"""

from __future__ import annotations

from .cost import (
    MTOK,
    BudgetExceeded,
    BudgetLedger,
    CacheStats,
    CostReport,
    CostUsage,
    ModelCatalog,
    ModelTier,
    PriceCard,
    PrefixSection,
    RouteRequest,
    Router,
    TaskBudget,
    latency_breakdown,
    plan_cache,
)


def usd(micros: int) -> str:
    return f"${micros / MTOK:.6f}"


def main() -> None:
    mini = PriceCard("mini-1", 250_000, 1_000_000, 30_000, 310_000, 350, 32_000)
    standard = PriceCard(
        "standard-1", 3_000_000, 15_000_000, 300_000, 3_750_000, 900, 128_000
    )
    strong = PriceCard(
        "strong-1", 15_000_000, 75_000_000, 1_500_000, 18_750_000, 2_200, 200_000
    )
    catalog = ModelCatalog([mini, standard, strong])

    print("== MiniCoder cost ==")
    for card in catalog:
        print(
            f"price     {card.model:<14} "
            f"in=${card.input_micro_per_mtok / MTOK:.2f} "
            f"out=${card.output_micro_per_mtok / MTOK:.2f} "
            f"read=${card.cache_read_micro_per_mtok / MTOK:.2f} "
            f"write=${card.cache_write_micro_per_mtok / MTOK:.2f} /Mtok"
        )

    usage = CostUsage(8_200, 1_200, 600, 900)
    actual = mini.cost_micros(usage)
    print(
        f"usage     prompt={usage.prompt_tokens} uncached={usage.input_tokens} "
        f"read={usage.cache_read_tokens} write={usage.cache_write_tokens} "
        f"output={usage.output_tokens}"
    )
    print(
        f"cost      {mini.model:<14} actual={usd(actual)} "
        f"uncached={usd(mini.uncached_cost_micros(usage))} "
        f"savings={usd(mini.savings_micros(usage))}"
    )

    ledger = BudgetLedger(TaskBudget(30_000, 40_000, 5_000), catalog)
    print("budget    max_cost=$0.030000 max_prompt=40000 max_output=5000")
    reservation = ledger.reserve("mini-1", prompt_tokens=10_000, output_tokens=1_200)
    print(
        f"reserve   {reservation.model} id={reservation.reservation_id} "
        f"cost={usd(reservation.cost_micros)}"
    )
    refund = ledger.settle(reservation, usage)
    snapshot = ledger.snapshot()
    print(f"settle    actual={usd(actual)} refund={usd(refund)}")
    print(
        f"remaining cost={usd(snapshot.cost_remaining_micros)} "
        f"prompt={snapshot.prompt_remaining} output={snapshot.output_remaining}"
    )
    try:
        ledger.reserve("strong-1", prompt_tokens=38_000, output_tokens=6_000)
    except BudgetExceeded as exc:
        print(
            f"denied    strong-1 scope={exc.scope} "
            f"requested={usd(exc.requested)} remaining={usd(exc.remaining)}"
        )

    tiers = [
        ModelTier("small", "mini-1", 32_000),
        ModelTier("standard", "standard-1", 128_000),
        ModelTier("strong", "strong-1", 200_000),
    ]
    router = Router(tiers, policy="sticky", escalate_after=1, hard_after=3)
    requests = [
        RouteRequest("explore", "read", 20_000, 1, 0),
        RouteRequest("edit", "write", 22_000, 2, 0),
        RouteRequest("edit", "write", 24_000, 3, 1),
        RouteRequest("edit", "write", 90_000, 4, 0),
        RouteRequest("edit", "write", 140_000, 5, 4),
        RouteRequest("edit", "destructive", 30_000, 6, 0),
        RouteRequest("summarize", "read", 9_000, 7, 0),
        RouteRequest("explore", "read", 150_000, 8, 0),
    ]
    print("route     policy=sticky escalate_after=1 hard_after=3")
    current = ""
    for request in requests:
        decision = router.select(request, current_model=current)
        current = decision.model
        print(
            f"route     t{request.turn} {request.phase:<9} f={request.failures} "
            f"p={request.prompt_tokens:<6} -> {decision.model:<12} "
            f"switched={str(decision.switched).lower():<5} reason={decision.reason}"
        )
    print(f"route     switches={router.switches}")

    system = PrefixSection(
        "system",
        "system:stay-in-workspace;read-before-write;verify-after-edit;" * 18,
    )
    tools = PrefixSection(
        "tools", "tools:read_file,write_file,run_command;schema-stable;" * 14
    )
    memory = PrefixSection(
        "memory", "memory:project=minicoder;user=prefers-small-diffs;" * 10, "session"
    )
    state = PrefixSection("state", "state:turn=7;todo=2/5;last_error=none;" * 6, "turn")
    recent = PrefixSection(
        "recent", "recent:read src/app.py 35 lines;write src/app.py 650 chars;" * 5, "turn"
    )

    good = plan_cache([system, tools, memory, state, recent])
    print(
        f"cache     good  naive={good.naive_tokens} stable={good.cacheable_tokens} "
        f"reordered={str(good.reordered).lower():<5} fp={good.fingerprint}"
    )
    bad = plan_cache([system, state, tools, memory, recent])
    print(
        f"cache     bad   naive={bad.naive_tokens} stable={bad.cacheable_tokens} "
        f"reordered={str(bad.reordered).lower():<5} fp={bad.fingerprint}"
    )
    changed = plan_cache(
        [PrefixSection("system", system.text + "v2"), tools, memory, state, recent]
    )
    volatile = plan_cache(
        [system, tools, memory, PrefixSection("state", state.text + "x", "turn"), recent]
    )
    print(f"cache     static-changed fp_changed={str(changed.fingerprint != good.fingerprint).lower()}")
    print(f"cache     volatile-changed fp_changed={str(volatile.fingerprint != good.fingerprint).lower()}")

    stats = CacheStats()
    previous = 0
    turns = [
        CostUsage(cache_write_tokens=good.cacheable_tokens),
        CostUsage(cache_read_tokens=good.cacheable_tokens),
        CostUsage(cache_read_tokens=good.cacheable_tokens),
    ]
    for index, turn_usage in enumerate(turns, start=1):
        stats.observe(turn_usage)
        cumulative = stats.input_savings_micros(mini)
        print(
            f"cache     t{index} write={turn_usage.cache_write_tokens:<5} "
            f"read={turn_usage.cache_read_tokens:<5} "
            f"savings={cumulative - previous} cumulative={cumulative}"
        )
        previous = cumulative

    latency = latency_breakdown(
        cold_start_ms=800,
        prefill_ms=600,
        decode_ms=1_200,
        approval_ms=400,
        tool_groups=[[200, 900, 300], [150]],
    )
    print(
        f"latency   ttft={latency.ttft_ms}ms total_parallel={latency.total_parallel_ms}ms "
        f"total_serial={latency.total_serial_ms}ms saved={latency.saved_ms}ms"
    )
    print(
        f"latency   tools parallel={latency.tool_parallel_ms}ms "
        f"serial={latency.tool_serial_ms}ms approval={latency.approval_ms}ms "
        f"decode={latency.decode_ms}ms"
    )

    report = CostReport(catalog)
    report.record("mini-1", usage, turns=1)
    report.record("standard-1", CostUsage(6_000, 2_000, 0, 800), turns=1)
    for line in report.format():
        print(line)
    successes = 1
    print(
        f"report    total cost={usd(report.total_cost_micros)} "
        f"per_success={usd(report.per_success_micros(successes) or 0)} "
        f"successes={successes}"
    )


if __name__ == "__main__":
    main()
