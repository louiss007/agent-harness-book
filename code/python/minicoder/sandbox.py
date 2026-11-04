from __future__ import annotations

import os
import shutil
import signal
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional, Sequence


DEFAULT_ENV_ALLOWLIST = ("PATH", "LANG", "LC_ALL", "TERM")


class SandboxError(RuntimeError):
    pass


@dataclass(frozen=True)
class SandboxSpec:
    read_only_base: Optional[Path] = None
    env_allowlist: tuple[str, ...] = DEFAULT_ENV_ALLOWLIST
    timeout_s: float = 30.0
    max_output_chars: int = 4000
    network: str = "deny"
    backend: str = "local"
    keep_workspace: bool = False


@dataclass
class SandboxHandle:
    sandbox_id: str
    spec: SandboxSpec
    root: Path
    workspace: Path
    state: str = "ready"
    runs: int = 0
    created_at: float = field(default_factory=time.time)

    def resolve_cwd(self, raw: Optional[str]) -> Path:
        candidate = (self.workspace / (raw or ".")).resolve()
        try:
            candidate.relative_to(self.workspace)
        except ValueError:
            raise SandboxError(f"工作目录 {raw!r} 超出沙箱工作区") from None
        if not candidate.is_dir():
            raise SandboxError(f"工作目录不存在：{raw!r}")
        return candidate

    def build_env(self, extra: Optional[dict[str, str]] = None) -> dict[str, str]:
        env = {"HOME": str(self.root / "home"), "TMPDIR": str(self.root / "tmp")}
        for name in self.spec.env_allowlist:
            value = os.environ.get(name)
            if value is not None:
                env[name] = value
        if extra:
            for key, value in extra.items():
                if key not in self.spec.env_allowlist:
                    raise SandboxError(f"环境变量 {key} 不在白名单内")
                env[key] = value
        return env


@dataclass
class CommandResult:
    sandbox_id: str
    argv: tuple[str, ...]
    exit_code: Optional[int]
    signal: str = ""
    stdout: str = ""
    stderr: str = ""
    duration_s: float = 0.0
    timed_out: bool = False
    stdout_total: int = 0
    stderr_total: int = 0
    truncated: bool = False

    def to_observation(self, max_chars: int = 1200) -> str:
        status = "timeout" if self.timed_out else f"exit={self.exit_code}"
        parts = [f"[sandbox {self.sandbox_id}] {status} in {self.duration_s:.2f}s"]
        if self.stdout.strip():
            parts.append("stdout:\n" + self.stdout.strip())
        if self.stderr.strip():
            parts.append("stderr:\n" + self.stderr.strip())
        if self.truncated:
            parts.append("[输出已截断]")
        text = "\n".join(parts)
        return text if len(text) <= max_chars else text[:max_chars] + "\n…[observation truncated]"


def _capture(text: str, limit: int) -> tuple[str, int]:
    if len(text) <= limit:
        return text, len(text)
    head = int(limit * 0.7)
    tail = limit - head
    return text[:head] + f"\n...（省略 {len(text) - limit} 字符）...\n" + text[-tail:], len(text)


_counter = 0


def create_sandbox(spec: SandboxSpec) -> SandboxHandle:
    global _counter
    if spec.backend != "local":
        raise SandboxError(f"教学实现只提供 local 后端；{spec.backend} 需要真实隔离运行时")
    _counter += 1
    root = Path(tempfile.mkdtemp(prefix="minicoder-sbx-"))
    workspace = root / "workspace"
    workspace.mkdir()
    (root / "home").mkdir()
    (root / "tmp").mkdir()
    if spec.read_only_base is not None:
        shutil.copytree(Path(spec.read_only_base).resolve(), workspace, dirs_exist_ok=True)
    return SandboxHandle(f"sbx-{_counter:04d}", spec, root, workspace.resolve())


def run_command(
    handle: SandboxHandle,
    argv: Sequence[str],
    *,
    cwd: Optional[str] = None,
    timeout_s: Optional[float] = None,
    env: Optional[dict[str, str]] = None,
) -> CommandResult:
    if handle.state != "ready":
        raise SandboxError(f"沙箱 {handle.sandbox_id} 已关闭")
    args = list(argv)
    if not args or not all(isinstance(item, str) for item in args):
        raise SandboxError("argv 必须是非空字符串数组")
    cwd_path = handle.resolve_cwd(cwd)
    timeout = timeout_s if timeout_s is not None else handle.spec.timeout_s
    started = time.monotonic()
    proc = subprocess.Popen(
        args,
        cwd=str(cwd_path),
        env=handle.build_env(env),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        start_new_session=True,
    )
    timed_out = False
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        stdout, stderr = proc.communicate()
    duration = time.monotonic() - started
    code = proc.returncode
    signame = ""
    if code is not None and code < 0:
        try:
            signame = signal.Signals(-code).name
        except ValueError:
            signame = f"signal {-code}"
    out, out_total = _capture(stdout, handle.spec.max_output_chars)
    err, err_total = _capture(stderr, handle.spec.max_output_chars)
    handle.runs += 1
    return CommandResult(
        sandbox_id=handle.sandbox_id,
        argv=tuple(args),
        exit_code=code,
        signal=signame,
        stdout=out,
        stderr=err,
        duration_s=duration,
        timed_out=timed_out,
        stdout_total=out_total,
        stderr_total=err_total,
        truncated=out_total > handle.spec.max_output_chars or err_total > handle.spec.max_output_chars,
    )


def destroy_sandbox(handle: SandboxHandle) -> dict[str, Any]:
    if handle.state == "closed":
        return {"sandbox_id": handle.sandbox_id, "runs": handle.runs, "state": "closed"}
    handle.state = "closed"
    if not handle.spec.keep_workspace:
        shutil.rmtree(handle.root, ignore_errors=True)
    return {
        "sandbox_id": handle.sandbox_id,
        "runs": handle.runs,
        "kept_workspace": handle.spec.keep_workspace,
        "state": "closed",
    }


def manifest(root: Path) -> dict[str, str]:
    import hashlib

    result: dict[str, str] = {}
    for path in sorted(Path(root).rglob("*")):
        if path.is_file() and not path.is_symlink():
            result[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result
