"""Разбор «Логики ИИ-связи (предварительный триггер)» из Приложения 1 — свободного текста — в правило срабатывания.

Шаблоны — docs/domain/matrix.md, «Семантика trigger_logic»:

- направление: «Понижение», «Снижение», «Уменьшение», «Сокращение», «Занижение», «Сужение», «Подмена»,
  «Отсутствие» → срабатывает только уменьшение (для перечислений — шаг вниз по ``enum_values``);
  «Увеличение», «Превышение», «Завышение» → только рост; «Изменение», «Расхождение», «Дельта»,
  «Несоответствие», «… или …» в обе стороны → любое отличие;
- порог отклонения: «> 1%» — относительно эталона (ПД), «> 0.5 м» после «Расхождение/Смещение/Дельта» — абсолютный;
- предел значения: «< 0.9 м», «менее 1.2 м», «Высота порога > 0.014 м» — значение РД/ИД сравнивается
  с пределом из матрицы, а не с ПД. Нормы сами по себе не проверяем — только записанный в матрице
  порог. Диапазон «1.5-1.8 м» — берём нижнюю границу: ниже неё нарушение при любом варианте нормы.
  ``min_value`` / ``max_value`` матрицы — такие же пределы.

Текст, в котором ничего из этого нет, — «триггер не разобран»: для числа и перечисления сравнение не делаем
(NOT_COMPARABLE), строки сравниваются как текст.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, replace
from enum import StrEnum
from functools import lru_cache

from inspector_ml.contracts.events import MatrixParam


class Direction(StrEnum):
    ANY = "any"
    DOWN = "down"
    UP = "up"


@dataclass(frozen=True)
class Trigger:
    text: str
    direction: Direction
    parsed: bool
    percent: float | None = None
    """Относительный порог, %: срабатывает при |Δ| / |эталон| > percent."""
    absolute: float | None = None
    """Абсолютный порог в единицах ``unit``: срабатывает при |Δ| > absolute."""
    below: float | None = None
    """Предел снизу: значение РД/ИД меньше — срабатывание."""
    above: float | None = None
    """Предел сверху: значение РД/ИД больше — срабатывание."""
    unit: str | None = None
    """Единица порога или предела из текста триггера («м», «мм», «%»)."""

    @property
    def has_limit(self) -> bool:
        return self.below is not None or self.above is not None

    def describe(self) -> str:
        return f"«{self.text}»" if self.text else "не задан"


_ANY = re.compile(r"изменени|расхождени|дельт|несоответстви|несовпадени|смещени|сдвиг|нарушени|выход")
_DOWN = re.compile(r"понижени|снижени|уменьшени|сокращени|занижени|сужени|ухудшени|подмен|замен|отсутстви|исключени")
_DOWN_STRONG = re.compile(r"понижени|снижени|уменьшени|сокращени|занижени|сужени|ухудшени")
_UP = re.compile(r"увеличени|превышени|завышени|более\s+высок")
_BOTH = re.compile(
    r"(увеличени|завышени)\w*\s+или\s+(уменьшени|занижени)|(уменьшени|занижени)\w*\s+или\s+(увеличени|завышени)"
)
_CHANGE = re.compile(r"расхождени|дельт|смещени|сдвиг")

_NUMBER = r"(\d+(?:[.,]\d+)?)(?:\s*[-–]\s*(\d+(?:[.,]\d+)?))?\s*(%|мм|см|м(?![²2³\w]))?"
_LESS = re.compile(r"(?:<|≤|менее|ниже)\s*" + _NUMBER)
_MORE = re.compile(r"(?:>|≥|более)\s*" + _NUMBER)

LENGTH: dict[str, float] = {"мм": 0.001, "см": 0.01, "м": 1.0}


def _num(text: str) -> float:
    return float(text.replace(",", "."))


def parse(text: str | None) -> Trigger:
    raw = re.sub(r"\s+", " ", text or "").strip()
    low = raw.casefold().replace("ё", "е")

    # направление — по основному тексту: «(риск нарушения …)», «табло "Выход"» его не меняют;
    # если там слов нет («Применение кабеля … (например, замена FRLS на LS)») — по всему тексту
    words = re.sub(r"\([^)]*\)|\"[^\"]*\"|«[^»]*»", " ", low)
    if not (_ANY.search(words) or _UP.search(words) or _DOWN.search(words)):
        words = low
    up, down = bool(_UP.search(words)), bool(_DOWN.search(words))
    if _BOTH.search(words) or _ANY.search(words):
        direction = Direction.ANY
    elif up and down:
        # «Замена утеплителя на аналог с более высоким коэффициентом» — направление даёт «более высоким»;
        # «Превышение … или занижение …» — в обе стороны
        direction = Direction.ANY if _DOWN_STRONG.search(words) else Direction.UP
    elif up:
        direction = Direction.UP
    elif down:
        direction = Direction.DOWN
    else:
        direction = Direction.ANY

    percent = absolute = below = above = None
    unit: str | None = None
    lows = list(_LESS.finditer(low))
    if lows:
        # «Высота коридоров < 2.0 м или дверей < 1.9 м» — несколько пределов: берём наименьший (меньше ложных)
        m = min(lows, key=lambda x: _num(x.group(1)))
        below, unit = _num(m.group(1)), m.group(3)
    for m in _MORE.finditer(low):
        value, m_unit = _num(m.group(1)), m.group(3)
        if m_unit == "%":
            percent = value
        elif _CHANGE.search(low[: m.start()]):
            absolute, unit = value, m_unit or unit
        elif above is None:
            above, unit = value, m_unit or unit

    parsed = bool(_ANY.search(words) or up or down or lows or _MORE.search(low))
    return Trigger(raw, direction, parsed, percent, absolute, below, above, unit)


@lru_cache(maxsize=512)
def _parse_cached(text: str | None) -> Trigger:
    return parse(text)


def for_param(param: MatrixParam) -> Trigger:
    """Триггер параметра. ``min_value`` / ``max_value`` матрицы — пределы в единицах параметра, если в тексте их нет."""
    trigger = _parse_cached(param.trigger_logic)
    if trigger.has_limit or (param.min_value is None and param.max_value is None):
        return trigger
    return replace(trigger, parsed=True, below=param.min_value, above=param.max_value, unit=None)


def convert(value: float, unit: str | None, target: str | None) -> float:
    """Перевод длины порога в единицы значения (м ↔ мм ↔ см); остальное — как есть."""
    if unit in LENGTH and target in LENGTH and unit != target:
        return value * LENGTH[unit] / LENGTH[target]
    return value


def normative_reference(param: MatrixParam) -> str | None:
    parts = [param.sp_reference, param.gost_reference, param.fz_reference, param.other_normative]
    text = "; ".join(p.strip() for p in parts if p and p.strip())
    return text or None
