"""M-041 «Ширина эвакуационных выходов (дверей)».

Атомарная точка одна — «Эвакуационный выход», значение — **наименьшая** ширина в документе, в метрах.
Триггер матрицы — предел: «ширина дверного полотна на путях эвакуации в РД/ИД < 0.9 м», и за него
отвечает самая узкая дверь; все найденные ширины остаются в `raw_value` дословно. Так же устроен
M-058: движок сравнения при нескольких разных значениях одной стадии просит инспектора выбрать.

Где ширина живёт в настоящих документах (обучающие объекты: Новослободская, Алтуфьевское,
«Пример нарушений»):

1. **Спецификация элементов заполнения проёмов** (источник РД по матрице) — таблица «Поз. /
   Обозначение / Наименование / … / Высота проёма / Ширина проёма», строки «Д-1 … дверь
   металлическая, распашная, двупольная … 2040 | 2000». Размеры в миллиметрах. Шапку детектор
   таблиц часто склеивает в одну ячейку «Высота Ширина Масса», поэтому колонку ширины берём по
   порядку слов в шапке: второе из двух чисел-размеров строки, если «высота» стоит раньше «ширины».
2. **Пояснительная записка и ПБ** — «ширина выходов из подземной автостоянки в лестничные клетки
   принята 1,0 м», «…через выход (Exit_07) по оси 18 … ширина выхода 0,8 м».

Ловушки, каждая из которых дала бы ложное «< 0.9 м» или ложное число:

- **единицы**: «шириной дверного проёма 800 мм» — это 0.8 м, а не 800 м (9 значений «вне
  диапазона» на замере находимости 25.09 были ровно этим);
- **лифт, вентиляция, марши**: «кабина лифта … шириной дверного проёма 800 мм», «гибкая вставка
  900 х 900 мм» рядом со словом «выход», «ширина марша 1,4 м» — не эвакуационный выход;
- **расчёт и норма**: «требуемая ширина эвакуационного выхода 0,6 м, но не менее 1,2 м —
  фактическая ширина …» — берём фактическую; цитаты СП «ширина … должна быть не менее 1,2 м» —
  требование, а не решение проекта, их пропускаем;
- **двери, которые не на пути эвакуации**: в спецификации рядом с входными стоят двери санузлов
  шириной 0.7 м. Строка спецификации засчитывается, только если сама строка или заголовок её
  раздела говорит о наружной, входной, витражной, противопожарной или эвакуационной двери.
"""

from __future__ import annotations

import re
from typing import Any

from inspector_ml.contracts.events import MatrixParam
from inspector_ml.extract.base import Found
from inspector_ml.extract.normalize import collapse
from inspector_ml.extract.tables import PageCell, bands, page_cells

RULE_KEY = "Эвакуационный выход"
#: Правдоподобная ширина эвакуационного выхода, м: уже — это фрамуга или люк, шире — ворота.
MIN_M, MAX_M = 0.5, 4.0

#: «ширина … выход / дверь / проём / полотно» в одном обороте.
WIDTH = re.compile(r"ширин\w*[^.;:\d]{0,50}?(?:выход\w*|двер\w*|про[её]м\w*|полотн\w*)", re.IGNORECASE)
#: Путь эвакуации рядом: иначе «ширина дверей» может быть про что угодно.
EVACUATION = re.compile(
    r"эвакуац\w*|выход\w*\s+(?:наружу|из|на|в)\b|входн\w*\s+двер\w*|наружн\w*\s+двер\w*|лестничн\w*\s+клет\w*",
    re.IGNORECASE,
)
#: Не эвакуационный выход.
FOREIGN = re.compile(
    r"лифт\w*|кабин\w*|марш\w*|площадк\w*|вставк\w*|клапан\w*|вентуст\w*|калорифер\w*|окн\w*|фрамуг\w*|люк\w*",
    re.IGNORECASE,
)
#: Требование, а не решение проекта: цитата СП.
NORM = re.compile(r"должн\w*|следует", re.IGNORECASE)
#: Число с единицей: «1,2 м», «800 мм», «90 см», «0.9м».
VALUE = re.compile(r"(?<![\d.,])(\d{1,4}(?:[.,]\d{1,3})?)\s*(мм|см|м)(?![а-яa-z²³])", re.IGNORECASE)
#: Перед числом — расчётная, а не фактическая ширина.
REQUIRED = re.compile(r"требуем\w*[^.;]{0,25}$", re.IGNORECASE)
ACTUAL = re.compile(r"фактическ\w*\s+ширин\w*", re.IGNORECASE)
SENTENCE = re.compile(r"(?<=[.;!?])\s+")

#: Позиция двери в спецификации: «Д-1», «Д-2*», «ДН-3», «ДП1».
DOOR_POSITION = re.compile(r"^Д[А-ЯЁ]{0,3}[-\s]?\d{1,3}\*?$")
#: Дверь на пути эвакуации — по строке или заголовку раздела спецификации.
EVACUATION_DOOR = re.compile(
    r"наружн\w*|входн\w*|витраж\w*|эвакуац\w*|противопожарн\w*|\bEI\s*\d+|выход\w*|тамбур\w*|лестничн\w*",
    re.IGNORECASE,
)
#: Заголовок раздела спецификации: короткая строка про двери или витражи.
SECTION_HEADER = re.compile(
    r"(?=.{0,40}$)(?:[А-ЯЁа-яё-]+\s+){0,3}(?:двер|витраж)\w*(?:\s+[А-ЯЁа-яё-]+){0,3}", re.IGNORECASE
)
#: Шапка спецификации проёмов: в ней есть и «высота», и «ширина» (проёма).
HEADER_HEIGHT = re.compile(r"высот\w*", re.IGNORECASE)
HEADER_WIDTH = re.compile(r"ширин\w*", re.IGNORECASE)
#: Размер проёма в спецификации, мм.
SIZE_MM = re.compile(r"^\d{3,4}$")
MIN_SIZE_MM, MAX_SIZE_MM = 500, 4000


def extract(param: MatrixParam, pages: list[dict[str, Any]]) -> list[Found]:
    """Наименьшая ширина эвакуационного выхода в документе — одним значением, все ширины в `raw_value`."""
    found: list[Found] = []
    for page in pages:
        found.extend(_from_schedule(page))
        found.extend(_from_text(page))
    if not found:
        return []
    narrowest = min(found, key=lambda item: float(item.value or 0))
    widths = sorted({float(item.value or 0) for item in found})
    return [
        Found(
            rule_key=RULE_KEY,
            raw_value="; ".join(_metres(width) for width in widths),
            value=narrowest.value,
            page=narrowest.page,
            bbox=narrowest.bbox,
            snippet=narrowest.snippet,
            unit="м",
            method=narrowest.method,
        )
    ]


def _from_text(page: dict[str, Any]) -> list[Found]:
    found: list[Found] = []
    for block in page.get("blocks") or []:
        if block.get("type") == "title_block":
            continue
        text = collapse(block["text"])
        for sentence in SENTENCE.split(text):
            width = WIDTH.search(sentence)
            if not width or NORM.search(sentence) or FOREIGN.search(sentence) or not EVACUATION.search(sentence):
                continue
            value = _first_width(sentence, width.end())
            if value is None:
                continue
            found.append(
                Found(
                    rule_key=RULE_KEY,
                    raw_value=_metres(value),
                    value=value,
                    page=page["page"],
                    bbox=block["bbox"],
                    snippet=sentence[:240],
                    unit="м",
                    method="text",
                )
            )
    return found


def _first_width(sentence: str, start: int) -> float | None:
    """Первая фактическая ширина после слов «ширина … выхода»: расчётную «требуемую» пропускаем.

    В расчёте ПБ пишут «требуемая ширина … 0,6 м, но не менее 1,2 м — фактическая ширина 1,5 м»:
    если слово «фактическая» есть, значение берётся после него.
    """
    actual = ACTUAL.search(sentence, start)
    if actual:
        start = actual.end()
    for match in VALUE.finditer(sentence, start):
        if REQUIRED.search(sentence[max(0, match.start() - 40) : match.start()]):
            continue
        metres = _to_metres(float(match.group(1).replace(",", ".")), match.group(2).casefold())
        if metres is not None:
            return metres
    return None


def _to_metres(number: float, unit: str) -> float | None:
    metres = number / 1000 if unit == "мм" else number / 100 if unit == "см" else number
    return round(metres, 3) if MIN_M <= metres <= MAX_M else None


def _from_schedule(page: dict[str, Any]) -> list[Found]:
    """Двери на путях эвакуации из спецификации заполнения проёмов.

    Колонку «Наименование» и заголовки разделов («Витражные двери») детектор таблиц часто не
    собирает в ячейки — они остаются текстовыми блоками страницы. Поэтому описание двери берётся
    ещё и из блоков на одной высоте со строкой, а раздел — из ближайшего короткого заголовка выше.
    """
    rows = bands(page_cells(page))
    width_index = _width_index(rows)
    if width_index is None:
        return []
    blocks = [(collapse(block["text"]), block["bbox"]) for block in page.get("blocks") or [] if block.get("text")]
    found: list[Found] = []
    section = ""
    for row in rows:
        position = row[0].text.strip()
        row_text = " ".join(cell.text for cell in row)
        sizes = [cell for cell in row if SIZE_MM.match(cell.text.strip()) and _plausible_mm(cell)]
        if not DOOR_POSITION.match(position):
            if not sizes:  # строка-заголовок раздела: «Витражные двери», «Двери внутренние»
                section = row_text
            continue
        top, bottom = min(cell.top for cell in row), max(cell.bottom for cell in row)
        described = " ".join([row_text, *(text for text, box in blocks if _same_band(box, top, bottom))])
        header = _section_above(blocks, top) or section
        if not (EVACUATION_DOOR.search(described) or EVACUATION_DOOR.search(header)):
            continue
        if len(sizes) <= width_index:
            continue
        width_cell = sizes[width_index]
        metres = _to_metres(float(width_cell.text), "мм")
        if metres is None:
            continue
        found.append(
            Found(
                rule_key=RULE_KEY,
                raw_value=_metres(metres),
                value=metres,
                page=page["page"],
                bbox=width_cell.bbox,
                snippet=f"{header[:40]}: {described[:160]}" if header else described[:200],
                unit="м",
                method="table",
            )
        )
    return found


def _same_band(box: list[float], top: float, bottom: float) -> bool:
    overlap = min(box[3], bottom) - max(box[1], top)
    smaller = min(box[3] - box[1], bottom - top)
    return smaller > 0 and overlap >= 0.4 * smaller


def _section_above(blocks: list[tuple[str, list[float]]], top: float) -> str | None:
    """Ближайший заголовок раздела спецификации выше строки: «Витражные двери», «Двери наружные»."""
    headers = [
        (box[3], text)
        for text, box in blocks
        if box[3] <= top + 0.002 and SECTION_HEADER.fullmatch(text)
    ]
    return max(headers)[1] if headers else None


def _width_index(rows: list[list[PageCell]]) -> int | None:
    """Какое по счёту из чисел-размеров строки — ширина: по порядку «высота» и «ширина» в шапке."""
    for row in rows:
        text = " ".join(cell.text for cell in row)
        height, width = HEADER_HEIGHT.search(text), HEADER_WIDTH.search(text)
        if height and width:
            return 1 if height.start() < width.start() else 0
    return None


def _plausible_mm(cell: PageCell) -> bool:
    return MIN_SIZE_MM <= int(cell.text.strip()) <= MAX_SIZE_MM


def _metres(value: float) -> str:
    return f"{value:g} м".replace(".", ",")
