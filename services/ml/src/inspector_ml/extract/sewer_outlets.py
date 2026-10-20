"""M-074 «Диаметры выпусков и магистралей К1/К2», мм.

Регулярка матрицы ищет дословно «Диаметры выпусков и магистралей К1/К2» — в документах так не пишут.
Диаметр выпуска записан подписью на плане или схеме либо фразой записки:

- «Выпуск К1 Ø110», «Выпуск 1-К1 ∅160 в футл., Отм.низ.тр. 163.30», «Выпуск бытовой канализации
  К1-1 Ф100, L-3.12» — планы и схемы ИОС3 / ВК;
- «три выпуска полипропиленовых труб Д100 с системы К1, два выпуска … Д160 с системы К2»;
- «Устройство выпусков хозяйственно-бытовой канализации из труб ВЧШГ Ø100мм» (пара со стенда 26.09);
- «по выпускам из труб ВЧШГ диаметром 100, 150 и 200 мм» — водостоки, то есть К2.

Контрольная точка — выпуск: «Выпуск К1-1», если у него есть номер («1-К1» и «К1-1» — одно и то же),
иначе «Выпуски К1» / «Выпуски К2». Значение — **наибольший** диаметр точки в документе: триггер
матрицы — уменьшение диаметра выпуска в РД, и главный выпуск системы — самый крупный. Остальные
диаметры не теряются: они в `raw_value`.

Не диаметр выпуска, хотя стоит рядом со словом «выпуск» или с К1/К2:

- **футляр и гильза** — «в стальном футляре Ø325х7мм», «Труба стальная Ø325x6 (гильза)»;
- **стояки** — «Ст К2-6 ⌀250х7.3»: без слова «выпуск» подпись не засчитывается;
- **спецификация** — «К2 Хомут для трубы Ø110»: то же;
- **прочие системы** — К3 (производственная), К4 (от трапов), водопровод В1/Т3;
- **серии чертежей** — «серии 1.011.1-10 выпуск 1» у свай: диаметра там нет.
"""

from __future__ import annotations

import re
from itertools import pairwise
from typing import Any

from inspector_ml.contracts.events import MatrixParam
from inspector_ml.extract.base import Found
from inspector_ml.extract.normalize import collapse, number
from inspector_ml.extract.tables import bands, page_cells

UNIT = "мм"
#: Правдоподобный диаметр выпуска канализации, мм: меньше — отвод прибора, больше — коллектор или футляр.
MIN_MM, MAX_MM = 40.0, 400.0

OUTLET = re.compile(r"выпуск\w*", re.IGNORECASE)
#: Подпись выпуска на чертеже — с заглавной: «Выпуск К1-1 ∅110».
LABEL = re.compile(r"Выпуск(?![а-яё])")
#: Номер выпуска: «К1-1», «К2.3», «1-К1». Латинская K тоже встречается.
NUMBERED = re.compile(r"(?<![\w-])(?:([КK]\s?[12])\s*[-.]\s*(\d{1,2})|(\d{1,2})\s*-\s*([КK]\s?[12]))(?![\w.-]*\d)")
SYSTEM_CODE = re.compile(r"(?<![\wА-ЯЁа-яё])([КK][12])(?![\d\w])")
#: Система по словам: бытовая канализация — К1, водостоки и дождевая — К2.
SYSTEM_WORDS = (
    ("К1", re.compile(r"бытов\w*|хозяйствен\w*|фекальн\w*", re.IGNORECASE)),
    ("К2", re.compile(r"водосток\w*|дождев\w*|ливнев\w*|кровл\w*|талых", re.IGNORECASE)),
)
#: Диаметр: «Ø110», «∅160», «⌀250», «Ф100», «Д100», «Ду100», «DN100», «d=110», «диаметром 100, 150 и 200 мм».
DIAMETER = re.compile(
    r"(?:[Øø∅⌀]|(?<![А-ЯЁа-яёA-Za-z])(?:Ф|Д[уy]?|DN|Dn|D|d)\s*=?)\s*(\d{2,3})(?![\d,.]\d)|"
    r"диаметр\w*\s+((?:\d{2,3}\s*(?:,|и|мм)?\s*)+)",
    re.IGNORECASE,
)
#: Футляр, гильза, стояк и прочие системы — диаметр не выпуска К1/К2.
FOREIGN = re.compile(r"футл\w*|гильз\w*|\bСт\b|\bCm\b|стояк\w*|[КK][34]\b|производствен\w*|серии|сери[яй]", re.I)


def extract(param: MatrixParam, pages: list[dict[str, Any]]) -> list[Found]:
    """Диаметр каждого выпуска: наибольший в документе, все найденные — в `raw_value`."""
    by_key: dict[str, list[Found]] = {}
    for page in pages:
        for found in _from_page(page):
            by_key.setdefault(found.rule_key or "", []).append(found)
    result: list[Found] = []
    for items in by_key.values():
        best = max(items, key=lambda item: float(item.value or 0))
        diameters = sorted({float(item.value or 0) for item in items}, reverse=True)
        raw = ", ".join(f"Ø{d:g}" for d in diameters)
        result.append(
            Found(
                rule_key=best.rule_key,
                raw_value=raw,
                value=best.value,
                page=best.page,
                bbox=best.bbox,
                snippet=best.snippet,
                unit=UNIT,
                method=best.method,
            )
        )
    return result


def outlets(text: str) -> list[tuple[str, float, str]]:
    """Выпуски в тексте: (точка, диаметр, фрагмент). Фраза делится на обороты по «,;.» перед словом."""
    text = collapse(text)
    if not OUTLET.search(text):
        return []
    found: list[tuple[str, float, str]] = []
    for clause in _clauses(text):
        if not OUTLET.search(clause):
            continue
        key = _key(clause)
        if key is None:
            continue
        for value in _diameters(clause):
            found.append((key, value, clause))
    return found


def _from_page(page: dict[str, Any]) -> list[Found]:
    found: list[Found] = []
    texts: list[tuple[str, list[float], str]] = [
        (collapse(block.get("text") or ""), block["bbox"], "text")
        for block in page.get("blocks") or []
        if block.get("type") != "title_block"
    ]
    # подпись на плане бывает разрезана на две строки: «Выпуск бытовой» / «канализации К1-1 Ф100»
    joined = [
        (f"{first} {second}", _union(box1, box2), "text")
        for (first, box1, _), (second, box2, _) in pairwise(texts)
        if OUTLET.search(first) and not DIAMETER.search(first) and not OUTLET.search(second)
    ]
    rows = [
        (" ".join(cell.text for cell in band), _union(*(cell.bbox for cell in band)), "table")
        for band in bands(page_cells(page))
    ]
    seen: set[tuple[str, float]] = set()
    from_text: set[str] = set()
    for text, bbox, method in [*texts, *joined, *rows]:
        for key, value, clause in outlets(text):
            # строка таблицы на чертеже — склейка подписей со всего листа: берём её, только если
            # выпуск не подписан отдельным текстом
            if (key, value) in seen or (method == "table" and key in from_text):
                continue
            seen.add((key, value))
            if method == "text":
                from_text.add(key)
            found.append(
                Found(
                    rule_key=key,
                    raw_value=f"Ø{value:g}",
                    value=value,
                    page=page["page"],
                    bbox=bbox,
                    snippet=clause,
                    unit=UNIT,
                    method=method,
                )
            )
    return found


def _clauses(text: str) -> list[str]:
    """Обороты: «три выпуска … Д100 с системы К1, два выпуска … Д160 с системы К2» — два оборота.

    Делим по «;», по точке перед заглавной и по запятой перед числительным или словом «выпуск»:
    запятые внутри перечня диаметров («100, 150 и 200 мм») оборот не рвут.
    """
    parts = re.split(
        r";\s*|\.\s+(?=[А-ЯЁA-Z])|,\s*(?=(?:один|одна|два|две|три|четыре|пять|\d+\s*-?\s*[КK]|выпуск))",
        text,
        flags=re.IGNORECASE,
    )
    clauses: list[str] = []
    for part in (part.strip() for part in parts):
        # строка таблицы чертежа склеивает соседние подписи: «Выпуск 3-К2 ∅160 Выпуск 2-К1 ∅110»
        labels = [match.start() for match in LABEL.finditer(part)]
        if len(labels) < 2:
            clauses.append(part)
            continue
        clauses += [part[start:end].strip() for start, end in zip(labels, [*labels[1:], len(part)], strict=True)]
    return [clause for clause in clauses if clause]


def _key(clause: str) -> str | None:
    numbered = NUMBERED.search(clause)
    if numbered:
        system = re.sub(r"\s", "", numbered.group(1) or numbered.group(4)).upper().replace("K", "К")
        return f"Выпуск {system}-{int(numbered.group(2) or numbered.group(3))}"
    code = SYSTEM_CODE.search(clause)
    if code:
        return f"Выпуски {code.group(1).upper().replace('K', 'К')}"
    for system, words in SYSTEM_WORDS:
        if words.search(clause):
            return f"Выпуски {system}"
    return None


def _diameters(clause: str) -> list[float]:
    """Диаметры оборота до футляра: «Ø100мм … в стальном футляре Ø325х7мм» даёт только 100."""
    stop = FOREIGN.search(clause)
    head = clause[: stop.start()] if stop else clause
    values: list[float] = []
    for match in DIAMETER.finditer(head):
        candidates = [match.group(1)] if match.group(1) else re.findall(r"\d{2,3}", match.group(2))
        for raw in candidates:
            value = number(raw)
            if value is not None and MIN_MM <= value <= MAX_MM:
                values.append(value)
    return values


def _union(*boxes: list[float]) -> list[float]:
    return [
        min(box[0] for box in boxes),
        min(box[1] for box in boxes),
        max(box[2] for box in boxes),
        max(box[3] for box in boxes),
    ]
