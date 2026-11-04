import fs from "node:fs";

import type { EvalTask } from "./types.ts";

export function loadTasks(file: string): EvalTask[] {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const data = JSON.parse(line) as Record<string, unknown>;
      return {
        id: String(data.id),
        goal: String(data.goal),
        constraints: ((data.constraints as unknown[]) ?? []).map((item) => String(item)),
        fixture: String(data.fixture),
        allow_write: ((data.allow_write as unknown[]) ?? []).map((item) => String(item)),
        budget: (data.budget as Record<string, unknown>) ?? {},
        script: (data.script as Array<Record<string, unknown>>) ?? [],
        checks: (data.checks as Record<string, unknown>) ?? {},
      };
    });
}

export function resolveRefs(value: unknown, fixturesRoot: string): unknown {
  if (typeof value === "string" && value.startsWith("@file:")) {
    return fs.readFileSync(`${fixturesRoot}/${value.slice("@file:".length)}`, "utf8");
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveRefs(item, fixturesRoot));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolveRefs(item, fixturesRoot);
    }
    return out;
  }
  return value;
}
