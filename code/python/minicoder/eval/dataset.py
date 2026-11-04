from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .types import EvalTask


def load_tasks(path: str | Path) -> list[EvalTask]:
    tasks: list[EvalTask] = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        data = json.loads(line)
        tasks.append(
            EvalTask(
                id=str(data["id"]),
                goal=str(data["goal"]),
                constraints=tuple(str(item) for item in data.get("constraints", ())),
                fixture=str(data["fixture"]),
                allow_write=tuple(str(item) for item in data.get("allow_write", ())),
                budget=dict(data.get("budget") or {}),
                script=tuple(data.get("script") or ()),
                checks=dict(data.get("checks") or {}),
            )
        )
    return tasks


def resolve_refs(value: Any, fixtures_root: str | Path) -> Any:
    if isinstance(value, str) and value.startswith("@file:"):
        return (Path(fixtures_root) / value[len("@file:") :]).read_text(encoding="utf-8")
    if isinstance(value, dict):
        return {key: resolve_refs(item, fixtures_root) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [resolve_refs(item, fixtures_root) for item in value]
    return value
