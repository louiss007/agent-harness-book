import { ModelResponse, Usage } from "./types.ts";
import type { Message, ToolCall, ToolSpec } from "./types.ts";

export interface Provider {
  complete(messages: Message[], tools?: ToolSpec[], options?: Record<string, unknown>): Promise<ModelResponse>;
}

export class ScriptedProvider implements Provider {
  private responses: ModelResponse[];
  calls = 0;

  constructor(responses: ModelResponse[]) {
    this.responses = responses.slice();
  }

  async complete(_messages: Message[], _tools: ToolSpec[] = [], _options: Record<string, unknown> = {}): Promise<ModelResponse> {
    this.calls += 1;
    if (this.responses.length === 0) throw new Error("脚本响应已用尽");
    return this.responses.shift()!;
  }
}

export class FixedSummaryProvider implements Provider {
  summary: string;
  calls = 0;

  constructor(summary: string) {
    this.summary = summary;
  }

  async complete(_messages: Message[], _tools: ToolSpec[] = [], _options: Record<string, unknown> = {}): Promise<ModelResponse> {
    this.calls += 1;
    return new ModelResponse(this.summary, [], "end_turn", new Usage(120, 40));
  }
}

export function response(
  text = "",
  calls: ToolCall[] = [],
  options: { input_tokens?: number; output_tokens?: number } = {},
): ModelResponse {
  return new ModelResponse(
    text,
    calls.slice(),
    calls.length > 0 ? "tool_use" : "end_turn",
    new Usage(options.input_tokens ?? 100, options.output_tokens ?? 20),
  );
}
