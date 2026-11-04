// 第 19 章：责任分配与脚手架退场的判定模型。

export type Owner = "model" | "harness" | "external";
export type ScaffoldKind = "compensation" | "invariant" | "interface";
export type Action = "retire" | "thin" | "keep" | "harden";

export interface Responsibility {
  name: string;
  failureCost: number;
  frequency: number;
  selfVerifiable: boolean;
}

export interface Allocation {
  name: string;
  owner: Owner;
  risk: number;
  reason: string;
}

export interface Scaffold {
  name: string;
  kind: ScaffoldKind;
  failureCost: number;
  frequency: number;
  selfVerifiable: boolean;
  baseline: number;
  probe: number;
  regressionBudget?: number;
}

export interface Decision {
  name: string;
  kind: ScaffoldKind;
  risk: number;
  action: Action;
  reason: string;
  delta: number;
}

export interface Contract {
  name: string;
  since: number;
  policy: string;
}

export function allocate(item: Responsibility): Allocation {
  const risk = item.failureCost * item.frequency;
  let owner: Owner;
  let reason: string;
  if (risk >= 16) {
    owner = "external";
    reason = "irreversible_or_adversarial";
  } else if (risk >= 8) {
    owner = "harness";
    reason = "guarded_by_verification";
  } else if (!item.selfVerifiable) {
    owner = "harness";
    reason = "needs_external_feedback";
  } else {
    owner = "model";
    reason = "cheap_and_self_verifiable";
  }
  return { name: item.name, owner, risk, reason };
}

export function decide(item: Scaffold): Decision {
  const risk = item.failureCost * item.frequency;
  const budget = item.regressionBudget ?? 0.02;
  const delta = item.probe - item.baseline;
  let action: Action;
  let reason: string;
  if (item.kind === "invariant") {
    action = risk >= 16 ? "harden" : "keep";
    reason = "world_constraint";
  } else if (item.kind === "interface") {
    action = "keep";
    reason = "compatibility";
  } else if (item.probe >= 0.9 && delta >= -budget) {
    action = "retire";
    reason = "probe_meets_bar";
  } else if (item.probe >= 0.85 && delta >= -(budget * 3)) {
    action = "thin";
    reason = "partial_gap";
  } else {
    action = "keep";
    reason = "probe_regression";
  }
  return { name: item.name, kind: item.kind, risk, action, reason, delta };
}

export function summarize(decisions: Decision[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const decision of decisions) {
    counts[decision.action] = (counts[decision.action] ?? 0) + 1;
  }
  return counts;
}

function b(value: boolean): string {
  return value ? "true" : "false";
}

function signed(value: number): string {
  return (value >= 0 ? "+" : "") + value.toFixed(2);
}

export function main(): void {
  console.log("== MiniCoder evolution ==");
  console.log("gate     probe=without-scaffold shadow=on regression_budget=0.02 rollback=on");

  const responsibilities: Responsibility[] = [
    { name: "format-repair", failureCost: 2, frequency: 3, selfVerifiable: true },
    { name: "verify-changes", failureCost: 4, frequency: 3, selfVerifiable: false },
    { name: "prod-write", failureCost: 5, frequency: 4, selfVerifiable: false },
  ];
  for (const item of responsibilities) {
    const result = allocate(item);
    console.log(
      `allocate ${result.name.padEnd(18)} risk=${String(result.risk).padEnd(2)} ` +
        `self_verify=${b(item.selfVerifiable).padEnd(5)} -> ` +
        `${result.owner} reason=${result.reason}`,
    );
  }

  const scaffolds: Scaffold[] = [
    {
      name: "format-hint",
      kind: "compensation",
      failureCost: 1,
      frequency: 3,
      selfVerifiable: true,
      baseline: 0.82,
      probe: 0.94,
    },
    {
      name: "repo-map",
      kind: "compensation",
      failureCost: 2,
      frequency: 4,
      selfVerifiable: true,
      baseline: 0.84,
      probe: 0.86,
    },
    {
      name: "plan-template",
      kind: "compensation",
      failureCost: 3,
      frequency: 3,
      selfVerifiable: false,
      baseline: 0.81,
      probe: 0.78,
    },
    {
      name: "test-gate",
      kind: "invariant",
      failureCost: 4,
      frequency: 5,
      selfVerifiable: false,
      baseline: 0,
      probe: 0,
    },
    {
      name: "sandbox",
      kind: "invariant",
      failureCost: 5,
      frequency: 5,
      selfVerifiable: false,
      baseline: 0,
      probe: 0,
    },
    {
      name: "event-schema",
      kind: "interface",
      failureCost: 4,
      frequency: 4,
      selfVerifiable: true,
      baseline: 0,
      probe: 0,
    },
  ];
  const decisions: Decision[] = [];
  for (const item of scaffolds) {
    const decision = decide(item);
    decisions.push(decision);
    console.log(
      `scaffold ${decision.name.padEnd(18)} kind=${decision.kind.padEnd(12)} ` +
        `risk=${String(decision.risk).padEnd(2)} probe=${item.probe.toFixed(2)} ` +
        `baseline=${item.baseline.toFixed(2)} -> ${decision.action} ` +
        `delta=${signed(decision.delta)}`,
    );
  }

  const contracts: Contract[] = [
    { name: "Provider.complete", since: 3, policy: "versioned" },
    { name: "ToolResult", since: 5, policy: "versioned" },
    { name: "SessionStore.events", since: 7, policy: "append-only" },
    { name: "Action/Decision", since: 11, policy: "versioned" },
    { name: "step_id/journal", since: 18, policy: "append-only" },
  ];
  for (const contract of contracts) {
    console.log(
      `contract ${contract.name.padEnd(24)} since=${String(contract.since).padEnd(2)} ` +
        `policy=${contract.policy}`,
    );
  }

  const counts = summarize(decisions);
  console.log(
    `summary  retire=${counts["retire"] ?? 0} thin=${counts["thin"] ?? 0} ` +
      `keep=${counts["keep"] ?? 0} harden=${counts["harden"] ?? 0} ` +
      `total=${decisions.length}`,
  );
}

main();
