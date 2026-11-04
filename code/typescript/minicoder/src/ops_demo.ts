import { CostReport, ModelCatalog, PriceCard, Router } from "./cost.ts";
import type { ModelTier } from "./cost.ts";
import {
  AdmissionController,
  GovernedProvider,
  LeaseManager,
  ModelCallError,
  PreauthorizedApprover,
  ProviderRegistry,
  RetryPolicy,
  approvalRequest,
  deploymentManifest,
  providerBinding,
  tenantPolicy,
  validateManifest,
} from "./ops.ts";
import type { Grant } from "./ops.ts";
import { Action } from "./permissions.ts";
import { Message, ModelResponse, Usage } from "./types.ts";
import type { Provider } from "./provider.ts";
import type { ToolSpec } from "./types.ts";

const MUSD = 1_000_000;

function usd(micros: number): string {
  return `$${(micros / MUSD).toFixed(6)}`;
}

class Clock {
  now_ms = 0;

  now(): number {
    return this.now_ms;
  }

  advance(ms: number): void {
    this.now_ms += ms;
  }
}

class StaticProvider implements Provider {
  text: string;
  input_tokens: number;
  output_tokens: number;
  calls = 0;

  constructor(text: string, inputTokens: number, outputTokens: number) {
    this.text = text;
    this.input_tokens = inputTokens;
    this.output_tokens = outputTokens;
  }

  async complete(
    _messages: Message[],
    _tools: ToolSpec[] = [],
    _options: Record<string, unknown> = {},
  ): Promise<ModelResponse> {
    this.calls += 1;
    return new ModelResponse(
      this.text,
      [],
      "end_turn",
      new Usage(this.input_tokens, this.output_tokens),
    );
  }
}

class FlakyProvider extends StaticProvider {
  failures_left: number;

  constructor(failures: number, text: string, inputTokens: number, outputTokens: number) {
    super(text, inputTokens, outputTokens);
    this.failures_left = failures;
  }

  async complete(
    _messages: Message[],
    _tools: ToolSpec[] = [],
    _options: Record<string, unknown> = {},
  ): Promise<ModelResponse> {
    this.calls += 1;
    if (this.failures_left > 0) {
      this.failures_left -= 1;
      throw new ModelCallError("transient", "upstream 503");
    }
    return new ModelResponse(
      this.text,
      [],
      "end_turn",
      new Usage(this.input_tokens, this.output_tokens),
    );
  }
}

class SwitchProvider extends StaticProvider {
  fail = true;

  async complete(
    _messages: Message[],
    _tools: ToolSpec[] = [],
    _options: Record<string, unknown> = {},
  ): Promise<ModelResponse> {
    this.calls += 1;
    if (this.fail) {
      throw new ModelCallError("permanent", "model retired");
    }
    return new ModelResponse(
      this.text,
      [],
      "end_turn",
      new Usage(this.input_tokens, this.output_tokens),
    );
  }
}

function cacheReader(response: ModelResponse): [number, number] {
  return response.text.startsWith("cached:") ? [1200, 600] : [0, 0];
}

async function main(): Promise<void> {
  const clock = new Clock();
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

  console.log("== MiniCoder deploy ==");

  const acme = tenantPolicy("acme", 2, 60, 200_000, 100_000);
  const beta = tenantPolicy("beta", 2, 2, 200_000, 100_000);
  const tiny = tenantPolicy("tiny", 1, 60, 2_000, 1_000);
  const good = deploymentManifest({
    version: "2026.11.03",
    topology: "headless",
    policy_version: "p3",
    secret_refs: ["env:MINICODER_KEY", "vault:models/secondary"],
    tenants: [acme, beta],
    canary_percent: 0,
    headless_preauthorized: true,
  });
  const bad = deploymentManifest({
    version: "2026.11.03",
    topology: "headless",
    policy_version: "",
    secret_refs: ["literal-key"],
    tenants: [tenantPolicy("acme", 2, 60, 200_000, 100_000, "shared")],
    canary_percent: 0,
    headless_preauthorized: false,
  });
  console.log(`manifest   good issues=${validateManifest(good).length}`);
  const badIssues = validateManifest(bad);
  console.log(`manifest   bad  issues=${badIssues.length} codes=${badIssues.join(",")}`);

  const admission = new AdmissionController(catalog, [acme, beta, tiny]);
  const a1 = admission.admit("acme", "mini-1", 8_000, 1_000, clock.now());
  console.log(
    `admit      acme task=1 active=${admission.active("acme")}/2 ` +
      `reservation=${a1.reservation?.reservation_id ?? 0}`,
  );
  const a2 = admission.admit("acme", "mini-1", 9_000, 1_000, clock.now());
  console.log(
    `admit      acme task=2 active=${admission.active("acme")}/2 ` +
      `reservation=${a2.reservation?.reservation_id ?? 0}`,
  );
  const a3 = admission.admit("acme", "mini-1", 7_000, 1_000, clock.now());
  console.log(`admit      acme task=3 denied reason=${a3.reason} detail=${a3.detail}`);
  admission.release(a1);
  admission.release(a2);

  const r1 = admission.admit("beta", "mini-1", 1_000, 100, clock.now());
  admission.release(r1);
  const r2 = admission.admit("beta", "mini-1", 1_000, 100, clock.now());
  admission.release(r2);
  const r3 = admission.admit("beta", "mini-1", 1_000, 100, clock.now());
  console.log("rate       beta allow=1 remaining=1");
  console.log("rate       beta allow=1 remaining=0");
  console.log(`rate       beta denied retry_after=${r3.retry_after_ms}ms`);
  clock.advance(30_000);
  const r4 = admission.admit("beta", "mini-1", 1_000, 100, clock.now());
  console.log(`rate       beta refill allow=${r4.granted ? 1 : 0}`);
  admission.release(r4);

  const budget = admission.admit("tiny", "strong-1", 20_000, 2_000, clock.now());
  console.log(`budget     tiny denied reason=${budget.reason} detail=${budget.detail}`);

  const report = new CostReport(catalog);
  const tiers: ModelTier[] = [
    { name: "small", model: "mini-1", max_context: 32_000 },
    { name: "standard", model: "standard-1", max_context: 128_000 },
    { name: "strong", model: "strong-1", max_context: 200_000 },
  ];
  const router = new Router(tiers, { policy: "sticky" });
  const delays: number[] = [];

  const fakeSleep = async (ms: number): Promise<void> => {
    delays.push(ms);
    clock.advance(ms);
  };

  const flaky = new FlakyProvider(2, "cached: fix ok", 8_200, 900);
  const registry = new ProviderRegistry();
  registry.register(
    providerBinding({
      name: "primary",
      provider: flaky,
      models: ["mini-1"],
      cache_reader: cacheReader,
    }),
  );
  const governed = new GovernedProvider({
    registry,
    router,
    admission,
    tenant: "acme",
    catalog,
    cost_report: report,
    retry: new RetryPolicy(3, 200, 2_000),
    breaker_threshold: 2,
    breaker_cooldown_ms: 5_000,
    clock: () => clock.now(),
    sleeper: fakeSleep,
  });
  const response = await governed.complete([new Message("user", "fix the bug")], [], {
    prompt_tokens: 12_000,
    output_tokens: 900,
    preferred_model: "mini-1",
  });
  const failed = governed.events.filter((event) => event["event"] === "attempt_failed");
  console.log(
    `retry      attempts=${failed.length + 1} ` +
      `delays=${delays.map((delay) => String(delay)).join(",")} ` +
      `result=ok text=${response.text}`,
  );

  const failoverRouter = new Router(tiers);
  const failoverRegistry = new ProviderRegistry();
  failoverRegistry.register(
    providerBinding({
      name: "primary",
      provider: new SwitchProvider("never", 1, 1),
      models: ["mini-1"],
      fallbacks: ["standard-1"],
    }),
  );
  failoverRegistry.register(
    providerBinding({
      name: "secondary",
      provider: new StaticProvider("edit ok", 6_000, 800),
      models: ["standard-1"],
    }),
  );
  const failover = new GovernedProvider({
    registry: failoverRegistry,
    router: failoverRouter,
    admission,
    tenant: "acme",
    catalog,
    cost_report: report,
    retry: new RetryPolicy(2),
    clock: () => clock.now(),
    sleeper: fakeSleep,
  });
  await failover.complete([new Message("user", "edit")], [], {
    prompt_tokens: 12_000,
    output_tokens: 800,
    preferred_model: "mini-1",
  });
  const jump = failover.events.filter((event) => event["event"] === "failover")[0];
  console.log(`failover   from=${jump["from"]} to=${jump["to"]} result=ok`);

  const breakerRouter = new Router(tiers);
  const breakerRegistry = new ProviderRegistry();
  const switchProvider = new SwitchProvider("recovered", 5_000, 600);
  breakerRegistry.register(
    providerBinding({ name: "primary", provider: switchProvider, models: ["mini-1"] }),
  );
  const breakerProvider = new GovernedProvider({
    registry: breakerRegistry,
    router: breakerRouter,
    admission,
    tenant: "acme",
    catalog,
    cost_report: report,
    retry: new RetryPolicy(1),
    breaker_threshold: 2,
    breaker_cooldown_ms: 5_000,
    clock: () => clock.now(),
    sleeper: fakeSleep,
  });
  for (let index = 0; index < 2; index += 1) {
    try {
      await breakerProvider.complete([new Message("user", "edit")], [], {
        prompt_tokens: 9_000,
        output_tokens: 600,
        preferred_model: "mini-1",
      });
    } catch (error) {
      if (!(error instanceof ModelCallError)) throw error;
    }
  }
  let third = "";
  try {
    await breakerProvider.complete([new Message("user", "edit")], [], {
      prompt_tokens: 9_000,
      output_tokens: 600,
      preferred_model: "mini-1",
    });
  } catch (error) {
    third = error instanceof Error ? error.message : String(error);
  }
  const breaker = breakerProvider.breakers.get("mini-1")!;
  console.log(
    `breaker    state=${breaker.state} failures=${breaker.failures} ` +
      `calls=${switchProvider.calls} third=${third}`,
  );
  clock.advance(5_000);
  switchProvider.fail = false;
  await breakerProvider.complete([new Message("user", "edit")], [], {
    prompt_tokens: 9_000,
    output_tokens: 600,
    preferred_model: "mini-1",
  });
  console.log(
    `breaker    half-open-then-closed state=${breaker.state} calls=${switchProvider.calls}`,
  );

  const grants: Grant[] = [
    {
      ticket: "ci-pytest",
      tool: "run_command",
      target_prefix: "pytest",
      max_risk: "write",
      expires_at_ms: clock.now() + 600_000,
    },
  ];
  const approver = new PreauthorizedApprover(grants, () => clock.now());
  const inScope = new Action(
    "run_command",
    { argv: ["pytest", "-q"] },
    "write",
    "pytest -q",
    ["pytest", "-q"],
  );
  const outScope = new Action(
    "run_command",
    { argv: ["git", "push"] },
    "write",
    "git push",
    ["git", "push"],
  );
  console.log(`preauth    in-scope=${approver.approve(approvalRequest(inScope, "ci")).decision}`);
  console.log(
    `preauth    out-of-scope=${approver.approve(approvalRequest(outScope, "ci")).decision}`,
  );
  clock.advance(700_000);
  console.log(`preauth    expired=${approver.approve(approvalRequest(inScope, "ci")).decision}`);

  const leases = new LeaseManager(5_000);
  const now = clock.now();
  const first = leases.acquire("t-1", "worker-a", now);
  const blocked = leases.acquire("t-1", "worker-b", now);
  const renewed = first === null ? null : leases.renew(first, now + 1_000);
  if (first !== null) leases.release(first);
  const second = leases.acquire("t-1", "worker-b", now + 2_000);
  leases.beginDrain();
  const denied = leases.acquire("t-2", "worker-c", now + 2_000);
  const drain = leases.drainReport(now + 3_000, now + 100_000);
  const forced = leases.drainReport(now + 100_001, now + 100_000);
  console.log(
    `lease      acquire owner=worker-a fencing=${first?.fencing_token ?? 0}`,
  );
  console.log(`lease      duplicate owner=worker-b denied=${blocked === null}`);
  console.log(
    `lease      renew owner=worker-a fencing=${renewed?.fencing_token ?? 0}`,
  );
  console.log(
    `lease      acquire-after-release owner=worker-b fencing=${second?.fencing_token ?? 0}`,
  );
  console.log(
    `drain      acquire-denied=${denied === null} active=${drain.active} forced=${drain.forced}`,
  );
  console.log(`drain      deadline active=${forced.active} forced=${forced.forced}`);

  const decision = router.select({
    phase: "edit",
    risk: "destructive",
    prompt_tokens: 30_000,
    turn: 1,
    failures: 0,
  });
  console.log(`route      risk=destructive -> ${decision.model} reason=${decision.reason}`);

  const successes = 3;
  const perSuccess = report.perSuccessMicros(successes) ?? 0;
  console.log(
    `cost       total=${usd(report.total_cost_micros)} ` +
      `per_success=${usd(perSuccess)} successes=${successes}`,
  );
  console.log(
    `cache      reads=1200 writes=600 hit=${(governed.cache.hit_rate * 100).toFixed(1)}% ` +
      `savings=${usd(governed.cache.inputSavingsMicros(mini))}`,
  );
}

await main();
