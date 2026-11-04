import path from "node:path";

import { ToolFailure, Workspace } from "./tools.ts";
import type { Tool } from "./tools.ts";
import { canonicalJson, padLeft, padRight, sha256Hex } from "./util.ts";

export type Risk = "read" | "write" | "destructive" | "external";
export type Effect = "allow" | "ask" | "deny";
export type DecisionKind = "allow" | "ask" | "deny";

const RANK: Record<Risk, number> = { read: 0, write: 1, destructive: 2, external: 3 };
const KIND: Record<Effect, DecisionKind> = { allow: "allow", ask: "ask", deny: "deny" };

export function hashAction(tool: string, args: Record<string, unknown>): string {
  return sha256Hex(`${tool}|${canonicalJson(args)}`).slice(0, 12);
}

const DESTRUCTIVE: string[][] = [
  ["rm", "-rf"],
  ["git", "push", "--force"],
  ["sudo"],
  ["mkfs"],
  ["dd"],
  ["shutdown"],
  ["reboot"],
];

const EXTERNAL: string[][] = [
  ["curl"],
  ["wget"],
  ["ssh"],
  ["scp"],
  ["git", "clone"],
  ["pip", "install"],
];

function startsWithPrefix(argv: unknown[], prefix: string[]): boolean {
  if (argv.length < prefix.length) return false;
  return prefix.every((part, index) => String(argv[index]) === part);
}

function maxRisk(a: Risk, b: Risk): Risk {
  return RANK[a] >= RANK[b] ? a : b;
}

export function deriveRisk(tool: Tool, args: Record<string, unknown>): Risk {
  let risk = tool.risk as Risk;
  if (tool.spec.name === "run_command") {
    const argv = (args.argv as unknown[] | undefined) ?? [];
    if (DESTRUCTIVE.some((prefix) => startsWithPrefix(argv, prefix))) risk = maxRisk(risk, "destructive");
    if (EXTERNAL.some((prefix) => startsWithPrefix(argv, prefix))) risk = maxRisk(risk, "external");
  }
  if (tool.spec.name.startsWith("fetch_")) risk = maxRisk(risk, "external");
  return risk;
}

export class Action {
  tool: string;
  args: Record<string, unknown>;
  risk: Risk;
  target: string;
  argv: string[];
  reversible: boolean;
  claimed: string;

  constructor(
    tool: string,
    args: Record<string, unknown>,
    risk: Risk,
    target: string,
    argv: string[] = [],
    reversible = true,
    claimed = "",
  ) {
    this.tool = tool;
    this.args = args;
    this.risk = risk;
    this.target = target;
    this.argv = argv;
    this.reversible = reversible;
    this.claimed = claimed;
  }

  get id(): string {
    return hashAction(this.tool, this.args);
  }
}

export function actionFromTool(tool: Tool, args: Record<string, unknown>, ws: Workspace): Action {
  let target = "";
  let argv: string[] = [];
  if (["read_file", "write_file", "edit_file"].includes(tool.spec.name)) {
    const file = ws.resolve(args.path);
    target = path.relative(ws.root, file).split(path.sep).join("/");
  } else if (tool.spec.name === "run_command") {
    argv = ((args.argv as unknown[] | undefined) ?? []).map((part) => String(part));
    target = argv.join(" ");
  } else if (tool.spec.name.startsWith("fetch_")) {
    try {
      target = (new URL(String(args.url ?? "")).hostname || "").toLowerCase();
    } catch {
      target = "";
    }
  }
  const risk = deriveRisk(tool, args);
  return new Action(tool.spec.name, { ...args }, risk, target, argv, risk !== "destructive");
}

export class Rule {
  name: string;
  effect: Effect;
  tools: string[];
  risks: Risk[];
  path_glob: string;
  command_prefix: string[];
  reason: string;

  constructor(
    name: string,
    effect: Effect,
    tools: string[] = ["*"],
    risks: Risk[] = [],
    path_glob = "",
    command_prefix: string[] = [],
    reason = "",
  ) {
    this.name = name;
    this.effect = effect;
    this.tools = tools;
    this.risks = risks;
    this.path_glob = path_glob;
    this.command_prefix = command_prefix;
    this.reason = reason;
  }

  matches(action: Action): boolean {
    if (!this.tools.includes("*") && !this.tools.includes(action.tool)) return false;
    if (this.risks.length > 0 && !this.risks.includes(action.risk)) return false;
    if (this.path_glob !== "" && !globMatch(this.path_glob, action.target)) return false;
    if (this.command_prefix.length > 0 && !startsWithPrefix(action.argv, this.command_prefix)) return false;
    return true;
  }
}

function globMatch(glob: string, value: string): boolean {
  const pattern = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${pattern}$`).test(value);
}

export class Decision {
  kind: DecisionKind;
  rule: string;
  reason: string;
  risk: Risk;
  target: string;

  constructor(kind: DecisionKind, rule: string, reason: string, risk: Risk, target: string) {
    this.kind = kind;
    this.rule = rule;
    this.reason = reason;
    this.risk = risk;
    this.target = target;
  }
}

export class Policy {
  rules: Rule[];
  default: Effect;

  constructor(rules: Rule[], defaultEffect: Effect = "deny") {
    this.rules = rules;
    this.default = defaultEffect;
  }

  evaluate(action: Action): Decision {
    const matched = this.rules.filter((rule) => rule.matches(action));
    for (const effect of ["deny", "ask", "allow"] as Effect[]) {
      for (const rule of matched) {
        if (rule.effect === effect) {
          return new Decision(KIND[effect], rule.name, rule.reason, action.risk, action.target);
        }
      }
    }
    return new Decision(KIND[this.default], "default", "没有匹配的规则，按默认拒绝处理", action.risk, action.target);
  }
}

export class Grant {
  tool: string;
  target: string;
  expires_at: number;
  rule: string;

  constructor(tool: string, target: string, expires_at: number, rule: string) {
    this.tool = tool;
    this.target = target;
    this.expires_at = expires_at;
    this.rule = rule;
  }

  covers(action: Action, now: number): boolean {
    return this.tool === action.tool && this.target === action.target && now < this.expires_at;
  }
}

export class ApprovalRequest {
  action: Action;
  reason: string;
  deadline: number;
  options: string[];

  constructor(action: Action, reason: string, deadline: number, options: string[] = ["allow_once", "allow_session", "deny"]) {
    this.action = action;
    this.reason = reason;
    this.deadline = deadline;
    this.options = options;
  }

  render(): string {
    const real = this.action.argv.length > 0 ? this.action.argv.join(" ") : this.action.target;
    return [
      `审批请求 #${this.action.id}`,
      `  工具: ${this.action.tool}  风险: ${this.action.risk}`,
      `  真实动作: ${real}`,
      `  目标: ${this.action.target}  可逆: ${this.action.reversible ? "true" : "false"}`,
      `  原因: ${this.reason}`,
    ].join("\n");
  }
}

export class ApprovalResult {
  decision: string;
  note: string;

  constructor(decision: string, note = "") {
    this.decision = decision;
    this.note = note;
  }
}

export interface Approver {
  approve(request: ApprovalRequest): ApprovalResult;
}

export class HeadlessApprover implements Approver {
  approve(_request: ApprovalRequest): ApprovalResult {
    return new ApprovalResult("deny", "headless: no interactive approver");
  }
}

export class AuditRecord {
  seq: number;
  action_id: string;
  tool: string;
  target: string;
  risk: string;
  decision: string;
  rule: string;
  approver: string;
  reason: string;

  constructor(
    seq: number,
    action_id: string,
    tool: string,
    target: string,
    risk: string,
    decision: string,
    rule: string,
    approver: string,
    reason: string,
  ) {
    this.seq = seq;
    this.action_id = action_id;
    this.tool = tool;
    this.target = target;
    this.risk = risk;
    this.decision = decision;
    this.rule = rule;
    this.approver = approver;
    this.reason = reason;
  }
}

export class PermissionEngine {
  policy: Policy;
  approver: Approver;
  session_ttl: number;
  tick = 0;
  grants: Grant[] = [];
  records: AuditRecord[] = [];

  constructor(policy: Policy, approver: Approver, session_ttl = 10) {
    this.policy = policy;
    this.approver = approver;
    this.session_ttl = session_ttl;
  }

  private record(action: Action, decision: string, rule: string, approver: string, reason: string): void {
    this.records.push(
      new AuditRecord(this.records.length + 1, action.id, action.tool, action.target, action.risk, decision, rule, approver, reason),
    );
  }

  private grant(action: Action): Decision | null {
    for (const grant of this.grants) {
      if (grant.covers(action, this.tick)) {
        return new Decision("allow", `grant:${grant.rule}`, "会话授权仍然有效", action.risk, action.target);
      }
    }
    return null;
  }

  check(action: Action): Decision {
    const decision = this.policy.evaluate(action);
    if (decision.kind === "deny") return decision;
    return this.grant(action) ?? decision;
  }

  authorize(action: Action): Decision {
    const decision = this.check(action);
    if (decision.kind === "allow") {
      this.record(action, "allow", decision.rule, "policy", decision.reason);
      return decision;
    }
    if (decision.kind === "deny") {
      this.record(action, "deny", decision.rule, "policy", decision.reason);
      return decision;
    }
    const request = new ApprovalRequest(action, decision.reason, this.tick + 5);
    const result = this.approver.approve(request);
    if (result.decision === "allow_once") {
      this.record(action, "approve_once", decision.rule, "human", result.note);
      return new Decision("allow", "approval:once", "人工单次批准", action.risk, action.target);
    }
    if (result.decision === "allow_session") {
      this.grants.push(new Grant(action.tool, action.target, this.tick + this.session_ttl, decision.rule));
      this.record(action, "approve_session", decision.rule, "human", result.note);
      return new Decision("allow", "approval:session", "人工会话授权", action.risk, action.target);
    }
    if (result.decision === "expired") {
      this.record(action, "expired", "approval-expired", "timeout", "审批超时，按拒绝处理");
      return new Decision("deny", "approval-expired", "审批超时", action.risk, action.target);
    }
    this.record(action, "deny_by_human", "approval-denied", "human", result.note);
    return new Decision("deny", "approval-denied", "人工拒绝", action.risk, action.target);
  }
}

export function defaultPolicy(): Policy {
  return new Policy(
    [
      new Rule("protect-secrets", "deny", ["*"], [], "secrets/*", [], "凭证目录禁止访问"),
      new Rule("deny-force-push", "deny", ["run_command"], [], "", ["git", "push", "--force"], "强制推送不可逆"),
      new Rule("deny-sudo", "deny", ["run_command"], [], "", ["sudo"], "禁止提权"),
      new Rule("read-source", "allow", ["*"], ["read"], "src/*", [], "工作区源码只读"),
      new Rule("write-source", "ask", ["write_file", "edit_file"], ["write"], "src/*", [], "写入工作区源码需确认"),
      new Rule("network-review", "ask", ["*"], ["external"], "", [], "外部请求逐次确认"),
      new Rule("destructive-review", "ask", ["*"], ["destructive"], "", [], "破坏性操作需确认"),
      new Rule("read-default", "allow", ["*"], ["read"], "", [], "只读操作默认放行"),
    ],
    "deny",
  );
}

export function auditLines(records: AuditRecord[]): string[] {
  return records.map(
    (record) =>
      `${padLeft(String(record.seq), 2)} ${padRight(record.decision, 14)} ${padRight(record.tool, 12)} rule=${record.rule}`,
  );
}

export { ToolFailure };
