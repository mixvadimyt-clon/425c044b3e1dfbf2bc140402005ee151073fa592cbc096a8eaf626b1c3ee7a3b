"""Общее извлечение по матрице: `regex_pattern` и `semantic_anchors`.

Матрица растёт (M-001…M-132, активирует их админ), и писать отдельный разбор под каждый параметр
нельзя — к защите их будет десятки. Поэтому у параметра без своего извлекателя работает этот
путь: шаблон из матрицы по тексту страницы плюс поиск строки таблицы по якорям.

Правила шаблона (docs/domain/matrix.md): синтаксис Python, **группа 1 — значение**. Если групп
нет, значением считается всё совпадение. Тип значения берётся из `data_type` параметра:
`number` — число, `enum` — совпадение из `enum_values`, остальное — текст.

`rule_key` здесь всегда `None`: без предметного разбора нельзя сказать, к какому элементу
относится значение, а выдумывать ключ опаснее, чем его не выдавать — движок сравнения сложит
разные элементы в одну контрольную точку.
"""

from __future__ import annotations

import re
from functools import lru_cache
from typing import Any

from inspector_ml.contracts.events import MatrixParam
from inspector_ml.extract.base import Found
from inspector_ml.extract.normalize import collapse, lookalike, number
from inspector_ml.extract.tables import anchors, named_row, page_cells

#: Сколько значений одного параметра берём со страницы: дальше это уже перечисление, а не показатель.
MAX_PER_PAGE = 20


def extract(param: MatrixParam, pages: list[dict[str, Any]]) -> list[Found]:
    """Значения параметра на страницах документа — по шаблону матрицы и по якорям."""
    pattern = _compiled(param.regex_pattern)
    names = anchors(param.semantic_anchors)

    found: list[Found] = []
    for page in pages:
        page_found = _by_anchor(param, page, names)
        if not page_found and pattern is not None:
            page_found = _by_pattern(param, page, pattern)
        found.extend(page_found[:MAX_PER_PAGE])
    return found


@lru_cache(maxsize=256)
def _compiled(pattern: str | None) -> re.Pattern[str] | None:
    """Шаблон матрицы. Битый шаблон не роняет разбор: параметр просто не найдётся по регулярке."""
    if not pattern:
        return None
    try:
        return re.compile(pattern)
    except re.error:
        return None


def _by_anchor(param: MatrixParam, page: dict[str, Any], names: tuple[str, ...]) -> list[Found]:
    """Строка таблицы, наименование которой совпало с якорем, и её значение.

    У числового параметра значение — самая правая числовая ячейка строки. У перечислимого —
    ячейка, которая целиком совпадает с одним из значений перечня: самое правое число строки
    для «С0» или «II» всегда мусор.
    """
    data_type = getattr(param.data_type, "root", param.data_type)
    # у строкового параметра значение строки таблицы — текст, а не самое правое число: иначе
    # «Конструкция дорожной одежды» получала «+1.92» из соседней ячейки (замер 25.09, ПЗУ)
    if not names or data_type not in ("number", "enum"):
        return []
    accept = None
    if data_type == "enum":
        values = [v for v in (param.enum_values or []) if v]

        def accept(cell: Any) -> bool:
            return _enum_cell(values, cell.text) is not None

    row = named_row(page_cells(page), names, accept)
    if row is None:
        return []
    name, value = row
    return [
        Found(
            rule_key=None,
            raw_value=value.text,
            value=_value(param, value.text),
            page=page["page"],
            bbox=value.bbox,
            snippet=f"{name.text} — {value.text}",
            unit=param.unit,
            method="table",
        )
    ]


def _by_pattern(param: MatrixParam, page: dict[str, Any], pattern: re.Pattern[str]) -> list[Found]:
    found: list[Found] = []
    number_param = getattr(param.data_type, "root", param.data_type) == "number"
    for block in page.get("blocks") or []:
        if block.get("type") == "title_block":
            continue
        text = collapse(block["text"])
        for match in pattern.finditer(text):
            group = 1 if match.re.groups else 0
            raw = match.group(group)
            if not number_param and _torn_from_word(text, match.start(group), match.end(group)):
                continue
            found.append(
                Found(
                    rule_key=None,
                    raw_value=raw,
                    value=_value(param, raw),
                    page=page["page"],
                    bbox=block["bbox"],
                    snippet=text[max(0, match.start() - 80) : match.end() + 40],
                    unit=param.unit,
                    method="regex",
                )
            )
    return found


#: Буквенное значение не длиннее стольких букв проверяем на склейку со словом и на предлог.
SHORT_VALUE = 3


def _torn_from_word(text: str, start: int, end: int) -> bool:
    """Короткое буквенное значение — обрывок слова или предлог, а не значение.

    Шаблон класса энергоэффективности в матрице — `\\D{0,20}([A-GА-Г]\\+{0,2})` с `(?i)`: после
    названия любые не-цифры, потом буква. Без учёта регистра кириллические «а», «б», «в» — это
    «А», «Б», «В», и на замере находимости 24.09 все 102 значения M-021 и M-124 оказались ложными:

    - **обрывок слова** — «а» из «класс энергетической эффективности лифт|а|»;
    - **предлог** — «в» из «сведения о классе энергетической эффективности (|в| случае если…»,
      «…определены |в| соответствии».

    Настоящий класс пишут заглавной и отдельно: «A», «B+», «А». Строчная одиночная буква — предлог
    или союз; то же правило уже работает для класса бетона («ГПЗУ в 50 м» — не B50).

    Шаблон берётся из матрицы, но граница слова — общее правило, и держать его в каждом
    шаблоне хуже, чем здесь одно. Значения с цифрами не трогаем: «С0», «B30F150», «120м2».
    """
    value = text[start:end].strip()
    letters = [ch for ch in value if ch.isalpha()]
    if not letters or len(letters) > SHORT_VALUE or any(ch.isdigit() for ch in value):
        return False
    before = text[start - 1] if start > 0 else " "
    after = text[end] if end < len(text) else " "
    if before.isalpha() or after.isalpha():
        return True
    return len(letters) == 1 and letters[0].islower()


def _value(param: MatrixParam, raw: str) -> float | str | None:
    """Нормализованное значение по типу параметра из матрицы."""
    data_type = getattr(param.data_type, "root", param.data_type)
    if data_type == "number":
        return number(raw)
    if data_type == "enum":
        return _enum(param, raw)
    return collapse(raw)


#: Что можно отбросить вокруг значения в ячейке перечня: «С0.», «(II)», «- КМ1;».
_CELL_TRIM = ' 	.,;:()[]«»"-–—'


def _enum_cell(values: list[str], text: str) -> str | None:
    """Значение перечня, если ячейка **целиком** им является (с точностью до знаков вокруг).

    Вхождения подстрокой здесь мало: в строке таблицы стоят и номера, и шифры, и «I» найдётся
    внутри чего угодно латинского.
    """
    cell = lookalike(text).strip(_CELL_TRIM)
    return next((value for value in values if lookalike(value) == cell), None)


def _enum(param: MatrixParam, raw: str) -> str | None:
    """Совпадение со списком значений матрицы — с приведением визуально одинаковых букв.

    Без приведения кириллическая «В25» из документа никогда не совпала бы с латинской «B25»
    из матрицы, а это ровно случай M-055 и всех марок.
    """
    values = [v for v in (param.enum_values or []) if v]
    normalized = lookalike(raw)
    for value in values:
        if lookalike(value) == normalized:
            return value
    return next((value for value in values if lookalike(value) in normalized), None)
