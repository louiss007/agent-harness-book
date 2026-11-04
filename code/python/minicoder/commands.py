from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Command:
    name: str
    summary: str
    template: str


@dataclass(frozen=True)
class Expansion:
    name: str
    text: str


class CommandError(ValueError):
    pass


class CommandRegistry:
    def __init__(self, commands: list[Command]) -> None:
        self._commands = {command.name: command for command in commands}

    def expand(self, raw: str) -> Expansion | None:
        if not raw.startswith("/"):
            return None
        head, _, rest = raw[1:].partition(" ")
        command = self._commands.get(head)
        if command is None:
            raise CommandError(f"未知命令 /{head}")
        target = rest.strip()
        if not target:
            raise CommandError(f"缺少参数：/{head} <target>")
        return Expansion(command.name, command.template.format(target=target))
