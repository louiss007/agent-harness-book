export class Command {
  name: string;
  summary: string;
  template: string;

  constructor(name: string, summary: string, template: string) {
    this.name = name;
    this.summary = summary;
    this.template = template;
  }
}

export class Expansion {
  name: string;
  text: string;

  constructor(name: string, text: string) {
    this.name = name;
    this.text = text;
  }
}

export class CommandError extends Error {}

export class CommandRegistry {
  private commands: Map<string, Command>;

  constructor(commands: Command[]) {
    this.commands = new Map(commands.map((command) => [command.name, command]));
  }

  expand(raw: string): Expansion | null {
    if (!raw.startsWith("/")) return null;
    const body = raw.slice(1);
    const index = body.indexOf(" ");
    const head = index === -1 ? body : body.slice(0, index);
    const rest = index === -1 ? "" : body.slice(index + 1);
    const command = this.commands.get(head);
    if (command === undefined) throw new CommandError(`未知命令 /${head}`);
    const target = rest.trim();
    if (target === "") throw new CommandError(`缺少参数：/${head} <target>`);
    return new Expansion(command.name, command.template.split("{target}").join(target));
  }
}
