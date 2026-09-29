"""M-016 «Суточный расход водопотребления», м³/сут.

Регулярка матрицы ищет дословно «Суточный расход водопотребления» — так в документах не пишут ни
разу. На обучающих объектах и на паре со стенда (26.09) суточный расход записан так:

- **текст записки** — «Расчётные расходы … составят: Q = 123,576м3/сут.; q = 8,397 л/с»,
  «общее водопотребление: 53,22 м3/сут, 26,07 м3/ч», «Суммарный расчетный расход воды на здания
  106,95 м3/сут»;
- **таблица расходов** ВК и ИОС2 — шапка «м³/сут | м³/ч | л/с», строки «Хозяйственно-питьевой
  водопровод, В1 | 0,30 | 9,16 | 1,85 | 1,21», «ХВС | 8,85 | 0,9 | 0,5».

Одна величина «суточный расход» в документе встречается для разных систем, и сравнивать их между
собой нельзя. Поэтому контрольных точек три, по системе, которую называет текст перед числом или
строка таблицы: «Водопотребление» (В1, ХВС, общий расход воды), «Горячее водоснабжение» (Т3, ГВС)
и «Водоотведение» (К1, канализация, стоки). Внутри документа по каждой точке берётся **наибольшее**
значение: это итог баланса, а «в т.ч. столовая …» и «в т.ч. горячее …» — его части.

Не суточный расход здания, хотя единица та же:

- **нагрузка и отбор по техническим условиям и договору** — «подключаемой нагрузки в точке
  подключения в размере 107,5 куб.м/сут», «Разрешаемый отбор объема холодной воды … 81,57 м3/сут»:
  это лимит сетевой организации (источник ИД по матрице), а не расчёт проекта;
- **пожаротушение, полив, технологические нужды, дренаж**;
- **период строительства** — водопонижение, приток в котлован, дебит скважин, вода на стройплощадке
  (ПОС): страница с такими словами пропускается целиком;
- **пустые бланки** — «в точке 1 ___________ м3/сут».
"""

from __future__ import annotations

import re
from typing import Any

from inspector_ml.contracts.events import MatrixParam
from inspector_ml.extract.base import Found
from inspector_ml.extract.normalize import collapse, number
from inspector_ml.extract.tables import PageCell, bands, page_cells

UNIT = "м³/сут"

CONSUMPTION = "Водопотребление"
HOT_WATER = "Горячее водоснабжение"
DRAINAGE = "Водоотведение"

#: «м3/сут», «м³/сут.», «м3/сутки», «куб.м/сут».
UNIT_RE = re.compile(r"(?:м\s*[3³]|куб\.?\s*м)\s*/\s*сут(?:ки|к|\.)?(?![а-яё])", re.IGNORECASE)
#: Число прямо перед единицей: «123,576м3/сут», «1 250,5 м³/сут».
VALUE_UNIT = re.compile(
    r"(?<![\w.,/])(\d{1,3}(?:[  ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)\s*" + UNIT_RE.pattern,
    re.IGNORECASE,
)
#: Система, о которой говорит текст. Смотрим на ближайшее к числу упоминание; при равенстве
#: побеждает стоящая выше: «горячее водоснабжение» — горячая вода, хотя в нём есть «водоснабжение».
SYSTEMS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (HOT_WATER, re.compile(r"горяч\w*(?:\s+водоснабж\w*)?|\bГВС\b|\bТ3\b", re.IGNORECASE)),
    (DRAINAGE, re.compile(r"водоотвед\w*|канализац\w*|сток\w*|сточн\w*|\bК1\b", re.IGNORECASE)),
    (
        CONSUMPTION,
        re.compile(r"водопотребл\w*|водоснабж\w*|водопровод\w*|расход\w*\s+воды|\bХВС\b|\bВ1\b", re.IGNORECASE),
    ),
)
#: Не расход здания: лимит ТУ, пожаротушение, полив, технология, дренаж, прочие системы.
FOREIGN = re.compile(
    r"подключ\w*|присоедин\w*|в\s+точк\w*|не\s+более|лимит\w*|разреша\w*|отбор\w*|"
    r"пожар\w*|\bВ2\b|полив\w*|технологич\w*|производствен\w*|\bК3\b|"
    r"дренаж\w*|подтоплен\w*|водосток\w*|дождев\w*|\bК2\b|дебит\w*|приток\w*|"
    r"отход\w*|ТКО|накоплен\w*|городк\w*|_{3,}",
    re.IGNORECASE,
)
#: Страница о стройке, а не о здании: на ней расход воды — нужды стройплощадки.
CONSTRUCTION = re.compile(r"период\w*\s+строител\w*|строительн\w*\s+площадк\w*|водопонижен\w*|котлован\w*", re.I)
#: Сколько текста перед числом смотрим, чтобы понять систему.
CONTEXT = 120
#: Конец предложения: точка перед заглавной буквой или точка с запятой.
SENTENCE_END = re.compile(r"\.\s+(?=[А-ЯЁA-Z])|;\s+")
#: «в т.ч. столовая:» — доля потребителя, а не расход здания; «в т.ч. горячее …» — система, её берём.
SHARE = re.compile(r"в\s+(?:т\.?\s*ч\.?|том\s+числе)[\s,:–-]*([а-яёa-z]+)", re.IGNORECASE)


def extract(param: MatrixParam, pages: list[dict[str, Any]]) -> list[Found]:
    """Суточный расход по системам: наибольшее значение каждой системы в документе."""
    best: dict[str, Found] = {}
    for page in pages:
        if _construction(page):
            continue
        for found in [*_from_tables(page), *_from_text(page)]:
            current = best.get(found.rule_key or "")
            if current is None or float(found.value or 0) > float(current.value or 0):
                best[found.rule_key or ""] = found
    return list(best.values())


def system(context: str) -> str | None:
    """Система по тексту перед числом: последнее упоминание побеждает, скобки не считаются.

    «Холодное водоснабжение (в т.ч. Т3) 64,97» — это весь расход воды, а не горячая вода:
    уточнение в скобках не про то, что стоит в строке.
    """
    if _foreign(context):
        return None
    text = re.sub(r"\([^)]*\)", " ", context)
    best: tuple[int, str] | None = None
    for name, pattern in SYSTEMS:
        for match in pattern.finditer(text):
            if best is None or match.end() > best[0]:
                best = (match.end(), name)
    return best[1] if best else None


def _foreign(context: str) -> bool:
    """Не расход здания: лимит ТУ, пожаротушение, дренаж и прочее (уточнение в скобках не в счёт)."""
    return FOREIGN.search(re.sub(r"\([^)]*\)", " ", context)) is not None


def _share(head: str) -> bool:
    """Перед числом стоит «в т.ч. <потребитель>» — это его доля, а не итог системы."""
    return any(not any(pattern.match(word.group(1)) for _, pattern in SYSTEMS) for word in SHARE.finditer(head))


def _construction(page: dict[str, Any]) -> bool:
    return any(CONSTRUCTION.search(block.get("text") or "") for block in page.get("blocks") or [])


def _from_text(page: dict[str, Any]) -> list[Found]:
    found: list[Found] = []
    previous = ""
    for block in page.get("blocks") or []:
        if block.get("type") == "title_block":
            continue
        text = collapse(block.get("text") or "")
        # «Расчётные расходы составят:» и число бывают в соседних блоках — хвост предыдущего тоже контекст
        lead = previous[-CONTEXT:] + " " if previous else ""
        previous = text
        for match in VALUE_UNIT.finditer(text):
            head = (lead + text[: match.start()])[-CONTEXT:]
            # предыдущее предложение уже про другое: «…л/с. Нагрузка в точке подключения 96,12 м3/сут»;
            # «т.ч. » — не конец предложения
            ends = list(SENTENCE_END.finditer(head))
            head = head[ends[-1].end() :] if ends else head
            name = system(head)
            value = number(match.group(1))
            if name is None or not value or _share(head):
                continue
            found.append(
                Found(
                    rule_key=name,
                    raw_value=collapse(match.group(0)),
                    value=value,
                    page=page["page"],
                    bbox=block["bbox"],
                    snippet=collapse(head + match.group(0)),
                    unit=UNIT,
                    method="text",
                )
            )
    return found


def _from_tables(page: dict[str, Any]) -> list[Found]:
    """Строки таблицы расходов: число в колонке под шапкой «м³/сут», система — по подписи строки."""
    found: list[Found] = []
    rows = bands(page_cells(page))
    for index, row in enumerate(rows):
        header = next((cell for cell in row if _unit_header(cell.text)), None)
        if header is None:
            continue
        inline = _inline(page, row, header)
        if inline is not None:
            # «Водопотребление, м3/сут | 106,95» — подпись с единицей и значение в одной строке
            found.append(inline)
            continue
        label = ""
        for below in rows[index + 1 :]:
            if any(_unit_header(cell.text) for cell in below):
                break  # следующая шапка — дальше другая таблица
            value_cell = next((cell for cell in below if _under(cell, header) and _flow(cell.text)), None)
            # подпись строки — только левее колонки расхода: правее бывают примечания к листу
            words = " ".join(cell.text for cell in below if cell.bbox[2] <= header.left and not _flow(cell.text))
            if value_cell is None:
                # подпись строки бывает перенесена: «Хозяйственно-питьевой» / «водопровод, В1 | 0,30 | 9,16»;
                # строка с числами, но без суточного расхода (пожарный водопровод) — не перенос, а своя строка
                label = "" if any(_flow(cell.text) for cell in below) else words
                continue
            # своя подпись строки важнее перенесённой: «водоснабжение, В2» над «Бытовая канализация, К1»
            # — хвост предыдущей строки, а не начало этой
            row_label = collapse(words)
            if system(row_label) is None and not _foreign(row_label):
                row_label = collapse(f"{label} {words}")
            if system(row_label) is None and not words:
                row_label = collapse(_line_of(page, value_cell.text))
            name = system(row_label)
            label = ""
            if name is None:
                continue
            found.append(
                Found(
                    rule_key=name,
                    raw_value=value_cell.text,
                    value=number(value_cell.text),
                    page=page["page"],
                    bbox=value_cell.bbox,
                    snippet=f"{row_label} — {value_cell.text} {UNIT}",
                    unit=UNIT,
                    method="table",
                )
            )
    return found


def _unit_header(text: str) -> bool:
    """Ячейка шапки — единица без числа: «м3/сут», «м³/сут.», «Водопотребление, м3/сут»."""
    return bool(UNIT_RE.search(text)) and not re.search(r"\d", UNIT_RE.sub("", text))


def _inline(page: dict[str, Any], row: list[PageCell], header: PageCell) -> Found | None:
    """Подпись с единицей и число правее в той же строке — это строка таблицы, а не шапка."""
    name = system(UNIT_RE.sub(" ", header.text))
    value_cell = next((cell for cell in row if cell.left > header.left and _flow(cell.text)), None)
    if name is None or value_cell is None:
        return None
    return Found(
        rule_key=name,
        raw_value=value_cell.text,
        value=number(value_cell.text),
        page=page["page"],
        bbox=value_cell.bbox,
        snippet=f"{header.text} — {value_cell.text}",
        unit=UNIT,
        method="table",
    )


def _under(cell: PageCell, header: PageCell) -> bool:
    """Середина ячейки значения попадает в колонку шапки (с запасом в полширины шапки)."""
    middle = (cell.bbox[0] + cell.bbox[2]) / 2
    width = header.bbox[2] - header.bbox[0]
    return header.bbox[0] - width / 2 <= middle <= header.bbox[2] + width / 2


def _flow(text: str) -> bool:
    """Ячейка — только число расхода: «9,16», «123,576», а не «-» и не «В1»."""
    return re.fullmatch(r"\d{1,3}(?:[  ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?", text.strip()) is not None


def _line_of(page: dict[str, Any], value: str) -> str:
    """Подпись строки из текстового слоя, если детектор таблиц её не захватил.

    «Холодное водоснабжение (в т.ч. Т3) 23,714 64,97 6,606 2,845»: в таблице только числа.
    """
    pattern = re.compile(r"(?<![\w.,])" + re.escape(value) + r"(?![\d.,]*\d)")
    for block in page.get("blocks") or []:
        text = collapse(block.get("text") or "")
        match = pattern.search(text)
        if match:
            # подпись — слова между предыдущей группой чисел и группой, где стоит значение;
            # «Т3» и «В1» числом не считаются
            before = re.sub(r"(?:\s*(?<![\w.,])\d[\d.,]*)+\s*$", "", text[: match.start()])
            return re.split(r"(?<![\w.,])\d[\d.,]*", before)[-1][-CONTEXT:]
    return ""
