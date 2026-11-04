import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ContextBudget } from "./context.ts";
import { ApprovalResult } from "./permissions.ts";
import type { ApprovalRequest, Approver } from "./permissions.ts";
import { ScriptedProvider, response } from "./provider.ts";
import { HarnessConfig, MiniCoder, makeDemoHooks } from "./runtime.ts";
import { buildTrace, mergeChild, redactArgs, renderTree, replay, summarize } from "./trace.ts";
import type { StoredEvent } from "./trace.ts";

const ORIGINAL = `"""演示用的迷你应用。"""
TOKEN = "sk-live-123"

def add(a, b):
    return a + b

def sub(a, b):
    return a - b

def mul(a, b):
    return a * b

def div(a, b):
    return a / b

def clamp(value, low, high):
    # TODO: 输入校验
    if value < low:
        return low
    if value > high:
        return high
    return value

def describe(value):
    if value > 0:
        return "positive"
    if value < 0:
        return "negative"
    return "zero"

def main():
    print(add(1, 2))

if __name__ == "__main__":
    main()
`;

const FIXED = `"""演示用的迷你应用。"""
TOKEN = "env:MINICODER_TOKEN"

def add(a, b):
    return a + b

def sub(a, b):
    return a - b

def mul(a, b):
    return a * b

def div(a, b):
    return a / b

def clamp(value, low, high):
    if not isinstance(value, (int, float)):
        raise TypeError("value 必须是数字")
    if low > high:
        raise ValueError("low 不能大于 high")
    if value < low:
        return low
    if value > high:
        return high
    return value

def describe(value):
    if value > 0:
        return "positive"
    if value < 0:
        return "negative"
    return "zero"

def main():
    print(add(1, 2))

if __name__ == "__main__":
    main()
`;

class DemoApprover implements Approver {
  approve(request: ApprovalRequest): ApprovalResult {
    const action = request.action;
    if (action.tool === "write_file" && action.target === "src/app.py") {
      return new ApprovalResult("allow_once", "演示：单次允许修改源码");
    }
    if (action.tool === "run_command" && action.argv[0] === "python3") {
      return new ApprovalResult("allow_session", "演示：本会话允许运行 python3");
    }
    return new ApprovalResult("deny", "演示：其余动作拒绝");
  }
}

function readEvents(file: string): StoredEvent[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as StoredEvent);
}

function pyList(values: unknown[]): string {
  return `[${values.map((value) => `'${String(value)}'`).join(", ")}]`;
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minicoder-trace-"));
  const host = path.join(root, "workspace");
  fs.mkdirSync(path.join(host, "src"), { recursive: true });
  fs.writeFileSync(path.join(host, "src", "app.py"), ORIGINAL, "utf8");

  const coder = new MiniCoder(
    new HarnessConfig({
      workspace: host,
      session_id: "demo-14",
      budget: new ContextBudget(900, 220, 68, 500, 0.85),
      keep_sandbox_workspace: false,
    }),
    new ScriptedProvider([
      response("", [{ id: "c1", name: "read_file", args: { path: "src/app.py" } }]),
      response("", [{ id: "c2", name: "write_file", args: { path: "src/app.py", content: FIXED } }]),
      response("", [{ id: "c3", name: "run_command", args: { argv: ["python3", "src/app.py"] } }]),
      response("", [{ id: "c4", name: "run_command", args: { argv: ["rm", "-rf", "build"] } }]),
      response("已修复 src/app.py 的 TODO，并运行 python3 src/app.py 验证通过。"),
    ]),
    { approver: new DemoApprover(), hooks: makeDemoHooks() },
  );
  const result = await coder.run("修复 src/app.py 中的 TODO 并验证", ["只改 src 下的文件"]);
  const trace = buildTrace(readEvents(coder.store.events_path), { session_id: "demo-14" });

  const child: StoredEvent[] = [
    {
      seq: 1,
      type: "sub:dg-1:tool_intent",
      data: { call_id: "d1", tool: "read_file", args: { path: "src/app.py" } },
    },
    {
      seq: 2,
      type: "sub:dg-1:tool_finished",
      data: { call_id: "d1", tool: "read_file", ok: true, summary: "read src/app.py" },
    },
  ];
  const merged = mergeChild(trace, "dg-1", child, "investigator");
  const summary = summarize(trace, result.usage.input_tokens, result.usage.output_tokens);

  console.log("== Trace demo ==");
  console.log(`trace     id=${trace.trace_id.slice(0, 8)} spans=${trace.spans.length}`);
  for (const line of renderTree(trace)) console.log("span      " + line);
  console.log(
    `metrics   turns=${summary.turns} tools=${summary.tool_attempts} ok=${summary.tool_ok} ` +
      `failed=${summary.tool_failed} blocked=${summary.tool_blocked} approvals=${summary.approvals} ` +
      `wait=${summary.approval_wait} compactions=${summary.compactions} subagents=${summary.subagents} ` +
      `reason=${summary.reason} tokens=${summary.input_tokens}/${summary.output_tokens}`,
  );

  const sample = redactArgs("run_command", {
    argv: ["curl", "-H", "Authorization: Bearer sk-live-999", "--token", "sk-live-999"],
    cwd: ".",
  });
  const leaked = JSON.stringify(sample).includes("sk-live-999");
  console.log(`redact    secret_visible=${leaked ? "True" : "False"} argv=${pyList(sample.argv as unknown[])}`);

  const last = trace.spans[trace.spans.length - 1];
  console.log(`child     merged=${merged} parent=subagent.investigator status=${last.status}`);
  for (const line of replay(trace, 9)) console.log("replay    " + line);

  coder.close();
  fs.rmSync(root, { recursive: true, force: true });
}

await main();
