export type EvalTask = {
  id: string;
  goal: string;
  constraints: string[];
  fixture: string;
  allow_write: string[];
  budget: Record<string, unknown>;
  script: Array<Record<string, unknown>>;
  checks: Record<string, unknown>;
};

export type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
};

export type EvalResult = {
  task_id: string;
  passed: boolean;
  checks: CheckResult[];
  reason: string;
  turns: number;
  tools_ok: number;
  tools_failed: number;
  tools_blocked: number;
  compactions: number;
  input_tokens: number;
  output_tokens: number;
  answer: string;
};

export function tokens(result: EvalResult): number {
  return result.input_tokens + result.output_tokens;
}

export function fingerprint(result: EvalResult): string {
  return [
    result.task_id,
    result.passed ? "1" : "0",
    result.reason,
    result.turns,
    result.tools_ok,
    result.tools_failed,
    result.tools_blocked,
    result.compactions,
    tokens(result),
    result.checks.map((check) => `${check.name}:${check.ok ? "1" : "0"}`).join(","),
  ].join("|");
}
