"""M-009 «Абсолютная отметка 0.000».

Одна точка на объект — «Отметка 0.000», значение — абсолютная отметка в метрах. Шаблон матрицы
ловит один оборот («0.000 … соответствует абсолютной отметке …»), а в документах обучающей части
(Новослободская, Алтуфьевское 79Б, «Пример нарушений на чертежах») их больше десятка:

- «За относительную отметку 0,000 принята абсолютная отметка 159,95 м» — так пишет почти вся
  Новослободская, и шаблон матрицы этого не видит;
- «…принята абс. отм. 159,95 м», «…соответствует абсолютной отм. 164,18»;
- «…принята отметка чистого пола первого этажа, соответствующая абсолютной отметке 159.95»;
- «Отметка нуля принята на абсолютной отметке +159.950» (эталон PZ-009, ПД КР2 стр. 53);
- «абсолютная отметка 0,000 принята 138,00», «…абсолютной отметке: 0,000 = 138,00»;
- «Абсолютная отметка 159.95 "0.000" здания», «± 0,000 м (абс. отметка) 159,95».

Поэтому разбор идёт от «абсолютной отметки» к числу сразу за ней, а относится ли она к нулю,
решает сама фраза: в том же предложении должна быть названа отметка 0,000 (или «отметка нуля»).
Иначе это другая абсолютная отметка — «разработка грунта котлована до отм. -9.950 (абс. отм.
150.000)», уровень грунтовых вод, верх элемента.
"""

from __future__ import annotations

import re
from typing import Any

from inspector_ml.contracts.events import MatrixParam
from inspector_ml.extract.base import Found
from inspector_ml.extract.normalize import collapse

RULE_KEY = "Отметка 0.000"
UNIT = "м"
#: Правдоподобная абсолютная отметка, м. Отсекает относительные («-13,750») и номера пунктов.
MIN_M, MAX_M = 20.0, 500.0

#: «абсолютная отметка», «абсолютной отметке», «абс. отм.», «абсолютной высотной отметке».
ABSOLUTE = re.compile(r"абс(?:олютн\w*|\.)\s*(?:высотн\w*\s+)?отм(?:етк\w*|\.)", re.IGNORECASE)
#: Число сразу за ней: «159,95», «+164.18», «: 0,000 = 138,00», «0,000 принята 138,00», «) 159,95».
VALUE = re.compile(
    r"[\s:)]*(?:(?:[±+]\s?)?0[.,]000\s*(?:=|принят\w*)\s*)?(?:на\s+)?\+?\s?(?P<value>\d{2,3}[.,]\d{1,3})(?!\d)",
    re.IGNORECASE,
)
#: Отметка нуля в той же фразе: «0,000», «±0.000», «отметка нуля», «нулевая отметка».
ZERO = re.compile(r"(?<!\d)(?<!\d[.,])[±+]?\s?0[.,]000(?!\d)|отметк\w*\s+нул|нулев\w*\s+отметк", re.IGNORECASE)
#: Другая относительная отметка в той же фразе («до отм. -9.950», «низа -14.950»): абсолютная
#: отметка рядом с ней описывает её, а не ноль.
OTHER_LEVEL = re.compile(r"(?<![\d.,])[-+]\s?\d{1,2}[.,]\d{3}(?!\d)")
#: Конец фразы: точка, за которой заглавная буква или номер пункта; точка с запятой.
SENTENCE_END = re.compile(r"[.;]\s+(?=[А-ЯЁA-Z]|\d+\.\s)|;")


def extract(param: MatrixParam, pages: list[dict[str, Any]]) -> list[Found]:
    """Абсолютные отметки нуля в документе — по одному значению на каждое различное.

    Два разных значения в одном документе не сводятся к одному: движок сравнения попросит
    инспектора выбрать источник, и это честнее, чем выбрать самому (например, в томе сноса
    у каждого сносимого здания свой ноль).
    """
    found: dict[float, Found] = {}
    for page in pages:
        for block in page.get("blocks") or []:
            for number, item in _mentions(page["page"], block):
                found.setdefault(number, item)
    return list(found.values())


def _mentions(page: int, block: dict[str, Any]) -> list[tuple[float, Found]]:
    """Абсолютные отметки нуля в блоке текста: значение и где нашли."""
    text = collapse(block["text"])
    found: list[tuple[float, Found]] = []
    for absolute in ABSOLUTE.finditer(text):
        value = VALUE.match(text, absolute.end())
        if value is None:
            continue
        number = float(value.group("value").replace(",", "."))
        if not MIN_M <= number <= MAX_M:
            continue
        start, end = _sentence(text, absolute.start())
        zero = _zero_in(text, start, end, value)
        if zero is None:
            continue
        # между нулём и абсолютной отметкой не должно быть другой относительной отметки
        left, right = (zero.end(), absolute.start()) if zero.end() <= absolute.start() else (value.end(), zero.start())
        if OTHER_LEVEL.search(text, left, right):
            continue
        item = Found(
            rule_key=RULE_KEY,
            raw_value=value.group("value"),
            value=number,
            page=page,
            bbox=block["bbox"],
            snippet=text[start:end][:300],
            unit=UNIT,
            method="regex",
        )
        found.append((number, item))
    return found


def _sentence(text: str, position: int) -> tuple[int, int]:
    """Границы фразы вокруг позиции."""
    start = 0
    for end in SENTENCE_END.finditer(text, 0, position):
        start = end.end()
    after = SENTENCE_END.search(text, position)
    return start, after.start() + 1 if after else len(text)


def _zero_in(text: str, start: int, end: int, value: re.Match[str]) -> re.Match[str] | None:
    """Отметка нуля во фразе — не считая само значение («138.000» не ноль)."""
    for zero in ZERO.finditer(text, start, end):
        if not value.start("value") <= zero.start() < value.end("value"):
            return zero
    return None
