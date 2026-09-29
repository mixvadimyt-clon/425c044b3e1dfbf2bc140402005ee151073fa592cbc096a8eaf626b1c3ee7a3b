"""Логические гипотезы: правила согласованности между стадиями (REQ-CMP-04 → гипотезы).

Объём свободного поиска ограничен: ищем только несоответствия между ПД, РД и ИД.
Соответствие проекта нормам (СП, СНиП) не проверяем, ``NORMATIVE_ANALYSIS`` не выдаём —
``normative_base`` из правила переносится в гипотезу только как ссылка для инспектора.

Правило считается **по каждой контрольной точке**, а не по объекту целиком: «пом. 1.09» в ПД и
«Помещение 1-09» в РД — одна точка (``compare.matching``), и гипотеза родится именно по ней.
Параметр без экземпляров (общая площадь здания) даёт одну точку с пустым ключом.

Гипотеза появляется, только когда условие достоверно истинно, а ожидание достоверно ложно.
Всё неопределённое — нет значения, несравнимые типы, два разных значения одного параметра в одной
стадии — даёт «неизвестно», и правило молчит: расхождение редакций внутри стадии разбирает движок
сравнения (``CLARIFICATION_REQUIRED``), выдумывать по нему гипотезу нельзя.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field

from inspector_ml.compare import matching, pagepairs
from inspector_ml.compare.keys import rule_group, suspicion_key
from inspector_ml.compare.ports import Extraction
from inspector_ml.compare.values import STAGE_LABEL, plain, stage_order
from inspector_ml.contracts.events import DocStage, LogicalRule, PagePairResult, SuspicionResult
from inspector_ml.suspicion.rules import dsl

DISCOVERY_METHOD = "LOGICAL_ANALYSIS"
DEFAULT_PRIORITY = "MEDIUM"

StageOf = Callable[[Extraction], str]
ReferenceOf = Callable[[Extraction], str]


@dataclass(frozen=True)
class CompiledRule:
    """Правило с разобранными выражениями."""

    rule: LogicalRule
    condition: dsl.Node
    expected: dsl.Node
    params: frozenset[str] = field(default_factory=frozenset)

    @property
    def name(self) -> str:
        return self.rule.rule_name


def compile_rules(rules: Iterable[LogicalRule] | None) -> tuple[list[CompiledRule], list[tuple[str, str]]]:
    """Разбор активных правил. Возвращает годные и список ``(имя, причина)`` для непонятных.

    Неверное правило пропускаем, а не роняем сравнение: текст пишет администратор через API,
    и опечатка в одном правиле не должна лишать инспектора всего протокола.
    """
    compiled: list[CompiledRule] = []
    broken: list[tuple[str, str]] = []
    for rule in rules or []:
        if rule.is_active is False:
            continue
        try:
            condition, expected = dsl.parse(rule.condition), dsl.parse(rule.expected)
        except dsl.RuleSyntaxError as error:
            broken.append((rule.rule_name, str(error)))
            continue
        params = {ref.param for ref in dsl.refs(condition) | dsl.refs(expected)}
        compiled.append(CompiledRule(rule, condition, expected, frozenset(params)))
    return compiled, broken


def referenced_params(rules: Iterable[CompiledRule]) -> set[str]:
    """Коды параметров, нужные правилам: их значения должны быть в любом прогоне, даже инкрементальном."""
    found: set[str] = set()
    for rule in rules:
        found |= rule.params
    return found


def run(
    rules: Sequence[CompiledRule],
    values: Mapping[str, Sequence[Extraction]],
    stage_of: StageOf,
    reference_of: ReferenceOf,
    object_id: object,
    page_pairs: Sequence[PagePairResult] = (),
) -> list[SuspicionResult]:
    """Гипотезы по логическим правилам для одного комплекта."""
    found: list[SuspicionResult] = []
    for rule in rules:
        points = _points(rule.params, values, stage_of)
        for key, place in sorted(points.items(), key=lambda kv: kv[0] or ""):
            resolve = _resolver(place)
            if dsl.truth(rule.condition, resolve) is True and dsl.truth(rule.expected, resolve) is False:
                found.append(_suspicion(rule, key, place, stage_of, reference_of, object_id, page_pairs))
    return found


def _points(
    params: Iterable[str], values: Mapping[str, Sequence[Extraction]], stage_of: StageOf
) -> dict[str | None, dict[tuple[str, str], list[Extraction]]]:
    """Контрольные точки правила: ключ точки → значения её параметров по стадиям."""
    points: dict[str | None, dict[tuple[str, str], list[Extraction]]] = {}
    for code in sorted(params):
        for group in matching.group(values.get(code, []), stage_of):
            key = _point_key(group, stage_of)
            place = points.setdefault(key, {})
            for item in group:
                place.setdefault((code, stage_of(item)), []).append(item)
    return points


def _point_key(group: Sequence[Extraction], stage_of: StageOf) -> str | None:
    """Подпись точки — как в самой ранней стадии; так же её называет движок сравнения."""
    ordered = sorted(group, key=lambda x: stage_order(stage_of(x)))
    return rule_group(ordered[0].rule_key) if ordered else None


def _resolver(place: Mapping[tuple[str, str], list[Extraction]]) -> dsl.Resolve:
    def resolve(ref: dsl.Ref) -> dsl.Value:
        items = place.get((ref.param, ref.stage))
        if not items:
            return dsl.MISSING
        first = items[0].value
        # два разных значения одного параметра в одной стадии — это работа движка сравнения
        if any(dsl.compare("==", first, other.value) is not True for other in items[1:]):
            return dsl.MISSING
        return dsl.MISSING if first is None else first

    return resolve


def _suspicion(
    rule: CompiledRule,
    key: str | None,
    place: Mapping[tuple[str, str], list[Extraction]],
    stage_of: StageOf,
    reference_of: ReferenceOf,
    object_id: object,
    page_pairs: Sequence[PagePairResult],
) -> SuspicionResult:
    used = [items[0] for items in place.values() if items]
    used.sort(key=lambda x: (stage_order(stage_of(x)), x.param_code))
    fragments = [x.fragment.model_copy(update={"role": "CONTEXT", "stage": DocStage(stage_of(x))}) for x in used]
    confidences = [f.confidence for f in fragments if f.confidence is not None]
    by_stage = {stage_of(x): x for x in reversed(used)}
    return SuspicionResult.model_validate(
        {
            "suspicion_key": suspicion_key(object_id, rule.rule.id, key),
            "discovery_method": DISCOVERY_METHOD,
            "confidence": min(confidences) if confidences else 1.0,
            "description": _describe(rule, key, used, stage_of),
            "pd_reference": _reference(by_stage.get("PD"), reference_of),
            "rd_reference": _reference(by_stage.get("RD"), reference_of),
            "id_reference": _reference(by_stage.get("ID"), reference_of),
            # приоритет у правила необязателен по контракту, а у гипотезы обязателен
            "review_priority": plain(rule.rule.review_priority) or DEFAULT_PRIORITY,
            "normative_base": rule.rule.normative_base,
            "rule_id": str(rule.rule.id),
            "page_pair_key": pagepairs.key_for(fragments, page_pairs),
            "evidence": fragments,
        }
    )


def _reference(item: Extraction | None, reference_of: ReferenceOf) -> str | None:
    return reference_of(item) if item is not None else None


def _describe(rule: CompiledRule, key: str | None, used: Sequence[Extraction], stage_of: StageOf) -> str:
    where = f"Точка «{key}». " if key else ""
    seen = [f"{STAGE_LABEL[stage_of(x)]} {x.param_code}: {x.raw_value}" for x in used]
    values = f" Значения: {'; '.join(seen)}." if seen else ""
    return (
        f"{where}Правило «{rule.name}»: условие «{rule.condition}» выполнено,"
        f" а ожидание «{rule.expected}» не выполнено.{values}"
    )
