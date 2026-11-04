import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${parts.join(",")}}`;
  }
  return "null";
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function codePointLength(value: string): number {
  return [...value].length;
}

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

export function padLeft(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}
