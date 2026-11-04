import fs from "node:fs";
import path from "node:path";

import { Message } from "./types.ts";
import type { ModelResponse } from "./types.ts";
import { splitLines } from "./util.ts";

function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0)!;
  return (code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff);
}

export function estimateTokens(text: string): number {
  if (text === "") return 1;
  let cjk = 0;
  let total = 0;
  for (const ch of text) {
    total += 1;
    if (isCjk(ch)) cjk += 1;
  }
  const other = total - cjk;
  return Math.max(1, cjk + Math.ceil(other / 4)) + 4;
}

export class ContextBudget {
  window: number;
  output_reserve: number;
  safety_margin: number;
  tool_result_cap: number;
  compact_at: number;

  constructor(window = 4000, output_reserve = 700, safety_margin = 120, tool_result_cap = 500, compact_at = 0.85) {
    this.window = window;
    this.output_reserve = output_reserve;
    this.safety_margin = safety_margin;
    this.tool_result_cap = tool_result_cap;
    this.compact_at = compact_at;
  }

  get usable_input(): number {
    return this.window - this.output_reserve - this.safety_margin;
  }

  get compact_threshold(): number {
    return Math.trunc(this.usable_input * this.compact_at);
  }
}

export class BuildReport {
  messages: Message[];
  estimated_tokens: number;
  fixed_tokens: number;
  history_tokens: number;
  dropped: number;
  externalized: string[];

  constructor(messages: Message[], estimated_tokens: number, fixed_tokens: number, history_tokens: number, dropped: number, externalized: string[]) {
    this.messages = messages;
    this.estimated_tokens = estimated_tokens;
    this.fixed_tokens = fixed_tokens;
    this.history_tokens = history_tokens;
    this.dropped = dropped;
    this.externalized = externalized;
  }
}

export class ContextBuilder {
  budget: ContextBudget;
  system_prompt: string;
  tool_specs: string;
  memory: string;
  workspace: string;
  external_dir: string;

  constructor(
    budget: ContextBudget,
    options: { system_prompt: string; tool_specs: string; memory?: string; workspace: string },
  ) {
    this.budget = budget;
    this.system_prompt = options.system_prompt;
    this.tool_specs = options.tool_specs;
    this.memory = options.memory ?? "";
    this.workspace = options.workspace;
    this.external_dir = path.join(this.workspace, ".minicoder", "observations");
  }

  assemble(history: Message[]): BuildReport {
    const fixed = [new Message("system", this.system_prompt)];
    if (this.tool_specs !== "") fixed.push(new Message("system", this.tool_specs));
    if (this.memory !== "") fixed.push(new Message("system", this.memory));
    const fixedTokens = fixed.reduce((sum, message) => sum + estimateTokens(message.content), 0);
    const allowance = this.budget.usable_input - fixedTokens;

    const kept: Message[] = [];
    let used = 0;
    let dropped = 0;
    const externalized: string[] = [];
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const message = history[index];
      let content = message.content;
      let tokens = estimateTokens(content);
      if (message.role === "tool" && tokens > this.budget.tool_result_cap) {
        const [preview, rel] = this.externalize(message, content, externalized.length);
        content = preview;
        tokens = estimateTokens(content);
        externalized.push(rel);
      }
      if (used + tokens > allowance) {
        dropped = history.length - kept.length;
        break;
      }
      kept.push(new Message(message.role, content, message.tool_call_id, message.tool_calls));
      used += tokens;
    }
    kept.reverse();
    return new BuildReport(fixed.concat(kept), fixedTokens + used, fixedTokens, used, dropped, externalized);
  }

  private externalize(message: Message, content: string, index: number): [string, string] {
    fs.mkdirSync(this.external_dir, { recursive: true });
    const name = `${message.tool_call_id ?? "observation"}-${index}.txt`;
    const file = path.join(this.external_dir, name);
    fs.writeFileSync(file, content, "utf8");
    const rel = path.relative(this.workspace, file).split(path.sep).join("/");
    const head = splitLines(content).slice(0, 5).join("\n");
    const preview = `[观察已外置] 原始 ${[...content].length} 字符，写入 ${rel}。前 5 行：\n${head}\n需要时用 read_file 分段读取。`;
    return [preview, rel];
  }
}

export function needsCompaction(history: Message[], budget: ContextBudget, fixedTokens = 0): boolean {
  return history.reduce((sum, message) => sum + estimateTokens(message.content), fixedTokens) > budget.compact_threshold;
}

export const SUMMARY_PROMPT =
  "你是上下文压缩器。把给定历史压缩成不超过 200 字的摘要，必须保留：\n" +
  "1. 任务目标与硬约束；2. 已完成的修改与验证结果；3. 当前计划与未决问题；\n" +
  "4. 失败原因与下一步。不要编造未发生的事实。";

const MARKERS = ["目标", "约束", "下一步"];

export class CompactionResult {
  messages: Message[];
  summary: string;
  before_tokens: number;
  after_tokens: number;
  kept_recent: number;
  degraded: boolean;
  transcript_path: string;

  constructor(
    messages: Message[],
    summary: string,
    before_tokens: number,
    after_tokens: number,
    kept_recent: number,
    degraded: boolean,
    transcript_path: string,
  ) {
    this.messages = messages;
    this.summary = summary;
    this.before_tokens = before_tokens;
    this.after_tokens = after_tokens;
    this.kept_recent = kept_recent;
    this.degraded = degraded;
    this.transcript_path = transcript_path;
  }
}

function render(message: Message): string {
  if (message.role === "tool") return `[tool ${message.tool_call_id ?? ""}] ${message.content}`;
  return `[${message.role}] ${message.content}`;
}

function fallback(messages: Message[]): string {
  const users = messages.filter((message) => message.role === "user").map((message) => message.content);
  const last = users.length > 0 ? users[users.length - 1].slice(0, 120) : "（无用户消息）";
  return `摘要生成失败，已降级。最近用户输入：${last}。请以工作区与验证结果为准。`;
}

function validateSummary(summary: string, limit: number): [string, boolean] {
  let text = summary.trim();
  let degraded = false;
  if (text.length > limit) {
    text = text.slice(0, limit) + "…";
    degraded = true;
  }
  const missing = MARKERS.filter((marker) => !text.includes(marker));
  if (missing.length > 0) {
    degraded = true;
    text += "\n[校验提示] 摘要缺少：" + missing.join("、");
  }
  return [text, degraded];
}

export type SummaryProvider = {
  complete(messages: Message[], tools?: unknown[], options?: Record<string, unknown>): Promise<ModelResponse>;
};

export async function compact(
  history: Message[],
  budget: ContextBudget,
  provider: SummaryProvider,
  options: { workspace: string; keep_recent?: number; transcript_path?: string | null },
): Promise<CompactionResult> {
  const before = history.reduce((sum, message) => sum + estimateTokens(message.content), 0);
  const keepRecent = options.keep_recent ?? 4;
  const recent = history.slice(-keepRecent);
  const older = history.slice(0, Math.max(0, history.length - keepRecent));
  const transcript = options.transcript_path ?? path.join(options.workspace, ".minicoder", "transcript.jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const lines = older.map(
    (message) => JSON.stringify({ role: message.role, content: message.content, tool_call_id: message.tool_call_id }) + "\n",
  );
  fs.appendFileSync(transcript, lines.join(""), "utf8");
  const rel = path.relative(path.resolve(options.workspace), path.resolve(transcript));
  const transcriptRel = rel.startsWith("..") || path.isAbsolute(rel) ? transcript : rel.split(path.sep).join("/");

  if (older.length === 0) {
    return new CompactionResult(history.slice(), "", before, before, recent.length, false, transcriptRel);
  }

  const prompt = [new Message("system", SUMMARY_PROMPT), new Message("user", older.map(render).join("\n"))];
  let degraded = false;
  let summary = "";
  try {
    const response = await provider.complete(prompt, []);
    [summary, degraded] = validateSummary(response.text, Math.max(80, Math.trunc(budget.usable_input / 6)));
    if (summary === "") throw new Error("empty summary");
  } catch {
    summary = fallback(older);
    degraded = true;
  }

  const summaryMessage = new Message("system", `[压缩摘要]\n${summary}\n[完整历史] ${transcriptRel}`);
  const newHistory = [summaryMessage, ...recent];
  const after = newHistory.reduce((sum, message) => sum + estimateTokens(message.content), 0);
  return new CompactionResult(newHistory, summary, before, after, recent.length, degraded, transcriptRel);
}
