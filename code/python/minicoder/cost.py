"""成本与延迟核算：用量归一、价格卡、预算账本、模型路由与缓存前缀。

本模块只增加能力，不修改 Provider、Usage、HarnessConfig 等既有接口。
价格单位统一为“微美元（micro-USD）”，即 1e-6 美元，避免浮点累计漂移。
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Iterable, Optional, Sequence

from .context import estimate_tokens
from .types import Usage

MTOK = 1_000_000


@dataclass(frozen=True)
class CostUsage:
    """归一化用量：未缓存输入、缓存读、缓存写与输出分开计费。"""

    input_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    output_tokens: int = 0

    @classmethod
    def from_usage(
        cls, usage: Usage, *, cache_read: int = 0, cache_write: int = 0
    ) -> "CostUsage":
        return cls(usage.input_tokens, cache_read, cache_write, usage.output_tokens)

    @property
    def prompt_tokens(self) -> int:
        return self.input_tokens + self.cache_read_tokens + self.cache_write_tokens

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.output_tokens

    def __add__(self, other: "CostUsage") -> "CostUsage":
        return CostUsage(
            self.input_tokens + other.input_tokens,
            self.cache_read_tokens + other.cache_read_tokens,
            self.cache_write_tokens + other.cache_write_tokens,
            self.output_tokens + other.output_tokens,
        )


@dataclass(frozen=True)
class PriceCard:
    """单个模型的价格与容量；价格为每百万 token 的微美元数。"""

    model: str
    input_micro_per_mtok: int
    output_micro_per_mtok: int
    cache_read_micro_per_mtok: int
    cache_write_micro_per_mtok: int
    latency_p50_ms: int = 0
    context_window: int = 200_000

    def _micros(self, numerator: int) -> int:
        # 四舍五入到整数微美元；两语言使用相同的半向上取整。
        return (numerator + MTOK // 2) // MTOK

    def cost_micros(self, usage: CostUsage) -> int:
        numerator = (
            usage.input_tokens * self.input_micro_per_mtok
            + usage.cache_read_tokens * self.cache_read_micro_per_mtok
            + usage.cache_write_tokens * self.cache_write_micro_per_mtok
            + usage.output_tokens * self.output_micro_per_mtok
        )
        return self._micros(numerator)

    def uncached_cost_micros(self, usage: CostUsage) -> int:
        numerator = (
            usage.prompt_tokens * self.input_micro_per_mtok
            + usage.output_tokens * self.output_micro_per_mtok
        )
        return self._micros(numerator)

    def savings_micros(self, usage: CostUsage) -> int:
        """相对“全部输入按未缓存价”的差额；缓存写入回合可能为负。"""
        return self.uncached_cost_micros(usage) - self.cost_micros(usage)


class ModelCatalog:
    def __init__(self, cards: Sequence[PriceCard]) -> None:
        self._cards: dict[str, PriceCard] = {}
        for card in cards:
            if card.model in self._cards:
                raise ValueError(f"重复的模型价格：{card.model}")
            self._cards[card.model] = card

    def get(self, model: str) -> PriceCard:
        try:
            return self._cards[model]
        except KeyError as exc:
            raise ValueError(f"未知模型：{model}") from exc

    def __iter__(self):
        return iter(self._cards.values())


@dataclass(frozen=True)
class TaskBudget:
    max_cost_micros: int
    max_prompt_tokens: int
    max_output_tokens: int


class BudgetExceeded(RuntimeError):
    def __init__(self, scope: str, requested: int, remaining: int) -> None:
        self.scope = scope
        self.requested = requested
        self.remaining = remaining
        super().__init__(f"{scope}: requested={requested} remaining={remaining}")


@dataclass(frozen=True)
class Reservation:
    reservation_id: int
    model: str
    prompt_tokens: int
    output_tokens: int
    cost_micros: int


@dataclass(frozen=True)
class LedgerSnapshot:
    cost_used_micros: int
    prompt_used: int
    output_used: int
    cost_remaining_micros: int
    prompt_remaining: int
    output_remaining: int
    rejected: int
    overruns: int


class BudgetLedger:
    """预扣、结算与归还；预扣防止并行子任务同时透支同一预算。"""

    def __init__(self, budget: TaskBudget, catalog: ModelCatalog) -> None:
        self.budget = budget
        self.catalog = catalog
        self.used = CostUsage()
        self.cost_used_micros = 0
        self.rejected = 0
        self.overruns = 0
        self._reserved_cost = 0
        self._reserved_prompt = 0
        self._reserved_output = 0
        self._next_id = 1
        self._open: dict[int, Reservation] = {}

    def reserve(self, model: str, *, prompt_tokens: int, output_tokens: int) -> Reservation:
        if prompt_tokens < 0 or output_tokens < 0:
            raise ValueError("预扣 token 不能为负")
        card = self.catalog.get(model)
        cost = card.cost_micros(
            CostUsage(input_tokens=prompt_tokens, output_tokens=output_tokens)
        )

        checks = [
            ("cost", cost, self.budget.max_cost_micros - self.cost_used_micros - self._reserved_cost),
            (
                "prompt",
                prompt_tokens,
                self.budget.max_prompt_tokens - self.used.prompt_tokens - self._reserved_prompt,
            ),
            (
                "output",
                output_tokens,
                self.budget.max_output_tokens - self.used.output_tokens - self._reserved_output,
            ),
        ]
        for scope, requested, remaining in checks:
            if requested > remaining:
                self.rejected += 1
                raise BudgetExceeded(scope, requested, max(0, remaining))

        reservation = Reservation(self._next_id, model, prompt_tokens, output_tokens, cost)
        self._next_id += 1
        self._open[reservation.reservation_id] = reservation
        self._reserved_cost += cost
        self._reserved_prompt += prompt_tokens
        self._reserved_output += output_tokens
        return reservation

    def settle(self, reservation: Reservation, usage: CostUsage) -> int:
        """按实际用量结算，返回正数表示退还，负数表示超支。"""
        stored = self._open.pop(reservation.reservation_id, None)
        if stored is None:
            raise ValueError(f"预扣不存在或已结算：{reservation.reservation_id}")
        self._reserved_cost -= stored.cost_micros
        self._reserved_prompt -= stored.prompt_tokens
        self._reserved_output -= stored.output_tokens

        actual = self.catalog.get(reservation.model).cost_micros(usage)
        self.used = self.used + usage
        self.cost_used_micros += actual
        if actual > stored.cost_micros:
            self.overruns += 1
        return stored.cost_micros - actual

    def release(self, reservation: Reservation) -> int:
        stored = self._open.pop(reservation.reservation_id, None)
        if stored is None:
            raise ValueError(f"预扣不存在或已结算：{reservation.reservation_id}")
        self._reserved_cost -= stored.cost_micros
        self._reserved_prompt -= stored.prompt_tokens
        self._reserved_output -= stored.output_tokens
        return stored.cost_micros

    def snapshot(self) -> LedgerSnapshot:
        return LedgerSnapshot(
            cost_used_micros=self.cost_used_micros,
            prompt_used=self.used.prompt_tokens,
            output_used=self.used.output_tokens,
            cost_remaining_micros=max(
                0, self.budget.max_cost_micros - self.cost_used_micros - self._reserved_cost
            ),
            prompt_remaining=max(
                0, self.budget.max_prompt_tokens - self.used.prompt_tokens - self._reserved_prompt
            ),
            output_remaining=max(
                0, self.budget.max_output_tokens - self.used.output_tokens - self._reserved_output
            ),
            rejected=self.rejected,
            overruns=self.overruns,
        )


@dataclass(frozen=True)
class ModelTier:
    name: str
    model: str
    max_context: int
    supports_tools: bool = True
    supports_cache: bool = True


@dataclass(frozen=True)
class RouteRequest:
    phase: str
    risk: str
    prompt_tokens: int
    turn: int = 1
    failures: int = 0


@dataclass(frozen=True)
class RouteDecision:
    model: str
    tier: str
    reason: str
    switched: bool = False
    escalated: bool = False


class Router:
    """确定性模型路由：便宜到贵排序，粘性优先，失败与风险向上升级。"""

    def __init__(
        self,
        tiers: Sequence[ModelTier],
        *,
        policy: str = "sticky",
        escalate_after: int = 1,
        hard_after: int = 3,
    ) -> None:
        if not tiers:
            raise ValueError("至少需要一个模型层级")
        if policy not in ("sticky", "per_turn"):
            raise ValueError(f"未知路由策略：{policy}")
        names = [tier.name for tier in tiers]
        if len(set(names)) != len(names):
            raise ValueError("模型层级名称重复")
        self.tiers = list(tiers)
        self.policy = policy
        self.escalate_after = escalate_after
        self.hard_after = hard_after
        self.switches = 0
        self.decisions: list[RouteDecision] = []

    def _index_of(self, model: str) -> int:
        for index, tier in enumerate(self.tiers):
            if tier.model == model:
                return index
        return -1

    def _smallest_fit(self, prompt_tokens: int) -> int:
        for index, tier in enumerate(self.tiers):
            if tier.supports_tools and tier.max_context >= prompt_tokens:
                return index
        raise ValueError(f"没有模型能容纳 {prompt_tokens} prompt tokens")

    def select(self, request: RouteRequest, *, current_model: str = "") -> RouteDecision:
        fit = self._smallest_fit(request.prompt_tokens)
        current = self._index_of(current_model)
        escalated = False

        if request.risk in ("destructive", "external"):
            desired = len(self.tiers) - 1
            reason = f"risk:{request.risk}"
        elif request.failures >= self.hard_after:
            desired = len(self.tiers) - 1
            reason = f"escalation:failures={request.failures}"
            escalated = True
        elif request.failures >= self.escalate_after:
            desired = min(1, len(self.tiers) - 1)
            reason = f"escalation:failures={request.failures}"
            escalated = True
        elif request.phase == "summarize":
            desired = fit
            reason = "phase:summarize:cheapest-fit"
        elif self.policy == "sticky" and current >= 0 and current >= fit:
            tier = self.tiers[current]
            decision = RouteDecision(tier.model, tier.name, "sticky:current")
            self.decisions.append(decision)
            return decision
        else:
            desired = fit
            reason = "context:overflow" if fit > 0 else "base:cheapest-fit"

        desired = max(desired, fit)
        if (request.failures > 0 or request.risk in ("destructive", "external")) and current >= 0:
            desired = max(desired, current)

        tier = self.tiers[desired]
        decision = RouteDecision(
            tier.model,
            tier.name,
            reason,
            switched=bool(current_model) and tier.model != current_model,
            escalated=escalated,
        )
        if decision.switched:
            self.switches += 1
        self.decisions.append(decision)
        return decision


_STABILITY = {"static": 0, "session": 1, "turn": 2}


@dataclass(frozen=True)
class PrefixSection:
    name: str
    text: str
    stability: str = "static"


@dataclass(frozen=True)
class CachePlan:
    order: tuple[str, ...]
    cacheable_chars: int
    cacheable_tokens: int
    naive_tokens: int
    fingerprint: str
    reordered: bool
    volatile: tuple[str, ...]


def _fingerprint(sections: Sequence[PrefixSection]) -> str:
    digest = hashlib.sha256()
    for section in sections:
        digest.update(section.name.encode("utf-8"))
        digest.update(b"\x00")
        digest.update(section.text.encode("utf-8"))
        digest.update(b"\x01")
    return digest.hexdigest()[:16]


def plan_cache(sections: Sequence[PrefixSection]) -> CachePlan:
    """把 static/session 段排到最前，计算可缓存前缀与指纹。

    naive_tokens 表示“不改顺序、遇到第一个 turn 段就断”的可缓存长度，
    用来暴露动态内容插在稳定前缀中间的代价。
    """
    for section in sections:
        if section.stability not in _STABILITY:
            raise ValueError(f"未知稳定性：{section.stability}")

    ordered = [
        section
        for _, section in sorted(
            enumerate(sections), key=lambda pair: (_STABILITY[pair[1].stability], pair[0])
        )
    ]
    cacheable: list[PrefixSection] = []
    for section in ordered:
        if section.stability == "turn":
            break
        cacheable.append(section)

    naive: list[PrefixSection] = []
    for section in sections:
        if section.stability == "turn":
            break
        naive.append(section)

    cacheable_text = "\n".join(section.text for section in cacheable)
    naive_text = "\n".join(section.text for section in naive)
    order = tuple(section.name for section in ordered)
    return CachePlan(
        order=order,
        cacheable_chars=len(cacheable_text),
        cacheable_tokens=estimate_tokens(cacheable_text),
        naive_tokens=estimate_tokens(naive_text),
        fingerprint=_fingerprint(cacheable),
        reordered=order != tuple(section.name for section in sections),
        volatile=tuple(section.name for section in sections if section.stability == "turn"),
    )


@dataclass
class CacheStats:
    uncached_tokens: int = 0
    read_tokens: int = 0
    write_tokens: int = 0
    turns: int = 0

    def observe(self, usage: CostUsage) -> None:
        self.uncached_tokens += usage.input_tokens
        self.read_tokens += usage.cache_read_tokens
        self.write_tokens += usage.cache_write_tokens
        self.turns += 1

    @property
    def prompt_tokens(self) -> int:
        return self.uncached_tokens + self.read_tokens + self.write_tokens

    @property
    def hit_rate(self) -> float:
        return self.read_tokens / self.prompt_tokens if self.prompt_tokens else 0.0

    def input_savings_micros(self, card: PriceCard) -> int:
        baseline = self.prompt_tokens * card.input_micro_per_mtok
        actual = (
            self.uncached_tokens * card.input_micro_per_mtok
            + self.read_tokens * card.cache_read_micro_per_mtok
            + self.write_tokens * card.cache_write_micro_per_mtok
        )
        return (baseline - actual + MTOK // 2) // MTOK


@dataclass(frozen=True)
class LatencyBreakdown:
    cold_start_ms: int
    prefill_ms: int
    decode_ms: int
    approval_ms: int
    tool_parallel_ms: int
    tool_serial_ms: int

    @property
    def ttft_ms(self) -> int:
        return self.cold_start_ms + self.prefill_ms

    @property
    def total_parallel_ms(self) -> int:
        return self.ttft_ms + self.decode_ms + self.approval_ms + self.tool_parallel_ms

    @property
    def total_serial_ms(self) -> int:
        return self.ttft_ms + self.decode_ms + self.approval_ms + self.tool_serial_ms

    @property
    def saved_ms(self) -> int:
        return self.total_serial_ms - self.total_parallel_ms


def latency_breakdown(
    *,
    cold_start_ms: int = 0,
    prefill_ms: int = 0,
    decode_ms: int = 0,
    approval_ms: int = 0,
    tool_groups: Sequence[Sequence[int]] = (),
) -> LatencyBreakdown:
    """p50 规划模型：每组工具并行，组间串行；不是 p95 的统计保证。"""
    parallel = sum(max(group) for group in tool_groups if group)
    serial = sum(sum(group) for group in tool_groups)
    return LatencyBreakdown(
        cold_start_ms=cold_start_ms,
        prefill_ms=prefill_ms,
        decode_ms=decode_ms,
        approval_ms=approval_ms,
        tool_parallel_ms=parallel,
        tool_serial_ms=serial,
    )


@dataclass
class CostRow:
    model: str
    turns: int
    usage: CostUsage
    cost_micros: int
    savings_micros: int


class CostReport:
    def __init__(self, catalog: ModelCatalog) -> None:
        self.catalog = catalog
        self._rows: dict[str, CostRow] = {}

    def record(self, model: str, usage: CostUsage, *, turns: int = 1) -> None:
        card = self.catalog.get(model)
        current = self._rows.get(model)
        if current is None:
            self._rows[model] = CostRow(
                model, turns, usage, card.cost_micros(usage), card.savings_micros(usage)
            )
            return
        merged = current.usage + usage
        current.turns += turns
        current.usage = merged
        current.cost_micros = card.cost_micros(merged)
        current.savings_micros = card.savings_micros(merged)

    @property
    def rows(self) -> list[CostRow]:
        return list(self._rows.values())

    @property
    def total_cost_micros(self) -> int:
        return sum(row.cost_micros for row in self._rows.values())

    def per_success_micros(self, successes: int) -> Optional[int]:
        if successes <= 0:
            return None
        return self.total_cost_micros // successes

    def format(self) -> list[str]:
        lines = []
        for row in self.rows:
            lines.append(
                f"report    {row.model:<14} turns={row.turns} "
                f"prompt={row.usage.prompt_tokens:<6} output={row.usage.output_tokens:<5} "
                f"cost=${row.cost_micros / MTOK:.6f} "
                f"savings=${row.savings_micros / MTOK:.6f}"
            )
        return lines
