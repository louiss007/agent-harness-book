import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadTasks } from "./eval/dataset.ts";
import { ScriptedJudge } from "./eval/judge.ts";
import type { JudgeRow } from "./eval/judge.ts";
import { renderReport } from "./eval/report.ts";
import { runSuite } from "./eval/runner.ts";
import { fingerprint } from "./eval/types.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const TASKS = path.join(ROOT, "eval", "tasks.jsonl");
const FIXTURES = path.join(ROOT, "eval", "fixtures");

async function main(): Promise<void> {
  const tasks = loadTasks(TASKS);
  const first = await runSuite(tasks, FIXTURES);
  const second = await runSuite(tasks, FIXTURES);
  const identical =
    first.map(fingerprint).join("||") === second.map(fingerprint).join("||");

  const judge = new ScriptedJudge([2, 5]);
  const rubric = "答案必须说明修改内容与验证结果";
  const rows: JudgeRow[] = [];
  for (const [name, answer] of [
    ["vague-answer", "我改好了。"],
    ["specific-answer", "修复了 clamp 的输入校验，运行 python3 src/app.py 输出 3。"],
  ] as Array<[string, string]>) {
    const score = await judge.score("修复 TODO", answer, rubric);
    rows.push({ name, score: score.score, max_score: score.max_score, threshold: 4, passed: score.score >= 4 });
  }

  for (const line of renderReport(first, rows, identical)) {
    console.log(line);
  }
}

await main();
