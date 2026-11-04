export type FinishReason = "end_turn" | "tool_use" | "max_tokens" | "content_filter" | "error";

export type LoopStopReason = "completed" | "max_steps" | "no_progress" | "budget_exceeded" | "cancelled";

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type ToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export class Message {
  role: string;
  content: string;
  tool_call_id: string | null;
  tool_calls: ToolCall[];

  constructor(role: string, content = "", tool_call_id: string | null = null, tool_calls: ToolCall[] = []) {
    this.role = role;
    this.content = content;
    this.tool_call_id = tool_call_id;
    this.tool_calls = tool_calls;
  }
}

export class Usage {
  input_tokens: number;
  output_tokens: number;

  constructor(input_tokens = 0, output_tokens = 0) {
    this.input_tokens = input_tokens;
    this.output_tokens = output_tokens;
  }

  get total_tokens(): number {
    return this.input_tokens + this.output_tokens;
  }
}

export class ModelResponse {
  text: string;
  tool_calls: ToolCall[];
  finish_reason: FinishReason;
  usage: Usage;

  constructor(
    text = "",
    tool_calls: ToolCall[] = [],
    finish_reason: FinishReason = "end_turn",
    usage: Usage = new Usage(),
  ) {
    this.text = text;
    this.tool_calls = tool_calls;
    this.finish_reason = finish_reason;
    this.usage = usage;
  }
}

export class ToolResult {
  ok: boolean;
  content: string;
  error: string | null;
  error_code: string;
  truncated: boolean;
  metadata: Record<string, unknown>;

  constructor(
    ok: boolean,
    content = "",
    error: string | null = null,
    error_code = "",
    truncated = false,
    metadata: Record<string, unknown> = {},
  ) {
    this.ok = ok;
    this.content = content;
    this.error = error;
    this.error_code = error_code;
    this.truncated = truncated;
    this.metadata = metadata;
  }

  to_observation(): string {
    let body = this.ok ? this.content : `[${this.error_code}] ${this.error}`;
    if (this.truncated) {
      body += "\n[结果已截断；请缩小查询范围或分段读取]";
    }
    return body;
  }
}
