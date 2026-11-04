import fs from "node:fs";
import path from "node:path";

import { ToolResult } from "./types.ts";
import type { ToolCall, ToolSpec } from "./types.ts";
import { padLeft, splitLines } from "./util.ts";

export class ToolFailure extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class SchemaError extends Error {}

const TYPE_CHECKS: Record<string, (value: unknown) => boolean> = {
  object: (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  array: (value) => Array.isArray(value),
  string: (value) => typeof value === "string",
  integer: (value) => typeof value === "number" && Number.isInteger(value),
  number: (value) => typeof value === "number",
  boolean: (value) => typeof value === "boolean",
};

export function validateArgs(schema: Record<string, unknown>, args: unknown, at = "$"): void {
  const expected = schema.type as string | undefined;
  if (expected !== undefined && TYPE_CHECKS[expected] !== undefined && !TYPE_CHECKS[expected](args)) {
    throw new SchemaError(`${at} 应为 ${expected}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(args)) {
    throw new SchemaError(`${at} 必须是 ${JSON.stringify(schema.enum)} 之一`);
  }
  if (expected === "object") {
    const object = args as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in object)) throw new SchemaError(`缺少必填参数 ${at}.${key}`);
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(object).filter((key) => !(key in props)).sort();
      if (extra.length > 0) throw new SchemaError(`出现未定义参数 ${at}.${extra[0]}`);
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in object) validateArgs(sub, object[key], `${at}.${key}`);
    }
  }
  if (expected === "array" && schema.items !== undefined) {
    (args as unknown[]).forEach((item, index) => validateArgs(schema.items as Record<string, unknown>, item, `${at}[${index}]`));
  }
}

export class Workspace {
  root: string;

  constructor(root: string) {
    this.root = fs.realpathSync(path.resolve(root));
  }

  resolve(raw: unknown): string {
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new ToolFailure("invalid_args", "path 必须是非空字符串");
    }
    const candidate = path.resolve(this.root, raw);
    const resolved = fs.existsSync(candidate) ? fs.realpathSync(candidate) : candidate;
    const rel = path.relative(this.root, resolved);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return resolved;
    throw new ToolFailure("path_outside_workspace", `路径 ${JSON.stringify(raw)} 超出工作区`);
  }
}

export type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

export class Tool {
  spec: ToolSpec;
  handler: Handler;
  parallel_safe: boolean;
  risk: string;
  timeout_s: number;

  constructor(spec: ToolSpec, handler: Handler, parallel_safe = false, risk = "read", timeout_s = 15.0) {
    this.spec = spec;
    this.handler = handler;
    this.parallel_safe = parallel_safe;
    this.risk = risk;
    this.timeout_s = timeout_s;
  }
}

const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register(tool: Tool): void {
    const name = tool.spec.name;
    if (!NAME_RE.test(name)) throw new Error(`工具名 ${JSON.stringify(name)} 不合法`);
    if (this.tools.has(name)) throw new Error(`工具名 ${JSON.stringify(name)} 重复注册`);
    const params = tool.spec.parameters;
    if (params.type !== "object" || typeof params.properties !== "object" || params.properties === null) {
      throw new Error(`工具 ${name} 的参数 Schema 必须是 object`);
    }
    if (params.additionalProperties !== false) {
      throw new Error(`工具 ${name} 必须显式设置 additionalProperties=false`);
    }
    if (tool.parallel_safe && tool.risk !== "read") {
      throw new Error(`工具 ${name} 的写操作不能声明 parallel_safe`);
    }
    this.tools.set(name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  specs(): ToolSpec[] {
    return [...this.tools.keys()].sort().map((name) => this.tools.get(name)!.spec);
  }
}

export function truncateText(text: string, maxChars: number, head = 6, tail = 6): [string, boolean] {
  if (text.length <= maxChars) return [text, false];
  const lines = splitLines(text);
  if (lines.length > head + tail + 1) {
    const omitted = lines.length - head - tail;
    return [[...lines.slice(0, head), `...（省略 ${omitted} 行）...`, ...lines.slice(-tail)].join("\n"), true];
  }
  return [text.slice(0, maxChars) + "\n...（省略部分内容）...", true];
}

function numbered(lines: string[], start: number): string {
  return lines.map((line, index) => `${padLeft(String(start + index), 4)}\t${line}`).join("\n");
}

function readFileHandler(ws: Workspace): Handler {
  return async (args) => {
    const file = ws.resolve(args.path);
    if (!fs.existsSync(file)) throw new ToolFailure("not_found", `文件不存在：${String(args.path)}`);
    const text = fs.readFileSync(file, "utf8");
    const offset = Number(args.offset ?? 1);
    const limit = Number(args.limit ?? 200);
    if (offset < 1 || limit < 1) throw new ToolFailure("invalid_args", "offset 与 limit 必须大于等于 1");
    const lines = splitLines(text);
    const window = lines.slice(offset - 1, offset - 1 + limit);
    return new ToolResult(true, numbered(window, offset), null, "", offset - 1 + window.length < lines.length, {
      total_lines: lines.length,
      returned_lines: window.length,
    });
  };
}

function writeFileHandler(ws: Workspace): Handler {
  return async (args) => {
    const file = ws.resolve(args.path);
    if (!fs.existsSync(path.dirname(file))) {
      throw new ToolFailure("parent_missing", `父目录不存在：${path.dirname(file)}`);
    }
    const content = String(args.content);
    fs.writeFileSync(file, content, "utf8");
    const rel = path.relative(ws.root, file).split(path.sep).join("/");
    return new ToolResult(true, `已写入 ${[...content].length} 个字符到 ${rel}`, null, "", false, {
      path: rel,
      chars: [...content].length,
    });
  };
}

export function buildRegistry(ws: Workspace): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    new Tool(
      {
        name: "read_file",
        description: "读取工作区内的 UTF-8 文本文件，返回带行号的内容；只读。",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["path"],
          properties: {
            path: { type: "string", description: "相对工作区的文件路径" },
            offset: { type: "integer", description: "起始行，默认 1" },
            limit: { type: "integer", description: "最多返回行数，默认 200" },
          },
        },
      },
      readFileHandler(ws),
      true,
      "read",
    ),
  );
  registry.register(
    new Tool(
      {
        name: "write_file",
        description: "写入或覆盖工作区内的 UTF-8 文本文件；会改变磁盘内容。",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["path", "content"],
          properties: {
            path: { type: "string", description: "相对工作区的文件路径" },
            content: { type: "string", description: "完整的新文件内容" },
          },
        },
      },
      writeFileHandler(ws),
      false,
      "write",
    ),
  );
  return registry;
}

export type Authorizer = (tool: Tool, args: Record<string, unknown>) => ToolResult | null;

function timeoutPromise<T>(promise: Promise<T>, seconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ToolFailure("timeout", `执行超过 ${seconds} 秒`)), seconds * 1000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class ToolExecutor {
  registry: ToolRegistry;
  authorize: Authorizer | null;
  max_result_chars: number;

  constructor(registry: ToolRegistry, authorize: Authorizer | null = null, max_result_chars = 1600) {
    this.registry = registry;
    this.authorize = authorize;
    this.max_result_chars = max_result_chars;
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const tool = this.registry.get(call.name);
    if (tool === undefined) {
      const known = this.registry.specs().map((spec) => spec.name).join(", ");
      return new ToolResult(false, "", `未知工具 ${JSON.stringify(call.name)}。可用工具：${known}`, "unknown_tool");
    }
    try {
      validateArgs(tool.spec.parameters, call.args);
    } catch (error) {
      if (error instanceof SchemaError) {
        return new ToolResult(false, "", `参数不合法：${error.message}`, "invalid_args");
      }
      throw error;
    }
    if (this.authorize !== null) {
      const denied = this.authorize(tool, call.args);
      if (denied !== null) return denied;
    }
    let result: ToolResult;
    try {
      result = await timeoutPromise(tool.handler(call.args), tool.timeout_s);
    } catch (error) {
      if (error instanceof ToolFailure) {
        return new ToolResult(false, "", error.message, error.code);
      }
      if (error instanceof Error && error.message.startsWith("执行超过")) {
        return new ToolResult(false, "", error.message, "timeout");
      }
      return new ToolResult(false, "", `工具内部错误：${error instanceof Error ? error.constructor.name : "Error"}`, "execution_failed");
    }
    const [content, cut] = truncateText(result.content, this.max_result_chars);
    const metadata = { ...result.metadata };
    if (cut) metadata.original_chars = result.content.length;
    return new ToolResult(result.ok, content, result.error, result.error_code, result.truncated || cut, metadata);
  }
}
