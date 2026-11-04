import { createHash } from "node:crypto";

import { estimateTokens } from "./context.ts";
import type { Usage } from "./types.ts";

export const MTOK = 1_000_000;

export class CostUsage {
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;

  constructor(
    input_tokens = 0,
    cache_read_tokens = 0,
    cache_write_tokens = 0,
    output_tokens = 0,
  ) {
    this.input_tokens = input_tokens;
    this.cache_read_tokens = cache_read_tokens;
    this.cache_write_tokens = cache_write_tokens;
    this.output_tokens = output_tokens;
  }

  get prompt_tokens(): number {
    return this.input_tokens + this.cache_read_tokens + this.cache_write_tokens;
  }

  get total_tokens(): number {
    return this.prompt_tokens + this.output_tokens;
  }

  add(other: CostUsage): CostUsage {
    return new CostUsage(
      this.input_tokens + other.input_tokens,
      this.cache_read_tokens + other.cache_read_tokens,
      this.cache_write_tokens + other.cache_write_tokens,
      this.output_tokens + other.output_tokens,
    );
  }
}

export function costUsageFrom(
  usage: Usage,
  cacheRead = 0,
  cacheWrite = 0,
): CostUsage {
  return new CostUsage(usage.input_tokens, cacheRead, cacheWrite, usage.output_tokens);
}

export class PriceCard {
  model: string;
  input_micro_per_mtok: number;
  output_micro_per_mtok: number;
  cache_read_micro_per_mtok: number;
  cache_write_micro_per_mtok: number;
  latency_p50_ms: number;
  context_window: number;

  constructor(
    model: string,
    input_micro_per_mtok: number,
    output_micro_per_mtok: number,
    cache_read_micro_per_mtok: number,
    cache_write_micro_per_mtok: number,
    latency_p50_ms = 0,
    context_window = 200_000,
  ) {
    this.model = model;
    this.input_micro_per_mtok = input_micro_per_mtok;
    this.output_micro_per_mtok = output_micro_per_mtok;
    this.cache_read_micro_per_mtok = cache_read_micro_per_mtok;
    this.cache_write_micro_per_mtok = cache_write_micro_per_mtok;
    this.latency_p50_ms = latency_p50_ms;
    this.context_window = context_window;
  }

  private micros(numerator: number): number {
    return Math.floor((numerator + MTOK / 2) / MTOK);
  }

  costMicros(usage: CostUsage): number {
    return this.micros(
      usage.input_tokens * this.input_micro_per_mtok +
        usage.cache_read_tokens * this.cache_read_micro_per_mtok +
        usage.cache_write_tokens * this.cache_write_micro_per_mtok +
        usage.output_tokens * this.output_micro_per_mtok,
    );
  }

  uncachedCostMicros(usage: CostUsage): number {
    return this.micros(
      usage.prompt_tokens * this.input_micro_per_mtok +
        usage.output_tokens * this.output_micro_per_mtok,
    );
  }

  savingsMicros(usage: CostUsage): number {
    return this.uncachedCostMicros(usage) - this.costMicros(usage);
  }
}

export class ModelCatalog {
  private cards: Map<string, PriceCard>;

  constructor(cards: PriceCard[]) {
    this.cards = new Map();
    for (const card of cards) {
      if (this.cards.has(card.model)) {
        throw new Error(`重复的模型价格：${card.model}`);
      }
      this.cards.set(card.model, card);
    }
  }

  get(model: string): PriceCard {
    const card = this.cards.get(model);
    if (card === undefined) throw new Error(`未知模型：${model}`);
    return card;
  }

  values(): PriceCard[] {
    return Array.from(this.cards.values());
  }
}

export interface TaskBudget {
  max_cost_micros: number;
  max_prompt_tokens: number;
  max_output_tokens: number;
}

export class BudgetExceeded extends Error {
  scope: string;
  requested: number;
  remaining: number;

  constructor(scope: string, requested: number, remaining: number) {
    super(`${scope}: requested=${requested} remaining=${remaining}`);
    this.scope = scope;
    this.requested = requested;
    this.remaining = remaining;
  }
}

export interface Reservation {
  reservation_id: number;
  model: string;
  prompt_tokens: number;
  output_tokens: number;
  cost_micros: number;
}

export interface LedgerSnapshot {
  cost_used_micros: number;
  prompt_used: number;
  output_used: number;
  cost_remaining_micros: number;
  prompt_remaining: number;
  output_remaining: number;
  rejected: number;
  overruns: number;
}

export class BudgetLedger {
  budget: TaskBudget;
  catalog: ModelCatalog;
  used: CostUsage;
  cost_used_micros: number;
  rejected: number;
  overruns: number;
  private reservedCost: number;
  private reservedPrompt: number;
  private reservedOutput: number;
  private nextId: number;
  private open: Map<number, Reservation>;

  constructor(budget: TaskBudget, catalog: ModelCatalog) {
    this.budget = budget;
    this.catalog = catalog;
    this.used = new CostUsage();
    this.cost_used_micros = 0;
    this.rejected = 0;
    this.overruns = 0;
    this.reservedCost = 0;
    this.reservedPrompt = 0;
    this.reservedOutput = 0;
    this.nextId = 1;
    this.open = new Map();
  }

  reserve(model: string, promptTokens: number, outputTokens: number): Reservation {
    if (promptTokens < 0 || outputTokens < 0) {
      throw new Error("预扣 token 不能为负");
    }
    const card = this.catalog.get(model);
    const cost = card.costMicros(new CostUsage(promptTokens, 0, 0, outputTokens));

    const checks: Array<[string, number, number]> = [
      ["cost", cost, this.budget.max_cost_micros - this.cost_used_micros - this.reservedCost],
      [
        "prompt",
        promptTokens,
        this.budget.max_prompt_tokens - this.used.prompt_tokens - this.reservedPrompt,
      ],
      [
        "output",
        outputTokens,
        this.budget.max_output_tokens - this.used.output_tokens - this.reservedOutput,
      ],
    ];
    for (const [scope, requested, remaining] of checks) {
      if (requested > remaining) {
        this.rejected += 1;
        throw new BudgetExceeded(scope, requested, Math.max(0, remaining));
      }
    }

    const reservation: Reservation = {
      reservation_id: this.nextId,
      model,
      prompt_tokens: promptTokens,
      output_tokens: outputTokens,
      cost_micros: cost,
    };
    this.nextId += 1;
    this.open.set(reservation.reservation_id, reservation);
    this.reservedCost += cost;
    this.reservedPrompt += promptTokens;
    this.reservedOutput += outputTokens;
    return reservation;
  }

  settle(reservation: Reservation, usage: CostUsage): number {
    const stored = this.open.get(reservation.reservation_id);
    if (stored === undefined) {
      throw new Error(`预扣不存在或已结算：${reservation.reservation_id}`);
    }
    this.open.delete(reservation.reservation_id);
    this.reservedCost -= stored.cost_micros;
    this.reservedPrompt -= stored.prompt_tokens;
    this.reservedOutput -= stored.output_tokens;

    const actual = this.catalog.get(reservation.model).costMicros(usage);
    this.used = this.used.add(usage);
    this.cost_used_micros += actual;
    if (actual > stored.cost_micros) this.overruns += 1;
    return stored.cost_micros - actual;
  }

  release(reservation: Reservation): number {
    const stored = this.open.get(reservation.reservation_id);
    if (stored === undefined) {
      throw new Error(`预扣不存在或已结算：${reservation.reservation_id}`);
    }
    this.open.delete(reservation.reservation_id);
    this.reservedCost -= stored.cost_micros;
    this.reservedPrompt -= stored.prompt_tokens;
    this.reservedOutput -= stored.output_tokens;
    return stored.cost_micros;
  }

  snapshot(): LedgerSnapshot {
    return {
      cost_used_micros: this.cost_used_micros,
      prompt_used: this.used.prompt_tokens,
      output_used: this.used.output_tokens,
      cost_remaining_micros: Math.max(
        0,
        this.budget.max_cost_micros - this.cost_used_micros - this.reservedCost,
      ),
      prompt_remaining: Math.max(
        0,
        this.budget.max_prompt_tokens - this.used.prompt_tokens - this.reservedPrompt,
      ),
      output_remaining: Math.max(
        0,
        this.budget.max_output_tokens - this.used.output_tokens - this.reservedOutput,
      ),
      rejected: this.rejected,
      overruns: this.overruns,
    };
  }
}

export interface ModelTier {
  name: string;
  model: string;
  max_context: number;
  supports_tools?: boolean;
  supports_cache?: boolean;
}

export interface RouteRequest {
  phase: string;
  risk: string;
  prompt_tokens: number;
  turn?: number;
  failures?: number;
}

export interface RouteDecision {
  model: string;
  tier: string;
  reason: string;
  switched: boolean;
  escalated: boolean;
}

export class Router {
  tiers: ModelTier[];
  policy: string;
  escalate_after: number;
  hard_after: number;
  switches: number;
  decisions: RouteDecision[];

  constructor(
    tiers: ModelTier[],
    options: { policy?: string; escalate_after?: number; hard_after?: number } = {},
  ) {
    if (tiers.length === 0) throw new Error("至少需要一个模型层级");
    const policy = options.policy ?? "sticky";
    if (policy !== "sticky" && policy !== "per_turn") {
      throw new Error(`未知路由策略：${policy}`);
    }
    const names = tiers.map((tier) => tier.name);
    if (new Set(names).size !== names.length) throw new Error("模型层级名称重复");
    this.tiers = tiers.slice();
    this.policy = policy;
    this.escalate_after = options.escalate_after ?? 1;
    this.hard_after = options.hard_after ?? 3;
    this.switches = 0;
    this.decisions = [];
  }

  private indexOf(model: string): number {
    return this.tiers.findIndex((tier) => tier.model === model);
  }

  private smallestFit(promptTokens: number): number {
    for (let index = 0; index < this.tiers.length; index += 1) {
      const tier = this.tiers[index];
      if ((tier.supports_tools ?? true) && tier.max_context >= promptTokens) return index;
    }
    throw new Error(`没有模型能容纳 ${promptTokens} prompt tokens`);
  }

  select(request: RouteRequest, currentModel = ""): RouteDecision {
    const fit = this.smallestFit(request.prompt_tokens);
    const current = this.indexOf(currentModel);
    const failures = request.failures ?? 0;
    let escalated = false;
    let desired: number;
    let reason: string;

    if (request.risk === "destructive" || request.risk === "external") {
      desired = this.tiers.length - 1;
      reason = `risk:${request.risk}`;
    } else if (failures >= this.hard_after) {
      desired = this.tiers.length - 1;
      reason = `escalation:failures=${failures}`;
      escalated = true;
    } else if (failures >= this.escalate_after) {
      desired = Math.min(1, this.tiers.length - 1);
      reason = `escalation:failures=${failures}`;
      escalated = true;
    } else if (request.phase === "summarize") {
      desired = fit;
      reason = "phase:summarize:cheapest-fit";
    } else if (this.policy === "sticky" && current >= 0 && current >= fit) {
      const tier = this.tiers[current];
      const decision: RouteDecision = {
        model: tier.model,
        tier: tier.name,
        reason: "sticky:current",
        switched: false,
        escalated: false,
      };
      this.decisions.push(decision);
      return decision;
    } else {
      desired = fit;
      reason = fit > 0 ? "context:overflow" : "base:cheapest-fit";
    }

    desired = Math.max(desired, fit);
    if ((failures > 0 || request.risk === "destructive" || request.risk === "external") && current >= 0) {
      desired = Math.max(desired, current);
    }

    const tier = this.tiers[desired];
    const decision: RouteDecision = {
      model: tier.model,
      tier: tier.name,
      reason,
      switched: currentModel !== "" && tier.model !== currentModel,
      escalated,
    };
    if (decision.switched) this.switches += 1;
    this.decisions.push(decision);
    return decision;
  }
}

export type Stability = "static" | "session" | "turn";
const STABILITY: Record<Stability, number> = { static: 0, session: 1, turn: 2 };

export interface PrefixSection {
  name: string;
  text: string;
  stability?: Stability;
}

export interface CachePlan {
  order: string[];
  cacheable_chars: number;
  cacheable_tokens: number;
  naive_tokens: number;
  fingerprint: string;
  reordered: boolean;
  volatile: string[];
}

function fingerprint(sections: PrefixSection[]): string {
  const digest = createHash("sha256");
  for (const section of sections) {
    digest.update(section.name, "utf8");
    digest.update(Buffer.from([0]));
    digest.update(section.text, "utf8");
    digest.update(Buffer.from([1]));
  }
  return digest.digest("hex").slice(0, 16);
}

export function planCache(sections: PrefixSection[]): CachePlan {
  for (const section of sections) {
    const stability = section.stability ?? "static";
    if (!(stability in STABILITY)) {
      throw new Error(`未知稳定性：${section.stability}`);
    }
  }

  const ordered = sections
    .map((section, index) => ({ section, index }))
    .sort((left, right) => {
      const delta =
        STABILITY[left.section.stability ?? "static"] -
        STABILITY[right.section.stability ?? "static"];
      return delta !== 0 ? delta : left.index - right.index;
    })
    .map((item) => item.section);

  const cacheable: PrefixSection[] = [];
  for (const section of ordered) {
    if ((section.stability ?? "static") === "turn") break;
    cacheable.push(section);
  }

  const naive: PrefixSection[] = [];
  for (const section of sections) {
    if ((section.stability ?? "static") === "turn") break;
    naive.push(section);
  }

  const cacheableText = cacheable.map((section) => section.text).join("\n");
  const naiveText = naive.map((section) => section.text).join("\n");
  const order = ordered.map((section) => section.name);
  return {
    order,
    cacheable_chars: cacheableText.length,
    cacheable_tokens: estimateTokens(cacheableText),
    naive_tokens: estimateTokens(naiveText),
    fingerprint: fingerprint(cacheable),
    reordered: order.join(" ") !== sections.map((section) => section.name).join(" "),
    volatile: sections
      .filter((section) => (section.stability ?? "static") === "turn")
      .map((section) => section.name),
  };
}

export class CacheStats {
  uncached_tokens: number;
  read_tokens: number;
  write_tokens: number;
  turns: number;

  constructor() {
    this.uncached_tokens = 0;
    this.read_tokens = 0;
    this.write_tokens = 0;
    this.turns = 0;
  }

  observe(usage: CostUsage): void {
    this.uncached_tokens += usage.input_tokens;
    this.read_tokens += usage.cache_read_tokens;
    this.write_tokens += usage.cache_write_tokens;
    this.turns += 1;
  }

  get prompt_tokens(): number {
    return this.uncached_tokens + this.read_tokens + this.write_tokens;
  }

  get hit_rate(): number {
    return this.prompt_tokens === 0 ? 0 : this.read_tokens / this.prompt_tokens;
  }

  inputSavingsMicros(card: PriceCard): number {
    const baseline = this.prompt_tokens * card.input_micro_per_mtok;
    const actual =
      this.uncached_tokens * card.input_micro_per_mtok +
      this.read_tokens * card.cache_read_micro_per_mtok +
      this.write_tokens * card.cache_write_micro_per_mtok;
    return Math.floor((baseline - actual + MTOK / 2) / MTOK);
  }
}

export class LatencyBreakdown {
  cold_start_ms: number;
  prefill_ms: number;
  decode_ms: number;
  approval_ms: number;
  tool_parallel_ms: number;
  tool_serial_ms: number;

  constructor(
    cold_start_ms: number,
    prefill_ms: number,
    decode_ms: number,
    approval_ms: number,
    tool_parallel_ms: number,
    tool_serial_ms: number,
  ) {
    this.cold_start_ms = cold_start_ms;
    this.prefill_ms = prefill_ms;
    this.decode_ms = decode_ms;
    this.approval_ms = approval_ms;
    this.tool_parallel_ms = tool_parallel_ms;
    this.tool_serial_ms = tool_serial_ms;
  }

  get ttft_ms(): number {
    return this.cold_start_ms + this.prefill_ms;
  }

  get total_parallel_ms(): number {
    return this.ttft_ms + this.decode_ms + this.approval_ms + this.tool_parallel_ms;
  }

  get total_serial_ms(): number {
    return this.ttft_ms + this.decode_ms + this.approval_ms + this.tool_serial_ms;
  }

  get saved_ms(): number {
    return this.total_serial_ms - this.total_parallel_ms;
  }
}

export function latencyBreakdown(options: {
  cold_start_ms?: number;
  prefill_ms?: number;
  decode_ms?: number;
  approval_ms?: number;
  tool_groups?: number[][];
}): LatencyBreakdown {
  const groups = options.tool_groups ?? [];
  let parallel = 0;
  let serial = 0;
  for (const group of groups) {
    if (group.length === 0) continue;
    parallel += Math.max(...group);
    serial += group.reduce((total, value) => total + value, 0);
  }
  return new LatencyBreakdown(
    options.cold_start_ms ?? 0,
    options.prefill_ms ?? 0,
    options.decode_ms ?? 0,
    options.approval_ms ?? 0,
    parallel,
    serial,
  );
}

export interface CostRow {
  model: string;
  turns: number;
  usage: CostUsage;
  cost_micros: number;
  savings_micros: number;
}

export class CostReport {
  catalog: ModelCatalog;
  private rowsByModel: Map<string, CostRow>;

  constructor(catalog: ModelCatalog) {
    this.catalog = catalog;
    this.rowsByModel = new Map();
  }

  record(model: string, usage: CostUsage, turns = 1): void {
    const card = this.catalog.get(model);
    const current = this.rowsByModel.get(model);
    if (current === undefined) {
      this.rowsByModel.set(model, {
        model,
        turns,
        usage,
        cost_micros: card.costMicros(usage),
        savings_micros: card.savingsMicros(usage),
      });
      return;
    }
    const merged = current.usage.add(usage);
    current.turns += turns;
    current.usage = merged;
    current.cost_micros = card.costMicros(merged);
    current.savings_micros = card.savingsMicros(merged);
  }

  get rows(): CostRow[] {
    return Array.from(this.rowsByModel.values());
  }

  get total_cost_micros(): number {
    return this.rows.reduce((total, row) => total + row.cost_micros, 0);
  }

  perSuccessMicros(successes: number): number | null {
    if (successes <= 0) return null;
    return Math.floor(this.total_cost_micros / successes);
  }

  format(): string[] {
    return this.rows.map(
      (row) =>
        `report    ${row.model.padEnd(14)} turns=${row.turns} ` +
        `prompt=${String(row.usage.prompt_tokens).padEnd(6)} ` +
        `output=${String(row.usage.output_tokens).padEnd(5)} ` +
        `cost=$${(row.cost_micros / MTOK).toFixed(6)} ` +
        `savings=$${(row.savings_micros / MTOK).toFixed(6)}`,
    );
  }
}
