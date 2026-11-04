import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ContextBudget } from "./context.ts";
import { ApprovalResult } from "./permissions.ts";
import type { ApprovalRequest, Approver } from "./permissions.ts";
import { ScriptedProvider, response } from "./provider.ts";
import { HarnessConfig, MiniCoder, makeDemoHooks } from "./runtime.ts";
import { detectDrift } from "./session.ts";
import { codePointLength, padLeft, padRight, splitLines } from "./util.ts";

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
  requests: string[] = [];

  approve(request: ApprovalRequest): ApprovalResult {
    const action = request.action;
    const rendered = action.argv.length > 0 ? action.argv.join(" ") : action.target;
    this.requests.push(`${action.tool} ${rendered}`);
    if (action.tool === "write_file" && action.target === "src/app.py") {
      return new ApprovalResult("allow_once", "演示：单次允许修改源码");
    }
    if (action.tool === "run_command" && action.argv[0] === "python3") {
      return new ApprovalResult("allow_session", "演示：本会话允许运行 python3");
    }
    return new ApprovalResult("deny", "演示：其余动作拒绝");
  }
}

type EventRecord = {
  seq: number;
  type: string;
  ts: string;
  data: Record<string, unknown>;
};

function readEvents(file: string): EventRecord[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as EventRecord);
}

function normalize(text: string): string {
  return text.replace(/ in \d+\.\d+s/g, "").replace(/\[sandbox sbx-\d+\]/g, "[sandbox]").trim();
}

function pyBool(value: boolean): string {
  return value ? "True" : "False";
}

function pyList(items: string[]): string {
  return `[${items.map((item) => `'${item}'`).join(", ")}]`;
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minicoder-demo-"));
  const host = path.join(root, "workspace");
  fs.mkdirSync(path.join(host, "src"), { recursive: true });
  fs.writeFileSync(path.join(host, "src", "app.py"), ORIGINAL, "utf8");

  const approver = new DemoApprover();
  const coder = new MiniCoder(
    new HarnessConfig({
      workspace: host,
      session_id: "demo-13",
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
    { approver, hooks: makeDemoHooks() },
  );

  const result = await coder.run("修复 src/app.py 中的 TODO 并验证", ["只改 src 下的文件"]);
  const events = readEvents(coder.store.events_path);

  console.log("== MiniCoder demo ==");
  console.log(
    `loop      ${result.reason} turns=${result.turns} tools=${result.tool_calls} compactions=${result.compactions}`,
  );
  console.log(`usage     input=${result.usage.input_tokens} output=${result.usage.output_tokens}`);

  for (const event of events) {
    if (["tool_committed", "tool_failed", "tool_blocked"].includes(event.type)) {
      const data = event.data;
      const status = event.type === "tool_committed" ? "ok" : event.type === "tool_blocked" ? "blocked" : "failed";
      const detail = String(data.reason ?? data.error ?? "");
      const line = `tool      ${padRight(String(data.call_id), 3)} ${padRight(String(data.tool), 11)} ${padRight(status, 7)} ${detail}`;
      console.log(line.replace(/\s+$/, ""));
    }
  }

  const transcriptPath = path.join(coder.store.dir, "transcript.jsonl");
  const transcript = fs.existsSync(transcriptPath) ? fs.readFileSync(transcriptPath, "utf8") : "";
  const visible = transcript + "\n" + result.messages.map((message) => message.content).join("\n");
  console.log(
    `read      lines=${splitLines(ORIGINAL).length} secret_visible=${pyBool(visible.includes("sk-live-123"))} ` +
      `redacted=${pyBool(transcript.includes("sk-***"))}`,
  );

  const finalFile = path.join(coder.ws.root, "src", "app.py");
  const hostFile = path.join(host, "src", "app.py");
  console.log(
    `write     chars=${codePointLength(FIXED)} applied=${pyBool(fs.readFileSync(finalFile, "utf8") === FIXED)}`,
  );
  console.log(`host      unchanged=${pyBool(fs.readFileSync(hostFile, "utf8") === ORIGINAL)}`);

  for (const event of events) {
    if (event.type === "context_compacted") {
      const data = event.data;
      console.log(
        `compact   before=${data.before_tokens} after=${data.after_tokens} ` +
          `kept_recent=${data.kept_recent} degraded=${pyBool(Boolean(data.degraded))}`,
      );
    }
  }

  for (const event of events) {
    if (event.type === "hook_finished") {
      const data = event.data;
      const trace = (data.trace as string[]).join(",");
      console.log(`hook      ${padRight(String(data.event), 11)} ${padRight(String(data.action), 8)} ${trace}`);
    }
  }

  for (const record of coder.permissions.records) {
    console.log(
      `audit     ${String(record.seq).padStart(2, "0")} ${padRight(record.decision, 14)} ${padRight(record.tool, 11)} rule=${record.rule}`,
    );
  }

  const intent = events.find((event) => event.type === "tool_intent" && event.data.call_id === "c3");
  if (intent !== undefined) {
    const argv = (intent.data.args as Record<string, unknown>).argv as string[];
    console.log(`intent    c3 args=${pyList(argv)} key=${intent.data.idempotency_key}`);
  }

  const recovered = coder.recover();
  const drift = detectDrift(recovered.state, coder.ws.root);
  console.log(
    `recover   source=${recovered.source} replayed=${recovered.replayed} ` +
      `files=${Object.keys(recovered.state.files).length} drift=${drift.length > 0 ? drift.join(",") : "none"}`,
  );

  const info = coder.close();
  console.log(`sandbox   runs=${info.runs} kept=${pyBool(Boolean(info.kept_workspace))}`);
  fs.rmSync(root, { recursive: true, force: true });
}

await main();
