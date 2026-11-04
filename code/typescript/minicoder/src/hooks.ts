export type Event =
  | "session_start"
  | "user_prompt_submit"
  | "before_model"
  | "after_model"
  | "before_tool"
  | "after_tool"
  | "session_end";

export type Payload = Record<string, unknown>;

export type HookResult = {
  action: "continue" | "modify" | "block";
  payload?: Payload;
  reason?: string;
};

export type Handler = (payload: Payload) => HookResult;

export class Hook {
  name: string;
  event: Event;
  handler: Handler;
  priority: number;
  critical: boolean;

  constructor(name: string, event: Event, handler: Handler, priority = 100, critical = false) {
    this.name = name;
    this.event = event;
    this.handler = handler;
    this.priority = priority;
    this.critical = critical;
  }
}

export class HookOutcome {
  action: string;
  payload: Payload;
  reason: string;
  trace: string[];

  constructor(action: string, payload: Payload, reason: string, trace: string[]) {
    this.action = action;
    this.payload = payload;
    this.reason = reason;
    this.trace = trace;
  }
}

export class HookRegistry {
  private hooks: Hook[] = [];
  runs = 0;
  blocks = 0;
  errors = 0;

  register(hook: Hook): void {
    this.hooks.push(hook);
  }

  run(event: Event, payload: Payload): HookOutcome {
    const hooks = this.hooks
      .filter((hook) => hook.event === event)
      .sort((a, b) => a.priority - b.priority || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const current: Payload = { ...payload };
    const trace: string[] = [];
    let modified = false;
    for (const hook of hooks) {
      this.runs += 1;
      let result: HookResult;
      try {
        result = hook.handler({ ...current });
      } catch {
        this.errors += 1;
        trace.push(`${hook.name}=error`);
        if (hook.critical) {
          this.blocks += 1;
          return new HookOutcome("block", current, `${hook.name}:failed`, trace);
        }
        continue;
      }
      trace.push(`${hook.name}=${result.action}`);
      if (result.action === "modify" || result.payload !== undefined) modified = true;
      if (result.payload !== undefined) Object.assign(current, result.payload);
      if (result.action === "block") {
        this.blocks += 1;
        return new HookOutcome("block", current, `${hook.name}:${result.reason ?? ""}`, trace);
      }
    }
    return new HookOutcome(modified ? "modify" : "continue", current, "", trace);
  }
}
