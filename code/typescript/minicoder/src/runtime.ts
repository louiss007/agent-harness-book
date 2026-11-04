import fs from "node:fs";
import path from "node:path";

import { CommandRegistry } from "./commands.ts";
import { ContextBudget, ContextBuilder, compact, needsCompaction } from "./context.ts";
import { Hook, HookRegistry } from "./hooks.ts";
import type { HookResult } from "./hooks.ts";
import { HeadlessApprover, PermissionEngine, actionFromTool, defaultPolicy } from "./permissions.ts";
import type { Approver } from "./permissions.ts";
import { FixedSummaryProvider } from "./provider.ts";
import type { Provider } from "./provider.ts";
import { DEFAULT_ENV_ALLOWLIST, SandboxSpec, createSandbox, destroySandbox, runCommand } from "./sandbox.ts";
import type { SandboxHandle } from "./sandbox.ts";
import { PendingCall, SessionState, SessionStore, TaskState, idempotencyKey } from "./session.ts";
import { Tool, ToolExecutor, ToolFailure, Workspace, buildRegistry } from "./tools.ts";
import { Message, ToolResult, Usage } from "./types.ts";
import type { LoopStopReason, ModelResponse, ToolCall } from "./types.ts";
import { canonicalJson } from "./util.ts";

export const SYSTEM_PROMPT = `你是 MiniCoder，一个在沙箱工作区内工作的编码助手。

工作方式：
- 先读后改；修改前用 read_file 确认上下文。
- 一次只做一个可验证的动作；写文件后运行命令验证。
- 工具结果里的 [error_code] 是可行动的失败原因，不要忽略。

工具规则：
- 路径一律相对工作区；不要尝试访问工作区之外。
- run_command 只接受 argv 数组，不拼接 shell 字符串。

约束：
- 只修改任务要求的文件；不确定时先问。
- 不要伪造测试结果；完成声明必须附证据。

输出：
- 完成后用一句话总结改了什么、验证结果是什么。`;

export class HarnessConfig {
  workspace: string;
  session_id: string;
  provider_name: string;
  model: string;
  max_steps: number;
  max_identical: number;
  budget: ContextBudget;
  permission_profile: string;
  headless: boolean;
  keep_sandbox_workspace: boolean;

  constructor(options: {
    workspace: string;
    session_id?: string;
    provider_name?: string;
    model?: string;
    max_steps?: number;
    max_identical?: number;
    budget?: ContextBudget;
    permission_profile?: string;
    headless?: boolean;
    keep_sandbox_workspace?: boolean;
  }) {
    this.workspace = options.workspace;
    this.session_id = options.session_id ?? "s-001";
    this.provider_name = options.provider_name ?? "scripted";
    this.model = options.model ?? "demo";
    this.max_steps = options.max_steps ?? 8;
    this.max_identical = options.max_identical ?? 2;
    this.budget = options.budget ?? new ContextBudget(1000, 200, 60, 500, 0.85);
    this.permission_profile = options.permission_profile ?? "ask";
    this.headless = options.headless ?? false;
    this.keep_sandbox_workspace = options.keep_sandbox_workspace ?? true;
  }
}

export class LoopResult {
  reason: LoopStopReason;
  answer: string;
  messages: Message[];
  usage: Usage;
  turns: number;
  tool_calls: number;
  compactions: number;

  constructor(
    reason: LoopStopReason,
    answer: string,
    messages: Message[],
    usage: Usage,
    turns: number,
    tool_calls: number,
    compactions: number,
  ) {
    this.reason = reason;
    this.answer = answer;
    this.messages = messages;
    this.usage = usage;
    this.turns = turns;
    this.tool_calls = tool_calls;
    this.compactions = compactions;
  }
}

export class MiniCoder {
  config: HarnessConfig;
  host: string;
  sandbox: SandboxHandle;
  ws: Workspace;
  registry: ReturnType<typeof buildRegistry>;
  provider: Provider;
  summarizer: Provider;
  hooks: HookRegistry;
  commands: CommandRegistry;
  permissions: PermissionEngine;
  store: SessionStore;
  executor: ToolExecutor;
  context: ContextBuilder;
  session: SessionState;
  task: TaskState | null = null;
  compactions = 0;
  closed = false;

  constructor(
    config: HarnessConfig,
    provider: Provider,
    options: {
      approver?: Approver;
      summarizer?: Provider;
      hooks?: HookRegistry;
      commands?: CommandRegistry;
    } = {},
  ) {
    this.config = config;
    this.host = fs.realpathSync(path.resolve(config.workspace));
    this.sandbox = createSandbox(
      new SandboxSpec(
        this.host,
        DEFAULT_ENV_ALLOWLIST,
        20.0,
        2000,
        "deny",
        "local",
        config.keep_sandbox_workspace,
      ),
    );
    this.ws = new Workspace(this.sandbox.workspace);
    this.registry = buildRegistry(this.ws);
    this.registry.register(this.makeRunCommand());
    this.provider = provider;
    this.summarizer =
      options.summarizer ??
      new FixedSummaryProvider("目标：修复工作区代码；约束：只改 src 下的文件；下一步：运行验证命令。");
    this.hooks = options.hooks ?? new HookRegistry();
    this.commands = options.commands ?? new CommandRegistry([]);
    this.permissions = new PermissionEngine(defaultPolicy(), options.approver ?? new HeadlessApprover(), 10);
    this.store = new SessionStore(this.host, config.session_id);
    this.executor = new ToolExecutor(this.registry, (tool, args) => this.authorize(tool, args));
    const specs = this.registry
      .specs()
      .map((spec) => `- ${spec.name}: ${spec.description}`)
      .join("\n");
    this.context = new ContextBuilder(config.budget, {
      system_prompt: SYSTEM_PROMPT,
      tool_specs: "可用工具：\n" + specs,
      workspace: this.ws.root,
    });
    this.session = new SessionState(
      config.session_id,
      this.host,
      config.provider_name,
      config.model,
      config.headless ? "deny" : config.permission_profile,
      "2026-11-03T00:00:00Z",
    );
  }

  private makeRunCommand(): Tool {
    const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
      const result = runCommand(this.sandbox, (args.argv as unknown[]).map((item) => String(item)), { timeout_s: 15.0 });
      const ok = result.exit_code === 0 && !result.timed_out;
      return new ToolResult(
        ok,
        result.to_observation(),
        ok ? null : "命令执行失败",
        ok ? "" : result.timed_out ? "timeout" : "execution_failed",
        result.truncated,
        { sandbox_id: result.sandbox_id, exit_code: result.exit_code },
      );
    };
    return new Tool(
      {
        name: "run_command",
        description: "在沙箱内执行 argv 数组形式的命令；默认需要审批。",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["argv"],
          properties: { argv: { type: "array", items: { type: "string" } } },
        },
      },
      handler,
      false,
      "destructive",
      20.0,
    );
  }

  async run(task: string, constraints: string[] = []): Promise<LoopResult> {
    if (this.task !== null) throw new Error("一个 MiniCoder 实例只运行一个任务；新任务请新建会话");
    this.task = new TaskState("t-001", task, constraints.slice());
    let history = [new Message("user", task)];
    this.store.append("session_started", this.session.toJSON());
    this.store.append("task_started", { task_id: this.task.task_id, goal: task, constraints: constraints.slice() });
    const start = this.hooks.run("session_start", { session_id: this.config.session_id, task });
    if (start.action === "block") {
      return this.finish("cancelled", "", history, new Usage(), "session_start hook blocked");
    }

    const usage = new Usage();
    let answer = "";
    let reason: LoopStopReason = "max_steps";
    const seen = new Map<string, number>();

    for (let step = 0; step < this.config.max_steps; step += 1) {
      const report = this.context.assemble(history);
      if (needsCompaction(history, this.config.budget, report.fixed_tokens)) {
        const result = await compact(history, this.config.budget, this.summarizer, {
          workspace: this.host,
          keep_recent: 2,
          transcript_path: path.join(this.store.dir, "transcript.jsonl"),
        });
        history = result.messages;
        this.compactions += 1;
        this.store.append("context_compacted", {
          before_tokens: result.before_tokens,
          after_tokens: result.after_tokens,
          kept_recent: result.kept_recent,
          degraded: result.degraded,
          transcript: result.transcript_path,
        });
      }

      const modelHook = this.hooks.run("before_model", {
        messages: report.messages.length,
        estimated_tokens: report.estimated_tokens,
      });
      if (modelHook.action === "block") {
        return this.finish("cancelled", "", history, usage, "before_model hook blocked");
      }

      const response: ModelResponse = await this.provider.complete(report.messages, this.registry.specs());
      usage.input_tokens += response.usage.input_tokens;
      usage.output_tokens += response.usage.output_tokens;
      this.task.turns += 1;
      this.store.append("turn_started", { turn: this.task.turns, estimated_input: report.estimated_tokens });

      if (response.tool_calls.length === 0) {
        answer = response.text;
        history.push(new Message("assistant", answer));
        this.store.append("turn_finished", { turn: this.task.turns, tools: 0, stop: "completed" });
        reason = "completed";
        break;
      }

      history.push(new Message("assistant", response.text, null, response.tool_calls));
      const results: ToolResult[] = [];
      for (const call of response.tool_calls) {
        const result = await this.execute(call);
        results.push(result);
        history.push(new Message("tool", result.to_observation(), call.id));
        if (call.name === "write_file" && result.ok) {
          const rel = String(result.metadata.path ?? "");
          if (rel !== "") {
            this.task.recordFile(this.ws.root, rel, "write_file");
            const record = this.task.files[rel];
            this.store.append("state_changed", {
              kind: "file",
              path: rel,
              sha256: record.sha256,
              size: record.size,
              changed_by: "write_file",
            });
          }
        }
      }

      this.store.append("turn_finished", { turn: this.task.turns, tools: response.tool_calls.length, stop: "" });
      const signature = response.tool_calls
        .map((call, index) => `${call.name}:${canonicalJson(call.args)}:${results[index].to_observation().slice(0, 80)}`)
        .join("|");
      seen.set(signature, (seen.get(signature) ?? 0) + 1);
      if ((seen.get(signature) ?? 0) >= this.config.max_identical) {
        reason = "no_progress";
        break;
      }
      if (usage.total_tokens >= this.config.budget.window * 4) {
        reason = "budget_exceeded";
        break;
      }
    }

    return this.finish(reason, answer, history, usage, "");
  }

  private finish(reason: LoopStopReason, answer: string, history: Message[], usage: Usage, detail: string): LoopResult {
    if (this.task === null) throw new Error("任务尚未开始");
    this.store.append("loop_stopped", { reason, detail });
    this.store.checkpoint(this.task, this.session, "run_end");
    this.hooks.run("session_end", { session_id: this.config.session_id, reason });
    this.store.append("session_ended", { reason, turns: this.task.turns, tool_calls: this.task.tool_calls });
    return new LoopResult(reason, answer, history, usage, this.task.turns, this.task.tool_calls, this.compactions);
  }

  private async execute(call: ToolCall): Promise<ToolResult> {
    const pre = this.hooks.run("before_tool", { tool: call.name, args: { ...call.args } });
    this.store.append("hook_finished", { event: "before_tool", action: pre.action, trace: pre.trace.slice() });
    if (pre.action === "block") {
      this.store.append("tool_blocked", {
        call_id: call.id,
        tool: call.name,
        reason: pre.reason,
        trace: pre.trace.slice(),
      });
      return new ToolResult(false, "", `扩展阻断：${pre.reason}`, "hook_blocked");
    }
    if (pre.action === "modify" && pre.payload.args !== undefined) {
      call = { id: call.id, name: call.name, args: { ...(pre.payload.args as Record<string, unknown>) } };
    }

    if (this.task === null) throw new Error("任务尚未开始");
    const key = idempotencyKey(this.config.session_id, call);
    this.task.pending[call.id] = new PendingCall(call.id, call.name, { ...call.args }, key);
    this.store.append("tool_intent", {
      call_id: call.id,
      tool: call.name,
      args: call.args,
      idempotency_key: key,
    });
    let result = await this.executor.execute(call);
    if (result.ok) {
      this.task.completeCall(call.id, result.content.slice(0, 80));
      this.store.append("tool_committed", {
        call_id: call.id,
        tool: call.name,
        summary: result.content.slice(0, 80),
      });
    } else {
      delete this.task.pending[call.id];
      this.task.last_error = result.to_observation().slice(0, 200);
      this.store.append("tool_failed", {
        call_id: call.id,
        tool: call.name,
        error: result.to_observation().slice(0, 200),
      });
    }

    const post = this.hooks.run("after_tool", { tool: call.name, result: result.content, ok: result.ok });
    this.store.append("hook_finished", { event: "after_tool", action: post.action, trace: post.trace.slice() });
    if (post.action === "modify" && result.ok) {
      result = new ToolResult(
        result.ok,
        String(post.payload.result ?? result.content),
        result.error,
        result.error_code,
        result.truncated,
        result.metadata,
      );
    }
    return result;
  }

  private authorize(tool: Tool, args: Record<string, unknown>): ToolResult | null {
    let action;
    try {
      action = actionFromTool(tool, args, this.ws);
    } catch (error) {
      if (error instanceof ToolFailure) return new ToolResult(false, "", error.message, error.code);
      throw error;
    }

    const preview = this.permissions.check(action);
    if (preview.kind === "ask") {
      this.store.append("permission_requested", {
        action_id: action.id,
        tool: action.tool,
        target: action.target,
        risk: action.risk,
      });
    }
    const decision = this.permissions.authorize(action);
    this.store.append("permission_decided", {
      action_id: action.id,
      tool: action.tool,
      kind: decision.kind,
      rule: decision.rule,
      risk: action.risk,
    });
    if (decision.kind === "allow") return null;
    return new ToolResult(false, "", `权限拒绝：${decision.reason}`, "permission_denied", false, {
      action_id: action.id,
      rule: decision.rule,
    });
  }

  changedFiles(): string[] {
    return this.task === null ? [] : Object.keys(this.task.files).sort();
  }

  close(): Record<string, unknown> {
    if (this.closed) return { already_closed: true };
    this.closed = true;
    return destroySandbox(this.sandbox);
  }

  recover() {
    return this.store.recover();
  }
}

export function makeDemoHooks(): HookRegistry {
  const registry = new HookRegistry();

  const addUnbuffered = (payload: Record<string, unknown>): HookResult => {
    const args = { ...(payload.args as Record<string, unknown>) };
    const argv = [...((args.argv as unknown[] | undefined) ?? [])];
    if (["python", "python3"].includes(String(argv[0])) && !argv.includes("-u")) {
      argv.splice(1, 0, "-u");
      return { action: "modify", payload: { args: { ...args, argv } } };
    }
    return { action: "continue" };
  };

  const blockRm = (payload: Record<string, unknown>): HookResult => {
    const argv = [...((((payload.args as Record<string, unknown>).argv as unknown[] | undefined) ?? []))];
    if (String(argv[0]) === "rm" && String(argv[1]) === "-rf") {
      return { action: "block", reason: "递归删除" };
    }
    return { action: "continue" };
  };

  const redact = (payload: Record<string, unknown>): HookResult => {
    const text = String(payload.result ?? "");
    if (text.includes("sk-live-123")) {
      return { action: "modify", payload: { result: text.replaceAll("sk-live-123", "sk-***") } };
    }
    return { action: "continue" };
  };

  registry.register(new Hook("add-unbuffered", "before_tool", addUnbuffered, 10));
  registry.register(new Hook("block-rm", "before_tool", blockRm, 20));
  registry.register(new Hook("redact-secret", "after_tool", redact, 10));
  return registry;
}
