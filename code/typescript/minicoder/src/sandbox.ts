import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

import { sha256Hex } from "./util.ts";

export const DEFAULT_ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "TERM"];

export class SandboxError extends Error {}

export class SandboxSpec {
  read_only_base: string | null;
  env_allowlist: string[];
  timeout_s: number;
  max_output_chars: number;
  network: string;
  backend: string;
  keep_workspace: boolean;

  constructor(
    read_only_base: string | null = null,
    env_allowlist: string[] = DEFAULT_ENV_ALLOWLIST,
    timeout_s = 30.0,
    max_output_chars = 4000,
    network = "deny",
    backend = "local",
    keep_workspace = false,
  ) {
    this.read_only_base = read_only_base;
    this.env_allowlist = env_allowlist;
    this.timeout_s = timeout_s;
    this.max_output_chars = max_output_chars;
    this.network = network;
    this.backend = backend;
    this.keep_workspace = keep_workspace;
  }
}

export class SandboxHandle {
  sandbox_id: string;
  spec: SandboxSpec;
  root: string;
  workspace: string;
  state = "ready";
  runs = 0;
  created_at: number;

  constructor(sandbox_id: string, spec: SandboxSpec, root: string, workspace: string) {
    this.sandbox_id = sandbox_id;
    this.spec = spec;
    this.root = root;
    this.workspace = workspace;
    this.created_at = performance.now();
  }

  resolveCwd(raw: string | null): string {
    const candidate = path.resolve(this.workspace, raw ?? ".");
    const rel = path.relative(this.workspace, candidate);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new SandboxError(`工作目录 ${JSON.stringify(raw)} 超出沙箱工作区`);
    }
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
      throw new SandboxError(`工作目录不存在：${JSON.stringify(raw)}`);
    }
    return candidate;
  }

  buildEnv(extra: Record<string, string> | null = null): Record<string, string> {
    const env: Record<string, string> = {
      HOME: path.join(this.root, "home"),
      TMPDIR: path.join(this.root, "tmp"),
    };
    for (const name of this.spec.env_allowlist) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    if (extra !== null) {
      for (const [key, value] of Object.entries(extra)) {
        if (!this.spec.env_allowlist.includes(key)) {
          throw new SandboxError(`环境变量 ${key} 不在白名单内`);
        }
        env[key] = value;
      }
    }
    return env;
  }
}

export class CommandResult {
  sandbox_id: string;
  argv: string[];
  exit_code: number | null;
  signal: string;
  stdout: string;
  stderr: string;
  duration_s: number;
  timed_out: boolean;
  stdout_total: number;
  stderr_total: number;
  truncated: boolean;

  constructor(
    sandbox_id: string,
    argv: string[],
    exit_code: number | null,
    signal: string,
    stdout: string,
    stderr: string,
    duration_s: number,
    timed_out: boolean,
    stdout_total: number,
    stderr_total: number,
    truncated: boolean,
  ) {
    this.sandbox_id = sandbox_id;
    this.argv = argv;
    this.exit_code = exit_code;
    this.signal = signal;
    this.stdout = stdout;
    this.stderr = stderr;
    this.duration_s = duration_s;
    this.timed_out = timed_out;
    this.stdout_total = stdout_total;
    this.stderr_total = stderr_total;
    this.truncated = truncated;
  }

  to_observation(max_chars = 1200): string {
    const status = this.timed_out ? "timeout" : `exit=${this.exit_code}`;
    const parts = [`[sandbox ${this.sandbox_id}] ${status} in ${this.duration_s.toFixed(2)}s`];
    if (this.stdout.trim() !== "") parts.push("stdout:\n" + this.stdout.trim());
    if (this.stderr.trim() !== "") parts.push("stderr:\n" + this.stderr.trim());
    if (this.truncated) parts.push("[输出已截断]");
    const text = parts.join("\n");
    return text.length <= max_chars ? text : text.slice(0, max_chars) + "\n…[observation truncated]";
  }
}

function capture(text: string, limit: number): [string, number] {
  if (text.length <= limit) return [text, text.length];
  const head = Math.floor(limit * 0.7);
  const tail = limit - head;
  return [text.slice(0, head) + `\n...（省略 ${text.length - limit} 字符）...\n` + text.slice(-tail), text.length];
}

let counter = 0;

export function createSandbox(spec: SandboxSpec): SandboxHandle {
  if (spec.backend !== "local") {
    throw new SandboxError(`教学实现只提供 local 后端；${spec.backend} 需要真实隔离运行时`);
  }
  counter += 1;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "minicoder-sbx-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(root, "home"));
  fs.mkdirSync(path.join(root, "tmp"));
  if (spec.read_only_base !== null) {
    fs.cpSync(fs.realpathSync(spec.read_only_base), workspace, { recursive: true });
  }
  return new SandboxHandle(`sbx-${String(counter).padStart(4, "0")}`, spec, root, fs.realpathSync(workspace));
}

export function runCommand(
  handle: SandboxHandle,
  argv: string[],
  options: { cwd?: string | null; timeout_s?: number | null; env?: Record<string, string> | null } = {},
): CommandResult {
  if (handle.state !== "ready") throw new SandboxError(`沙箱 ${handle.sandbox_id} 已关闭`);
  if (argv.length === 0 || argv.some((item) => typeof item !== "string")) {
    throw new SandboxError("argv 必须是非空字符串数组");
  }
  const cwd = handle.resolveCwd(options.cwd ?? null);
  const timeout = options.timeout_s ?? handle.spec.timeout_s;
  const started = performance.now();
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env: handle.buildEnv(options.env ?? null),
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: timeout * 1000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const duration = (performance.now() - started) / 1000;
  const timedOut = result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  const code = result.status;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const [out, outTotal] = capture(stdout, handle.spec.max_output_chars);
  const [err, errTotal] = capture(stderr, handle.spec.max_output_chars);
  handle.runs += 1;
  return new CommandResult(
    handle.sandbox_id,
    argv,
    timedOut ? null : code,
    result.signal ?? "",
    out,
    err,
    duration,
    timedOut,
    outTotal,
    errTotal,
    outTotal > handle.spec.max_output_chars || errTotal > handle.spec.max_output_chars,
  );
}

export function destroySandbox(handle: SandboxHandle): Record<string, unknown> {
  if (handle.state === "closed") {
    return { sandbox_id: handle.sandbox_id, runs: handle.runs, state: "closed" };
  }
  handle.state = "closed";
  if (!handle.spec.keep_workspace) fs.rmSync(handle.root, { recursive: true, force: true });
  return {
    sandbox_id: handle.sandbox_id,
    runs: handle.runs,
    kept_workspace: handle.spec.keep_workspace,
    state: "closed",
  };
}

export function manifest(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) result[path.relative(root, full).split(path.sep).join("/")] = sha256Hex(fs.readFileSync(full));
    }
  };
  walk(root);
  return result;
}
