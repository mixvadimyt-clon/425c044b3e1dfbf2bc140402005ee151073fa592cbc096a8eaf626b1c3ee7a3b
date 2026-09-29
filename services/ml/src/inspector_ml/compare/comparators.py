"""Сравнение эталонного и фактического значений одного правила по триггеру матрицы (``triggers.py``).

Эталон — ПД. Срабатывание — только то, что описывает триггер: направление («понижение класса»),
порог («дельта > 1%») или предел («< 0.9 м»). Отличие, которое триггер не описывает, — не кандидат,
а NEGATIVE_VERIFIED с объяснением («различие не триггерное», как KR-058 в эталоне организаторов).
Совпадение с точностью округления (1234,5 и 1234,46) — совпадение.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

from inspector_ml.compare import triggers
from inspector_ml.compare.ports import Extraction
from inspector_ml.compare.triggers import Direction, Trigger
from inspector_ml.compare.values import plain
from inspector_ml.contracts.events import MatrixParam

EPS = 1e-9


@dataclass(frozen=True)
class Outcome:
    triggered: bool
    delta: str | None
    rationale: str


@dataclass(frozen=True)
class Incomparable:
    """Значения нельзя сравнить — правило получит NOT_COMPARABLE с этой причиной."""

    reason: str


Result = Outcome | Incomparable


def to_number(value: object) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int | float):
        return float(value)
    text = re.sub(r"\s+", "", str(value)).replace(",", ".").replace("−", "-")
    try:
        return float(text)
    except ValueError:
        return None


def decimals(raw: object) -> int:
    """Знаков после запятой в первом числе записи: «3 009,40 м2» → 2, «18» → 0."""
    match = re.search(r"\d(?:[\d\s]*\d)?(?:[.,](\d+))?", str(raw))
    return len(match.group(1)) if match and match.group(1) else 0


def _text(value: object) -> str:
    """Текст для сравнения: без регистра, «ё», лишних пробелов и вида кавычек.

    «Кабель "нг(А)-FRLS"» в ПД и «кабель «нг(А)-FRLS»» в РД — одно значение; иначе у каждого
    текстового параметра форматирование давало бы кандидата.
    """
    text = re.sub(r"[«»“”„\"]", "", str(value))
    return re.sub(r"\s+", " ", text).strip(" .,;").casefold().replace("ё", "е")


_LATIN = str.maketrans("АВЕКМНОРСТХУ", "ABEKMHOPCTXY")


def enum_key(value: object) -> str:
    """Класс/марка для сопоставления: кириллица-двойник → латиница, без пробелов («В 22,5» → «B22.5»)."""
    return re.sub(r"\s+", "", str(value)).upper().replace(",", ".").translate(_LATIN)


def enum_index(order: list[str], value: object) -> int | None:
    key = enum_key(value)
    if key in order:
        return order.index(key)
    if re.fullmatch(r"\d+(?:\.\d+)?", key):
        # «30» из «класс бетона 30» — единственное значение перечня с тем же числом
        same = [i for i, v in enumerate(order) if re.sub(r"^[^\d]+", "", v) == key]
        if len(same) == 1:
            return same[0]
    return None


_TRUE = {"да", "есть", "true", "1", "предусмотрен", "предусмотрено", "имеется", "+"}
_FALSE = {"нет", "false", "0", "отсутствует", "не предусмотрен", "не предусмотрено", "-", "—"}


def to_bool(value: object) -> bool | None:
    if isinstance(value, bool):
        return value
    text = _text(value)
    return True if text in _TRUE else False if text in _FALSE else None


def _coords(value: object) -> tuple[float, ...]:
    return tuple(float(x.replace(",", ".")) for x in re.findall(r"-?\d+(?:[.,]\d+)?", str(value)))


def _delta(diff: float, base: float | None) -> str:
    percent = f" ({diff / base * 100:+.2f} %)" if base else ""
    return f"{diff:+g}{percent}"


def _u(unit: str | None) -> str:
    return "" if not unit else unit if unit == "%" else f" {unit}"


_NOT_TRIGGER = {
    Direction.DOWN: ("увеличение", "уменьшение"),
    Direction.UP: ("уменьшение", "увеличение"),
}


def _limit(trigger: Trigger, a: float, unit: str | None, e: float | None) -> Outcome:
    """Предел из матрицы: сравнивается значение РД/ИД, эталон нужен только для дельты."""
    delta = _delta(a - e, e) if e is not None else None
    below = triggers.convert(trigger.below, trigger.unit, unit) if trigger.below is not None else None
    above = triggers.convert(trigger.above, trigger.unit, unit) if trigger.above is not None else None
    shown = _u(trigger.unit if trigger.unit == "%" else unit)
    if below is not None and a < below - EPS:
        return Outcome(True, delta, f"{a:g}{shown} меньше предела {below:g}{shown} из матрицы")
    if above is not None and a > above + EPS:
        return Outcome(True, delta, f"{a:g}{shown} больше предела {above:g}{shown} из матрицы")
    bounds = [f"не меньше {below:g}{shown}"] if below is not None else []
    bounds += [f"не больше {above:g}{shown}"] if above is not None else []
    return Outcome(False, delta, f"{a:g}{shown} в пределах матрицы ({', '.join(bounds)})")


def _numbers(param: MatrixParam, trigger: Trigger, expected: Extraction | None, actual: Extraction) -> Result:
    a = to_number(actual.value)
    e = to_number(expected.value) if expected is not None else None
    if a is None or (expected is not None and e is None):
        return Incomparable("")
    unit = actual.unit or (expected.unit if expected is not None else None) or param.unit
    if trigger.has_limit:
        return _limit(trigger, a, unit, e)
    if expected is None or e is None:
        return Incomparable("")

    diff = a - e
    tolerance = 0.5 * 10 ** -min(decimals(expected.raw_value), decimals(actual.raw_value))
    if abs(diff) <= tolerance + EPS:
        return Outcome(False, None, "значения совпадают" + (" с точностью округления" if abs(diff) > EPS else ""))
    delta = _delta(diff, e)
    if trigger.direction in _NOT_TRIGGER and (diff > 0) == (trigger.direction is Direction.DOWN):
        was, needed = _NOT_TRIGGER[trigger.direction]
        return Outcome(False, delta, f"{was} значения, триггер срабатывает только на {needed}")
    if trigger.percent is not None:
        relative = abs(diff) / abs(e) * 100 if e else math.inf
        hit = relative > trigger.percent + EPS
        verdict = "больше порога" if hit else "не больше порога"
        return Outcome(hit, delta, f"отклонение {relative:.2f} % {verdict} {trigger.percent:g} %")
    if trigger.absolute is not None:
        limit = triggers.convert(trigger.absolute, trigger.unit, unit)
        hit = abs(diff) > limit + EPS
        verdict = "больше порога" if hit else "не больше порога"
        return Outcome(hit, delta, f"расхождение {abs(diff):g}{_u(unit)} {verdict} {limit:g}{_u(unit)}")
    word = {Direction.DOWN: "значение уменьшилось", Direction.UP: "значение увеличилось"}
    return Outcome(True, delta, word.get(trigger.direction, "значения расходятся"))


def _enums(param: MatrixParam, trigger: Trigger, expected: Extraction, actual: Extraction) -> Result:
    order = [enum_key(v) for v in param.enum_values or []]
    ei, ai = enum_index(order, expected.value), enum_index(order, actual.value)
    if ei is None or ai is None:
        unknown = expected.value if ei is None else actual.value
        return Incomparable(f"значение «{unknown}» не входит в перечень матрицы ({', '.join(param.enum_values or [])})")
    steps = ai - ei
    if steps == 0:
        return Outcome(False, None, "значения совпадают")
    direction = "понижение" if steps < 0 else "повышение"
    delta = f"{direction} на {abs(steps)} ступ."
    change = f"{direction}: {expected.value} → {actual.value}"
    if trigger.direction is Direction.DOWN and steps > 0:
        return Outcome(False, delta, f"{change}, триггер срабатывает только на понижение")
    if trigger.direction is Direction.UP and steps < 0:
        return Outcome(False, delta, f"{change}, триггер срабатывает только на повышение")
    return Outcome(True, delta, change)


def _booleans(trigger: Trigger, e: bool, a: bool) -> Outcome:
    if e == a:
        return Outcome(False, None, "значения совпадают")
    change = "есть → нет" if e else "нет → есть"
    if (trigger.direction is Direction.DOWN and a) or (trigger.direction is Direction.UP and not a):
        return Outcome(False, change, f"{change}, триггер это изменение не описывает")
    return Outcome(True, change, change)


def compare(param: MatrixParam, expected: Extraction | None, actual: Extraction) -> Result:
    """Сравнение значения РД/ИД с эталоном ПД (``expected`` может отсутствовать только у предела из матрицы)."""
    trigger = triggers.for_param(param)
    data_type = plain(param.data_type)
    if data_type in ("number", "coordinate") and to_number(actual.value) is None:
        if data_type == "coordinate" and expected is not None:
            e, a = _coords(expected.value), _coords(actual.value)
            if len(e) == len(a) >= 2:
                shift = math.dist(e, a)
                limit = trigger.absolute if trigger.absolute is not None else 0.0
                verdict = "больше порога" if shift > limit + EPS else "не больше порога"
                return Outcome(shift > limit + EPS, f"{shift:+g}", f"смещение {shift:g} {verdict} {limit:g}")
        if expected is None or to_number(expected.value) is None:
            # текстовый атрибут числового параметра — например назначение помещения у M-002
            data_type = "string"
    if data_type in ("number", "coordinate"):
        if not trigger.parsed:
            return Incomparable(f"триггер матрицы не разобран: {trigger.describe()}")
        return _numbers(param, trigger, expected, actual)
    if expected is None:
        return Incomparable(f"эталонное значение не найдено, а у триггера {trigger.describe()} нет предела")
    if data_type == "enum" and param.enum_values:
        if not trigger.parsed:
            return Incomparable(f"триггер матрицы не разобран: {trigger.describe()}")
        return _enums(param, trigger, expected, actual)
    if data_type == "boolean":
        e, a = to_bool(expected.value), to_bool(actual.value)
        if e is None or a is None:
            return Incomparable("")
        return _booleans(trigger, e, a)

    if expected.value is None or actual.value is None:
        return Incomparable("")
    if _text(expected.value) == _text(actual.value):
        return Outcome(False, None, "значения совпадают")
    return Outcome(True, None, "значения расходятся")
