import {
  BudgetExceeded,
  BudgetLedger,
  CacheStats,
  CostReport,
  CostUsage,
  MTOK,
  ModelCatalog,
  PriceCard,
  Router,
  latencyBreakdown,
  planCache,
} from "./cost.ts";
import type { ModelTier, PrefixSection, RouteRequest } from "./cost.ts";

function usd(micros: number): string {
  return `$${(micros / MTOK).toFixed(6)}`;
}

function main(): void {
  const mini = new PriceCard("mini-1", 250_000, 1_000_000, 30_000, 310_000, 350, 32_000);
  const standard = new PriceCard(
    "standard-1",
    3_000_000,
    15_000_000,
    300_000,
    3_750_000,
    900,
    128_000,
  );
  const strong = new PriceCard(
    "strong-1",
    15_000_000,
    75_000_000,
    1_500_000,
    18_750_000,
    2_200,
    200_000,
  );
  const catalog = new ModelCatalog([mini, standard, strong]);

  console.log("== MiniCoder cost ==");
  for (const card of catalog.values()) {
    console.log(
      `price     ${card.model.padEnd(14)} ` +
        `in=$${(card.input_micro_per_mtok / MTOK).toFixed(2)} ` +
        `out=$${(card.output_micro_per_mtok / MTOK).toFixed(2)} ` +
        `read=$${(card.cache_read_micro_per_mtok / MTOK).toFixed(2)} ` +
        `write=$${(card.cache_write_micro_per_mtok / MTOK).toFixed(2)} /Mtok`,
    );
  }

  const usage = new CostUsage(8_200, 1_200, 600, 900);
  const actual = mini.costMicros(usage);
  console.log(
    `usage     prompt=${usage.prompt_tokens} uncached=${usage.input_tokens} ` +
      `read=${usage.cache_read_tokens} write=${usage.cache_write_tokens} ` +
      `output=${usage.output_tokens}`,
  );
  console.log(
    `cost      ${mini.model.padEnd(14)} actual=${usd(actual)} ` +
      `uncached=${usd(mini.uncachedCostMicros(usage))} ` +
      `savings=${usd(mini.savingsMicros(usage))}`,
  );

  const ledger = new BudgetLedger(
    { max_cost_micros: 30_000, max_prompt_tokens: 40_000, max_output_tokens: 5_000 },
    catalog,
  );
  console.log("budget    max_cost=$0.030000 max_prompt=40000 max_output=5000");
  const reservation = ledger.reserve("mini-1", 10_000, 1_200);
  console.log(
    `reserve   ${reservation.model} id=${reservation.reservation_id} ` +
      `cost=${usd(reservation.cost_micros)}`,
  );
  const refund = ledger.settle(reservation, usage);
  const snapshot = ledger.snapshot();
  console.log(`settle    actual=${usd(actual)} refund=${usd(refund)}`);
  console.log(
    `remaining cost=${usd(snapshot.cost_remaining_micros)} ` +
      `prompt=${snapshot.prompt_remaining} output=${snapshot.output_remaining}`,
  );
  try {
    ledger.reserve("strong-1", 38_000, 6_000);
  } catch (exc) {
    if (exc instanceof BudgetExceeded) {
      console.log(
        `denied    strong-1 scope=${exc.scope} ` +
          `requested=${usd(exc.requested)} remaining=${usd(exc.remaining)}`,
      );
    } else {
      throw exc;
    }
  }

  const tiers: ModelTier[] = [
    { name: "small", model: "mini-1", max_context: 32_000 },
    { name: "standard", model: "standard-1", max_context: 128_000 },
    { name: "strong", model: "strong-1", max_context: 200_000 },
  ];
  const router = new Router(tiers, { policy: "sticky", escalate_after: 1, hard_after: 3 });
  const requests: RouteRequest[] = [
    { phase: "explore", risk: "read", prompt_tokens: 20_000, turn: 1, failures: 0 },
    { phase: "edit", risk: "write", prompt_tokens: 22_000, turn: 2, failures: 0 },
    { phase: "edit", risk: "write", prompt_tokens: 24_000, turn: 3, failures: 1 },
    { phase: "edit", risk: "write", prompt_tokens: 90_000, turn: 4, failures: 0 },
    { phase: "edit", risk: "write", prompt_tokens: 140_000, turn: 5, failures: 4 },
    { phase: "edit", risk: "destructive", prompt_tokens: 30_000, turn: 6, failures: 0 },
    { phase: "summarize", risk: "read", prompt_tokens: 9_000, turn: 7, failures: 0 },
    { phase: "explore", risk: "read", prompt_tokens: 150_000, turn: 8, failures: 0 },
  ];
  console.log("route     policy=sticky escalate_after=1 hard_after=3");
  let current = "";
  for (const request of requests) {
    const decision = router.select(request, current);
    current = decision.model;
    console.log(
      `route     t${request.turn} ${request.phase!.padEnd(9)} f=${request.failures} ` +
        `p=${String(request.prompt_tokens).padEnd(6)} -> ${decision.model.padEnd(12)} ` +
        `switched=${String(decision.switched).padEnd(5)} reason=${decision.reason}`,
    );
  }
  console.log(`route     switches=${router.switches}`);

  const system: PrefixSection = {
    name: "system",
    text: "system:stay-in-workspace;read-before-write;verify-after-edit;".repeat(18),
  };
  const tools: PrefixSection = {
    name: "tools",
    text: "tools:read_file,write_file,run_command;schema-stable;".repeat(14),
  };
  const memory: PrefixSection = {
    name: "memory",
    text: "memory:project=minicoder;user=prefers-small-diffs;".repeat(10),
    stability: "session",
  };
  const state: PrefixSection = {
    name: "state",
    text: "state:turn=7;todo=2/5;last_error=none;".repeat(6),
    stability: "turn",
  };
  const recent: PrefixSection = {
    name: "recent",
    text: "recent:read src/app.py 35 lines;write src/app.py 650 chars;".repeat(5),
    stability: "turn",
  };

  const good = planCache([system, tools, memory, state, recent]);
  console.log(
    `cache     good  naive=${good.naive_tokens} stable=${good.cacheable_tokens} ` +
      `reordered=${String(good.reordered).padEnd(5)} fp=${good.fingerprint}`,
  );
  const bad = planCache([system, state, tools, memory, recent]);
  console.log(
    `cache     bad   naive=${bad.naive_tokens} stable=${bad.cacheable_tokens} ` +
      `reordered=${String(bad.reordered).padEnd(5)} fp=${bad.fingerprint}`,
  );
  const changed = planCache([
    { name: "system", text: system.text + "v2" },
    tools,
    memory,
    state,
    recent,
  ]);
  const volatile = planCache([
    system,
    tools,
    memory,
    { name: "state", text: state.text + "x", stability: "turn" },
    recent,
  ]);
  console.log(
    `cache     static-changed fp_changed=${String(changed.fingerprint !== good.fingerprint)}`,
  );
  console.log(
    `cache     volatile-changed fp_changed=${String(volatile.fingerprint !== good.fingerprint)}`,
  );

  const stats = new CacheStats();
  let previous = 0;
  const turns = [
    new CostUsage(0, 0, good.cacheable_tokens, 0),
    new CostUsage(0, good.cacheable_tokens, 0, 0),
    new CostUsage(0, good.cacheable_tokens, 0, 0),
  ];
  turns.forEach((turnUsage, index) => {
    stats.observe(turnUsage);
    const cumulative = stats.inputSavingsMicros(mini);
    console.log(
      `cache     t${index + 1} write=${String(turnUsage.cache_write_tokens).padEnd(5)} ` +
        `read=${String(turnUsage.cache_read_tokens).padEnd(5)} ` +
        `savings=${cumulative - previous} cumulative=${cumulative}`,
    );
    previous = cumulative;
  });

  const latency = latencyBreakdown({
    cold_start_ms: 800,
    prefill_ms: 600,
    decode_ms: 1_200,
    approval_ms: 400,
    tool_groups: [
      [200, 900, 300],
      [150],
    ],
  });
  console.log(
    `latency   ttft=${latency.ttft_ms}ms total_parallel=${latency.total_parallel_ms}ms ` +
      `total_serial=${latency.total_serial_ms}ms saved=${latency.saved_ms}ms`,
  );
  console.log(
    `latency   tools parallel=${latency.tool_parallel_ms}ms ` +
      `serial=${latency.tool_serial_ms}ms approval=${latency.approval_ms}ms ` +
      `decode=${latency.decode_ms}ms`,
  );

  const report = new CostReport(catalog);
  report.record("mini-1", usage, 1);
  report.record("standard-1", new CostUsage(6_000, 2_000, 0, 800), 1);
  for (const line of report.format()) console.log(line);
  const successes = 1;
  console.log(
    `report    total cost=${usd(report.total_cost_micros)} ` +
      `per_success=${usd(report.perSuccessMicros(successes) ?? 0)} ` +
      `successes=${successes}`,
  );
}

main();
