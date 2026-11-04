import { estimateTokens } from "./context.ts";
import {
  BudgetExceeded,
  BudgetLedger,
  CacheStats,
  CostReport,
  CostUsage,
  ModelCatalog,
  costUsageFrom,
} from "./cost.ts";
import type { Reservation, RouteDecision, Router, TaskBudget } from "./cost.ts";
import type { Action, ApprovalRequest, ApprovalResult, Risk } from "./permissions.ts";
import type { Provider } from "./provider.ts";
import type { Message, ModelResponse, ToolSpec } from "./types.ts";

export const TOPOLOGIES = ["headless", "service", "worker"] as const;
export const SANDBOX_SCOPES = ["task", "session"] as const;

export interface TenantPolicy {
  tenant: string;
  max_concurrent: number;
  requests_per_minute: number;
  daily_token_budget: number;
  daily_cost_micros: number;
  sandbox_scope: string;
}

export interface DeploymentManifest {
  version: string;
  topology: string;
  policy_version: string;
  secret_refs: string[];
  tenants: TenantPolicy[];
  canary_percent: number;
  headless_preauthorized: boolean;
}

export function tenantPolicy(
  tenant: string,
  maxConcurrent = 1,
  requestsPerMinute = 60,
  dailyTokenBudget = 1_000_000,
  dailyCostMicros = 5_000_000,
  sandboxScope = "task",
): TenantPolicy {
  return {
    tenant,
    max_concurrent: maxConcurrent,
    requests_per_minute: requestsPerMinute,
    daily_token_budget: dailyTokenBudget,
    daily_cost_micros: dailyCostMicros,
    sandbox_scope: sandboxScope,
  };
}

export function deploymentManifest(options: {
  version: string;
  topology: string;
  policy_version: string;
  secret_refs: string[];
  tenants: TenantPolicy[];
  canary_percent?: number;
  headless_preauthorized?: boolean;
}): DeploymentManifest {
  return {
    version: options.version,
    topology: options.topology,
    policy_version: options.policy_version,
    secret_refs: options.secret_refs.slice(),
    tenants: options.tenants.slice(),
    canary_percent: options.canary_percent ?? 0,
    headless_preauthorized: options.headless_preauthorized ?? false,
  };
}

export function validateManifest(manifest: DeploymentManifest): string[] {
  const issues: string[] = [];
  if (!(TOPOLOGIES as readonly string[]).includes(manifest.topology)) issues.push("topology");
  if (manifest.version === "") issues.push("version");
  if (manifest.policy_version === "") issues.push("policy-version");
  if (manifest.canary_percent < 0 || manifest.canary_percent > 100) issues.push("canary-percent");
  if (manifest.tenants.length === 0) issues.push("tenants");

  const seen = new Set<string>();
  for (const tenant of manifest.tenants) {
    if (seen.has(tenant.tenant)) issues.push(`duplicate-tenant:${tenant.tenant}`);
    seen.add(tenant.tenant);
    if (!(SANDBOX_SCOPES as readonly string[]).includes(tenant.sandbox_scope)) {
      issues.push(`sandbox-scope:${tenant.tenant}`);
    }
    if (tenant.max_concurrent < 1) issues.push(`concurrency:${tenant.tenant}`);
    if (tenant.requests_per_minute < 1) issues.push(`rate:${tenant.tenant}`);
  }

  for (const ref of manifest.secret_refs) {
    if (!ref.startsWith("env:") && !ref.startsWith("vault:") && !ref.startsWith("file:")) {
      issues.push(`secret-ref:${ref}`);
    }
  }

  if (manifest.topology === "headless" && !manifest.headless_preauthorized) {
    issues.push("headless-preauth");
  }
  return issues;
}

export interface RateDecision {
  allowed: boolean;
  remaining: number;
  retry_after_ms: number;
}

interface Bucket {
  tokens_milli: number;
  updated_ms: number;
}

export class RateLimiter {
  capacity_milli: number;
  refill_per_minute: number;
  private buckets: Map<string, Bucket>;

  constructor(capacity: number, refillPerMinute: number) {
    if (capacity < 1 || refillPerMinute < 1) throw new Error("限流容量与速率必须为正");
    this.capacity_milli = capacity * 1000;
    this.refill_per_minute = refillPerMinute;
    this.buckets = new Map();
  }

  take(key: string, tokens: number, nowMs: number): RateDecision {
    if (tokens < 1) throw new Error("请求数必须为正");
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { tokens_milli: this.capacity_milli, updated_ms: nowMs };
      this.buckets.set(key, bucket);
    }
    const elapsed = Math.max(0, nowMs - bucket.updated_ms);
    const refill = Math.floor((this.refill_per_minute * elapsed) / 60);
    const available = Math.min(this.capacity_milli, bucket.tokens_milli + refill);
    const cost = tokens * 1000;
    bucket.updated_ms = nowMs;
    if (available >= cost) {
      bucket.tokens_milli = available - cost;
      return { allowed: true, remaining: Math.floor(bucket.tokens_milli / 1000), retry_after_ms: 0 };
    }
    const need = cost - available;
    const retryAfter = Math.ceil((need * 60) / this.refill_per_minute);
    bucket.tokens_milli = available;
    return {
      allowed: false,
      remaining: Math.floor(available / 1000),
      retry_after_ms: retryAfter,
    };
  }
}

export interface Admission {
  granted: boolean;
  tenant: string;
  reason: string;
  reservation: Reservation | null;
  retry_after_ms: number;
  detail: string;
}

interface TenantState {
  policy: TenantPolicy;
  limiter: RateLimiter;
  ledger: BudgetLedger;
  active: number;
  closed: Set<number>;
}

export class AdmissionController {
  catalog: ModelCatalog;
  private states: Map<string, TenantState>;

  constructor(catalog: ModelCatalog, policies: TenantPolicy[]) {
    this.catalog = catalog;
    this.states = new Map();
    for (const policy of policies) {
      if (this.states.has(policy.tenant)) throw new Error(`重复的租户：${policy.tenant}`);
      this.states.set(policy.tenant, {
        policy,
        limiter: new RateLimiter(policy.requests_per_minute, policy.requests_per_minute),
        ledger: new BudgetLedger(
          {
            max_cost_micros: policy.daily_cost_micros,
            max_prompt_tokens: policy.daily_token_budget,
            max_output_tokens: policy.daily_token_budget,
          } satisfies TaskBudget,
          catalog,
        ),
        active: 0,
        closed: new Set(),
      });
    }
  }

  private state(tenant: string): TenantState {
    const state = this.states.get(tenant);
    if (state === undefined) throw new Error(`未知租户：${tenant}`);
    return state;
  }

  active(tenant: string): number {
    return this.state(tenant).active;
  }

  admit(
    tenant: string,
    model: string,
    promptTokens: number,
    outputTokens: number,
    nowMs: number,
  ): Admission {
    const state = this.state(tenant);
    const policy = state.policy;
    if (state.active >= policy.max_concurrent) {
      return {
        granted: false,
        tenant,
        reason: "concurrency",
        reservation: null,
        retry_after_ms: 0,
        detail: `${state.active}/${policy.max_concurrent}`,
      };
    }
    const rate = state.limiter.take(tenant, 1, nowMs);
    if (!rate.allowed) {
      return {
        granted: false,
        tenant,
        reason: "rate_limit",
        reservation: null,
        retry_after_ms: rate.retry_after_ms,
        detail: `remaining=${rate.remaining}`,
      };
    }
    try {
      const reservation = state.ledger.reserve(model, promptTokens, outputTokens);
      state.active += 1;
      return {
        granted: true,
        tenant,
        reason: "admitted",
        reservation,
        retry_after_ms: 0,
        detail: "",
      };
    } catch (error) {
      if (error instanceof BudgetExceeded) {
        return {
          granted: false,
          tenant,
          reason: "budget",
          reservation: null,
          retry_after_ms: 0,
          detail: `${error.scope}:${error.requested}>${error.remaining}`,
        };
      }
      throw error;
    }
  }

  settle(admission: Admission, usage: CostUsage): number {
    if (!admission.granted || admission.reservation === null) {
      throw new Error("未准入的请求不能结算");
    }
    const state = this.state(admission.tenant);
    const key = admission.reservation.reservation_id;
    if (state.closed.has(key)) throw new Error("重复结算预算预留");
    state.closed.add(key);
    state.active -= 1;
    return state.ledger.settle(admission.reservation, usage);
  }

  release(admission: Admission): number {
    if (!admission.granted || admission.reservation === null) return 0;
    const state = this.state(admission.tenant);
    const key = admission.reservation.reservation_id;
    if (state.closed.has(key)) throw new Error("重复释放预算预留");
    state.closed.add(key);
    state.active -= 1;
    return state.ledger.release(admission.reservation);
  }
}

export type BreakerState = "closed" | "open" | "half_open";

export interface BreakerSnapshot {
  state: BreakerState;
  failures: number;
  opened_at_ms: number;
}

export class CircuitBreaker {
  failure_threshold: number;
  cooldown_ms: number;
  state: BreakerState;
  failures: number;
  opened_at_ms: number;
  private trial: boolean;

  constructor(failureThreshold = 2, cooldownMs = 1000) {
    if (failureThreshold < 1 || cooldownMs < 0) throw new Error("熔断参数不合法");
    this.failure_threshold = failureThreshold;
    this.cooldown_ms = cooldownMs;
    this.state = "closed";
    this.failures = 0;
    this.opened_at_ms = 0;
    this.trial = false;
  }

  allow(nowMs: number): boolean {
    if (this.state === "open") {
      if (nowMs - this.opened_at_ms < this.cooldown_ms) return false;
      this.state = "half_open";
      this.trial = false;
    }
    if (this.state === "half_open") {
      if (this.trial) return false;
      this.trial = true;
      return true;
    }
    return true;
  }

  recordSuccess(): void {
    this.state = "closed";
    this.failures = 0;
    this.opened_at_ms = 0;
    this.trial = false;
  }

  recordFailure(nowMs: number): void {
    this.failures += 1;
    this.trial = false;
    if (this.state === "half_open" || this.failures >= this.failure_threshold) {
      this.state = "open";
      this.opened_at_ms = nowMs;
    }
  }

  snapshot(): BreakerSnapshot {
    return { state: this.state, failures: this.failures, opened_at_ms: this.opened_at_ms };
  }
}

export type CallErrorKind = "transient" | "rate_limited" | "timeout" | "permanent";

export class ModelCallError extends Error {
  kind: CallErrorKind;
  retry_after_ms: number;

  constructor(kind: CallErrorKind, message: string, retryAfterMs = 0) {
    super(message);
    this.name = "ModelCallError";
    this.kind = kind;
    this.retry_after_ms = retryAfterMs;
  }
}

export class RetryPolicy {
  max_attempts: number;
  base_ms: number;
  max_ms: number;
  jitter_permille: number;

  constructor(maxAttempts = 3, baseMs = 200, maxMs = 2000, jitterPermille = 200) {
    this.max_attempts = maxAttempts;
    this.base_ms = baseMs;
    this.max_ms = maxMs;
    this.jitter_permille = jitterPermille;
  }

  retryable(kind: CallErrorKind): boolean {
    return kind === "transient" || kind === "rate_limited" || kind === "timeout";
  }

  delayMs(attempt: number, seed: number): number {
    const exponent = Math.min(20, Math.max(0, attempt - 1));
    const base = Math.min(this.max_ms, this.base_ms * 2 ** exponent);
    const noise = (seed * 1_103_515_245 + attempt * 12_345) & 0x7fffffff;
    const jitter = Math.floor((base * this.jitter_permille * (noise % 1000)) / 100_000);
    return base + jitter;
  }
}

export function noCache(_response: ModelResponse): [number, number] {
  return [0, 0];
}

export interface ProviderBinding {
  name: string;
  provider: Provider;
  models: string[];
  fallbacks: string[];
  cache_reader: (response: ModelResponse) => [number, number];
}

export function providerBinding(options: {
  name: string;
  provider: Provider;
  models: string[];
  fallbacks?: string[];
  cache_reader?: (response: ModelResponse) => [number, number];
}): ProviderBinding {
  return {
    name: options.name,
    provider: options.provider,
    models: options.models.slice(),
    fallbacks: (options.fallbacks ?? []).slice(),
    cache_reader: options.cache_reader ?? noCache,
  };
}

export class ProviderRegistry {
  private byModel: Map<string, ProviderBinding>;

  constructor() {
    this.byModel = new Map();
  }

  register(binding: ProviderBinding): void {
    for (const model of binding.models) {
      if (this.byModel.has(model)) throw new Error(`模型重复注册：${model}`);
      this.byModel.set(model, binding);
    }
  }

  bindingFor(model: string): ProviderBinding {
    const binding = this.byModel.get(model);
    if (binding === undefined) throw new Error(`没有为模型注册 Provider：${model}`);
    return binding;
  }

  models(): string[] {
    return Array.from(this.byModel.keys()).sort();
  }
}

function estimatePrompt(messages: Message[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message.content) + 4, 0);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GovernedProvider implements Provider {
  registry: ProviderRegistry;
  router: Router;
  admission: AdmissionController;
  tenant: string;
  catalog: ModelCatalog;
  cost_report: CostReport;
  retry: RetryPolicy;
  breaker_threshold: number;
  breaker_cooldown_ms: number;
  clock: () => number;
  sleeper: (ms: number) => Promise<void>;
  seed: number;
  current_model: string;
  cache: CacheStats;
  events: Array<Record<string, unknown>>;
  breakers: Map<string, CircuitBreaker>;

  constructor(options: {
    registry: ProviderRegistry;
    router: Router;
    admission: AdmissionController;
    tenant: string;
    catalog: ModelCatalog;
    cost_report: CostReport;
    retry?: RetryPolicy;
    breaker_threshold?: number;
    breaker_cooldown_ms?: number;
    clock?: () => number;
    sleeper?: (ms: number) => Promise<void>;
    seed?: number;
  }) {
    this.registry = options.registry;
    this.router = options.router;
    this.admission = options.admission;
    this.tenant = options.tenant;
    this.catalog = options.catalog;
    this.cost_report = options.cost_report;
    this.retry = options.retry ?? new RetryPolicy();
    this.breaker_threshold = options.breaker_threshold ?? 2;
    this.breaker_cooldown_ms = options.breaker_cooldown_ms ?? 1000;
    this.clock = options.clock ?? (() => 0);
    this.sleeper = options.sleeper ?? defaultSleep;
    this.seed = options.seed ?? 7;
    this.current_model = "";
    this.cache = new CacheStats();
    this.events = [];
    this.breakers = new Map();
  }

  async complete(
    messages: Message[],
    tools: ToolSpec[] = [],
    options: Record<string, unknown> = {},
  ): Promise<ModelResponse> {
    const promptTokens = Number(options.prompt_tokens ?? estimatePrompt(messages));
    const outputTokens = Number(options.output_tokens ?? 512);
    const preferred = String(options.preferred_model ?? "");

    let decision: RouteDecision;
    if (preferred !== "") {
      decision = {
        model: preferred,
        tier: "pinned",
        reason: "pinned:preferred",
        switched: this.current_model !== "" && preferred !== this.current_model,
        escalated: false,
      };
    } else {
      decision = this.router.select(
        {
          phase: String(options.phase ?? "edit"),
          risk: String(options.risk ?? "write"),
          prompt_tokens: promptTokens,
          turn: Number(options.turn ?? 1),
          failures: Number(options.failures ?? 0),
        },
        this.current_model,
      );
    }
    this.current_model = decision.model;
    this.events.push({
      event: "model_routed",
      model: decision.model,
      reason: decision.reason,
      switched: decision.switched,
      prompt_tokens: promptTokens,
    });

    const first = this.registry.bindingFor(decision.model);
    const candidates = [decision.model];
    for (const fallback of first.fallbacks) {
      if (!candidates.includes(fallback)) candidates.push(fallback);
    }

    let lastError: ModelCallError | null = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const model = candidates[index];
      const binding = this.registry.bindingFor(model);
      let breaker = this.breakers.get(model);
      if (breaker === undefined) {
        breaker = new CircuitBreaker(this.breaker_threshold, this.breaker_cooldown_ms);
        this.breakers.set(model, breaker);
      }
      if (!breaker.allow(this.clock())) {
        lastError = new ModelCallError("permanent", "circuit_open");
        this.events.push({ event: "breaker_open", model });
        continue;
      }

      let stopAll = false;
      for (let attempt = 1; attempt <= this.retry.max_attempts; attempt += 1) {
        const admission = this.admission.admit(
          this.tenant,
          model,
          promptTokens,
          outputTokens,
          this.clock(),
        );
        if (!admission.granted) {
          lastError = new ModelCallError(
            admission.reason === "rate_limit" ? "rate_limited" : "permanent",
            admission.reason,
          );
          this.events.push({
            event: "admission_denied",
            reason: admission.reason,
            detail: admission.detail,
          });
          stopAll = true;
          break;
        }
        this.events.push({
          event: "admitted",
          model,
          reservation: admission.reservation?.reservation_id ?? 0,
        });

        let response: ModelResponse;
        try {
          response = await binding.provider.complete(messages, tools, { ...options, model });
        } catch (error) {
          const refund = this.admission.release(admission);
          breaker.recordFailure(this.clock());
          if (error instanceof ModelCallError) {
            lastError = error;
            this.events.push({
              event: "attempt_failed",
              model,
              attempt,
              kind: error.kind,
              refund,
            });
            if (this.retry.retryable(error.kind) && attempt < this.retry.max_attempts) {
              const delay = error.retry_after_ms || this.retry.delayMs(attempt, this.seed);
              this.events.push({ event: "retry_scheduled", delay_ms: delay });
              await this.sleeper(delay);
              continue;
            }
          } else {
            lastError = new ModelCallError("permanent", String(error));
            this.events.push({
              event: "attempt_failed",
              model,
              attempt,
              kind: "permanent",
              refund,
            });
          }
          break;
        }

        const [cacheRead, cacheWrite] = binding.cache_reader(response);
        const usage = costUsageFrom(response.usage, cacheRead, cacheWrite);
        const refund = this.admission.settle(admission, usage);
        breaker.recordSuccess();
        this.cost_report.record(model, usage);
        this.cache.observe(usage);
        this.events.push({
          event: "call_succeeded",
          model,
          attempt,
          refund,
          cost_micros: this.catalog.get(model).costMicros(usage),
        });
        return response;
      }

      if (stopAll) break;
      if (index + 1 < candidates.length) {
        this.events.push({ event: "failover", from: model, to: candidates[index + 1] });
      }
    }

    throw lastError ?? new ModelCallError("permanent", "no provider available");
  }
}

export interface Lease {
  task_id: string;
  owner: string;
  fencing_token: number;
  expires_at_ms: number;
}

export interface DrainReport {
  draining: boolean;
  active: number;
  forced: number;
}

export class LeaseManager {
  lease_ms: number;
  draining: boolean;
  private leases: Map<string, Lease>;
  private nextToken: number;

  constructor(leaseMs = 5000) {
    this.lease_ms = leaseMs;
    this.draining = false;
    this.leases = new Map();
    this.nextToken = 1;
  }

  acquire(taskId: string, owner: string, nowMs: number): Lease | null {
    if (this.draining) return null;
    const current = this.leases.get(taskId);
    if (current !== undefined && current.expires_at_ms > nowMs) {
      return current.owner === owner ? current : null;
    }
    const lease: Lease = {
      task_id: taskId,
      owner,
      fencing_token: this.nextToken,
      expires_at_ms: nowMs + this.lease_ms,
    };
    this.nextToken += 1;
    this.leases.set(taskId, lease);
    return lease;
  }

  renew(lease: Lease, nowMs: number): Lease | null {
    const current = this.leases.get(lease.task_id);
    if (
      current === undefined ||
      current.owner !== lease.owner ||
      current.fencing_token !== lease.fencing_token ||
      current.expires_at_ms <= nowMs
    ) {
      return null;
    }
    const renewed: Lease = {
      task_id: lease.task_id,
      owner: lease.owner,
      fencing_token: lease.fencing_token,
      expires_at_ms: nowMs + this.lease_ms,
    };
    this.leases.set(lease.task_id, renewed);
    return renewed;
  }

  release(lease: Lease): boolean {
    const current = this.leases.get(lease.task_id);
    if (current === undefined || current.fencing_token !== lease.fencing_token) return false;
    this.leases.delete(lease.task_id);
    return true;
  }

  beginDrain(): void {
    this.draining = true;
  }

  drainReport(nowMs: number, deadlineMs: number): DrainReport {
    let active = 0;
    for (const lease of this.leases.values()) {
      if (lease.expires_at_ms > nowMs) active += 1;
    }
    let forced = 0;
    if (nowMs >= deadlineMs) {
      forced = this.leases.size;
      this.leases.clear();
    }
    return { draining: this.draining, active, forced };
  }
}

const RISK_RANK: Record<Risk, number> = {
  read: 0,
  write: 1,
  destructive: 2,
  external: 3,
};

export interface Grant {
  ticket: string;
  tool: string;
  target_prefix: string;
  max_risk: Risk;
  expires_at_ms: number;
}

export class PreauthorizedApprover {
  grants: Grant[];
  clock: () => number;

  constructor(grants: Grant[], clock: () => number) {
    this.grants = grants.slice();
    this.clock = clock;
  }

  approve(request: ApprovalRequest): ApprovalResult {
    const now = this.clock();
    for (const grant of this.grants) {
      const action: Action = request.action;
      if (now > grant.expires_at_ms) continue;
      if (action.tool !== grant.tool) continue;
      if (!action.target.startsWith(grant.target_prefix)) continue;
      if (RISK_RANK[action.risk] > RISK_RANK[grant.max_risk]) continue;
      return { decision: "allow_once", note: `preauth:${grant.ticket}` };
    }
    return { decision: "deny", note: "no matching preauthorization" };
  }
}

export function approvalRequest(
  action: Action,
  reason: string,
  deadlineMs = 0,
): ApprovalRequest {
  return { action, reason, deadline: deadlineMs, options: ["allow_once", "allow_session", "deny"] };
}
