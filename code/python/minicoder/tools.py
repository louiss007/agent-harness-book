from __future__ import annotations

import asyncio
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional, Sequence

from .types import ToolCall, ToolResult, ToolSpec


class ToolFailure(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class SchemaError(Exception):
    pass


_TYPE_CHECKS = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
}


def validate_args(schema: dict[str, Any], args: Any, path: str = "$") -> None:
    expected = schema.get("type")
    if expected in _TYPE_CHECKS and not _TYPE_CHECKS[expected](args):
        raise SchemaError(f"{path} 应为 {expected}")
    if "enum" in schema and args not in schema["enum"]:
        raise SchemaError(f"{path} 必须是 {schema['enum']} 之一")
    if expected == "object":
        props = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in args:
                raise SchemaError(f"缺少必填参数 {path}.{key}")
        if schema.get("additionalProperties") is False:
            extra = sorted(set(args) - set(props))
            if extra:
                raise SchemaError(f"出现未定义参数 {path}.{extra[0]}")
        for key, sub in props.items():
            if key in args:
                validate_args(sub, args[key], f"{path}.{key}")
    if expected == "array" and "items" in schema:
        for index, item in enumerate(args):
            validate_args(schema["items"], item, f"{path}[{index}]")


class Workspace:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).resolve()

    def resolve(self, raw: Any) -> Path:
        if not isinstance(raw, str) or not raw.strip():
            raise ToolFailure("invalid_args", "path 必须是非空字符串")
        candidate = Path(raw).resolve() if os.path.isabs(raw) else (self.root / raw).resolve()
        try:
            candidate.relative_to(self.root)
        except ValueError:
            raise ToolFailure("path_outside_workspace", f"路径 {raw!r} 超出工作区") from None
        return candidate


Handler = Callable[[dict[str, Any]], Awaitable[ToolResult]]


@dataclass(frozen=True)
class Tool:
    spec: ToolSpec
    handler: Handler
    parallel_safe: bool = False
    risk: str = "read"
    timeout_s: float = 15.0


_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        name = tool.spec.name
        if not _NAME_RE.match(name):
            raise ValueError(f"工具名 {name!r} 不合法")
        if name in self._tools:
            raise ValueError(f"工具名 {name!r} 重复注册")
        params = tool.spec.parameters
        if params.get("type") != "object" or not isinstance(params.get("properties"), dict):
            raise ValueError(f"工具 {name} 的参数 Schema 必须是 object")
        if params.get("additionalProperties") is not False:
            raise ValueError(f"工具 {name} 必须显式设置 additionalProperties=false")
        if tool.parallel_safe and tool.risk != "read":
            raise ValueError(f"工具 {name} 的写操作不能声明 parallel_safe")
        self._tools[name] = tool

    def get(self, name: str) -> Optional[Tool]:
        return self._tools.get(name)

    def specs(self) -> list[ToolSpec]:
        return [self._tools[name].spec for name in sorted(self._tools)]


def truncate_text(text: str, *, max_chars: int, head: int = 6, tail: int = 6) -> tuple[str, bool]:
    if len(text) <= max_chars:
        return text, False
    lines = text.splitlines()
    if len(lines) > head + tail + 1:
        omitted = len(lines) - head - tail
        return "\n".join(lines[:head] + [f"...（省略 {omitted} 行）..."] + lines[-tail:]), True
    return text[:max_chars] + "\n...（省略部分内容）...", True


def numbered(lines: list[str], start: int) -> str:
    return "\n".join(f"{i:>4}\t{line}" for i, line in enumerate(lines, start=start))


def make_read_file(ws: Workspace) -> Handler:
    async def read_file(args: dict[str, Any]) -> ToolResult:
        path = ws.resolve(args["path"])
        if not path.exists():
            raise ToolFailure("not_found", f"文件不存在：{args['path']}")
        text = path.read_text(encoding="utf-8")
        offset = int(args.get("offset", 1))
        limit = int(args.get("limit", 200))
        if offset < 1 or limit < 1:
            raise ToolFailure("invalid_args", "offset 与 limit 必须大于等于 1")
        lines = text.splitlines()
        window = lines[offset - 1 : offset - 1 + limit]
        return ToolResult(
            ok=True,
            content=numbered(window, start=offset),
            truncated=offset - 1 + len(window) < len(lines),
            metadata={"total_lines": len(lines), "returned_lines": len(window)},
        )

    return read_file


def make_write_file(ws: Workspace) -> Handler:
    async def write_file(args: dict[str, Any]) -> ToolResult:
        path = ws.resolve(args["path"])
        if not path.parent.exists():
            raise ToolFailure("parent_missing", f"父目录不存在：{path.parent}")
        content = args["content"]
        path.write_text(content, encoding="utf-8")
        return ToolResult(
            ok=True,
            content=f"已写入 {len(content)} 个字符到 {path.relative_to(ws.root)}",
            metadata={"path": str(path.relative_to(ws.root)), "chars": len(content)},
        )

    return write_file


def build_registry(ws: Workspace) -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(
        Tool(
            ToolSpec(
                "read_file",
                "读取工作区内的 UTF-8 文本文件，返回带行号的内容；只读。",
                {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["path"],
                    "properties": {
                        "path": {"type": "string", "description": "相对工作区的文件路径"},
                        "offset": {"type": "integer", "description": "起始行，默认 1"},
                        "limit": {"type": "integer", "description": "最多返回行数，默认 200"},
                    },
                },
            ),
            make_read_file(ws),
            parallel_safe=True,
            risk="read",
        )
    )
    registry.register(
        Tool(
            ToolSpec(
                "write_file",
                "写入或覆盖工作区内的 UTF-8 文本文件；会改变磁盘内容。",
                {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["path", "content"],
                    "properties": {
                        "path": {"type": "string", "description": "相对工作区的文件路径"},
                        "content": {"type": "string", "description": "完整的新文件内容"},
                    },
                },
            ),
            make_write_file(ws),
            risk="write",
        )
    )
    return registry


Authorizer = Callable[[Tool, dict[str, Any]], Optional[ToolResult]]


@dataclass
class ToolExecutor:
    registry: ToolRegistry
    authorize: Optional[Authorizer] = None
    max_result_chars: int = 1600

    async def execute(self, call: ToolCall) -> ToolResult:
        tool = self.registry.get(call.name)
        if tool is None:
            known = ", ".join(spec.name for spec in self.registry.specs())
            return ToolResult(False, error=f"未知工具 {call.name!r}。可用工具：{known}", error_code="unknown_tool")

        try:
            validate_args(tool.spec.parameters, call.args)
        except SchemaError as exc:
            return ToolResult(False, error=f"参数不合法：{exc}", error_code="invalid_args")

        if self.authorize is not None:
            denied = self.authorize(tool, call.args)
            if denied is not None:
                return denied

        try:
            result = await asyncio.wait_for(tool.handler(call.args), timeout=tool.timeout_s)
        except asyncio.TimeoutError:
            return ToolResult(False, error=f"执行超过 {tool.timeout_s:g} 秒", error_code="timeout")
        except ToolFailure as exc:
            return ToolResult(False, error=str(exc), error_code=exc.code)
        except Exception as exc:
            return ToolResult(False, error=f"工具内部错误：{type(exc).__name__}", error_code="execution_failed")

        content, cut = truncate_text(result.content, max_chars=self.max_result_chars)
        metadata = dict(result.metadata)
        if cut:
            metadata["original_chars"] = len(result.content)
        return ToolResult(
            result.ok,
            content=content,
            error=result.error,
            error_code=result.error_code,
            truncated=result.truncated or cut,
            metadata=metadata,
        )
