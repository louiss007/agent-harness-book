import { padRight } from "../util.ts";
import type { JudgeRow } from "./judge.ts";
import { tokens } from "./types.ts";
import type { EvalResult } from "./types.ts";

export function renderReport(
  results: EvalResult[],
  judgeRows: JudgeRow[],
  rerunIdentical: boolean,
): string[] {
  const lines = ["== MiniCoder eval =="];
  for (const result of results) {
    const status = result.passed ? "pass" : "fail";
    lines.push(
      `task      ${padRight(result.task_id, 20)} ${padRight(status, 5)} ` +
        `reason=${padRight(result.reason, 14)} ` +
        `tools=${result.tools_ok}/${result.tools_failed}/${result.tools_blocked} ` +
        `turns=${result.turns} tokens=${tokens(result)}`,
    );
    for (const check of result.checks) {
      lines.push(
        `check     ${padRight(check.name, 20)} ${padRight(check.ok ? "pass" : "fail", 5)} ${check.detail}`,
      );
    }
  }
  const passed = results.filter((result) => result.passed).length;
  lines.push(`summary   pass=${passed}/${results.length}`);
  for (const row of judgeRows) {
    lines.push(
      `judge     ${padRight(row.name, 20)} ${row.score}/${row.max_score} ` +
        `threshold=${row.threshold} ${row.passed ? "pass" : "fail"}`,
    );
  }
  lines.push(
    `golden    rerun_identical=${rerunIdentical ? "True" : "False"} tasks=${results.length}`,
  );
  return lines;
}
