"""M-002 «Общая площадь здания»: ТЭП и экспликации помещений.

Параметр даёт три вида атомарных точек (решение по inbox от 2026-09-18):

- `Общая площадь здания` — итог по объекту из таблицы ТЭП пояснительной записки;
- `Экспликация помещений <N>-го этажа` — итог по этажу, последняя сумма под таблицей;
- `пом. <номер>` и `пом. <номер> (назначение)` — **две** точки на строку экспликации: площадь
  помещения и его наименование. Это разные контрольные точки: в пилоте организаторов
  (ALT79B-V01) нарушением было и изменение площади, и подмена назначения помещения.

Наименования в документах не совпадают дословно: в ПД пишут «Площадь жилого здания», в РД —
«Общая площадь здания», в ТЭП попадается «Общая площадь объекта». Поэтому строка ТЭП ищется не по
одному шаблону, а по списку синонимов — и этот список берётся **из матрицы**
(`MatrixParam.semantic_anchors`, приходит в `CompareRequest.matrix`).
Своей копии синонимов в коде нет намеренно: две копии
разошлись бы молча, а матрицу правят без релиза ML. Если якорей у параметра нет, строка ТЭП
просто не находится — экспликации при этом работают: их таблицы ищутся по заголовку и геометрии.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Callable, Iterable
from typing import Any

from inspector_ml.contracts.events import MatrixParam
from inspector_ml.extract.base import Found
from inspector_ml.extract.normalize import AREA_UNIT, collapse, key
from inspector_ml.extract.tables import PageCell, anchors, bands, column_cells, named_row, page_cells

#: Заголовок экспликации: «Экспликация помещений 1-го этажа», «Сводная экспликация помещений».
EXPLICATION = re.compile(r"(?:сводн\w*\s+)?экспликаци\w*\s+помещени\w*", re.IGNORECASE)
#: Якорь матрицы, который описывает экспликацию, а не строку ТЭП (см. `_total_anchors`).
EXPLICATION_ANCHOR = re.compile(r"экспликаци|итого", re.IGNORECASE)
#: Номер помещения: «-3.1», «1.09» (этаж и номер) или «012», «140» (сквозная нумерация).
#:
#: Однозначные и двузначные номера без разделителя намеренно не считаются номерами помещений.
#: На листах планировок квартир стоят поквартирные экспликации, где помещения пронумерованы
#: с единицы внутри каждой квартиры: такой «пом. 1» встречается на листе десятки раз и в разных
#: квартирах означает разное — как контрольная точка он бессмыслен. Обе разметки организаторов
#: (ALT79B «1.09» и Тюменская «012») используют как раз полные номера.
ROOM_NUMBER = re.compile(r"^(?:[-−–]?\d{1,3}[.,\-/]\d{1,3}|\d{3})[а-яa-z]?$", re.IGNORECASE)
#: Номер, слипшийся с наименованием: «-3.14 Склад» — в узкой колонке зазор между ними пропадает.
ROOM_NUMBER_PREFIX = re.compile(r"^((?:[-−–]?\d{1,3}[.,\-/]\d{1,3}|\d{3})[а-яa-z]?)\s+(\D.*)$", re.IGNORECASE)
#: Доля числовых ячеек, по которой колонку признают колонкой площадей.
COLUMN_SHARE = 0.5
#: Для колонки номеров порог ниже: в ней же стоят шапка таблицы и подзаголовки разделов
#: («Автостоянка», «МОП», «Технические помещения»), и на коротких экспликациях они
#: составляли больше половины ячеек. Лишние кандидаты отсеются проверками ниже.
NUMBER_COLUMN_SHARE = 0.3
#: Минимум строк в экспликации — иначе это случайное совпадение на чертеже.
MIN_ROOMS = 3
#: Насколько далеко (в долях листа) таблица может отстоять от своего заголовка.
TITLE_DISTANCE = 0.1
#: Доля номеров с общим префиксом этажа, при которой колонка признаётся колонкой номеров.
FLOOR_SHARE = 0.6
#: Этаж в номере помещения: «-3.1» → «-3», «1.09» → «1». Знак минуса входит в этаж, а не
#: в разделитель, иначе у подземных этажей префикс получался бы пустым.
NUMBER_FLOOR = re.compile(r"^([-−–]?\d{1,3})[.,\-/]\d")
#: Этаж в заголовке экспликации: «Экспликация помещений -3-го этажа».
TITLE_FLOOR = re.compile(r"([-−–]?\d{1,2})\s*[-–]?\s*го\s+этажа", re.IGNORECASE)


def extract(param: MatrixParam, pages: list[dict[str, Any]]) -> list[Found]:
    """Все точки M-002 в документе."""
    total = _total_anchors(param)
    found: list[Found] = []
    for page in pages:
        cells = page_cells(page)
        found.extend(_building_area(page, cells, total))
        found.extend(_explications(page, cells))
    return _dedupe(found)


def _total_anchors(param: MatrixParam) -> tuple[str, ...]:
    """Якоря строки ТЭП: всё из матрицы, кроме примет самой экспликации.

    В `semantic_anchors` M-002 лежат якоря двух разных видов точек: наименования строки ТЭП
    («Общая площадь здания», «Площадь жилого здания») и приметы таблицы экспликации
    («Экспликация помещений», «Итого по этажу»). Вторые обслуживает своя ветка — заголовок
    находится регуляркой, а итог этажа берётся по положению под таблицей. Если отдать их сюда,
    итог этажа уедет **вторым** значением в точку «Общая площадь здания», и на каждом листе
    экспликаций появится лишняя контрольная точка с чужим значением.
    """
    return tuple(a for a in anchors(param.semantic_anchors) if not EXPLICATION_ANCHOR.search(a))


def _dedupe(found: list[Found]) -> list[Found]:
    """Одна точка на страницу: заголовок экспликации иногда разбит на несколько блоков."""
    seen: set[tuple[int, str | None, object]] = set()
    unique: list[Found] = []
    for item in found:
        mark = (item.page, item.rule_key, item.value)
        if mark not in seen:
            seen.add(mark)
            unique.append(item)
    return unique


def _building_area(page: dict[str, Any], cells: list[PageCell], names: tuple[str, ...]) -> list[Found]:
    """Строка ТЭП с общей площадью здания."""
    row = named_row(cells, names)
    if row is None:
        return []
    name, value = row
    return [
        Found(
            rule_key="Общая площадь здания",
            raw_value=value.text,
            value=value.value,
            page=page["page"],
            bbox=value.bbox,
            snippet=f"{name.text} — {value.text}",
            unit=AREA_UNIT,
        )
    ]


def _explications(page: dict[str, Any], cells: list[PageCell]) -> list[Found]:
    """Экспликации помещений страницы: строки помещений и итог по этажу."""
    found: list[Found] = []
    for title in _titles(page):
        table = _table_below(page, title)
        if table is None:
            continue
        floor = _floor(title["text"])
        rooms = _rooms(page, cells, table, floor=floor)
        if len(rooms) < MIN_ROOMS:
            continue
        found.extend(_room_values(page, rooms))
        total = _floor_total(page, cells, table, rooms)
        if total is not None:
            key_text = f"Экспликация помещений {floor}-го этажа" if floor else collapse(title["text"])
            found.append(
                Found(
                    rule_key=key_text,
                    raw_value=total.text,
                    value=total.value,
                    page=page["page"],
                    bbox=total.bbox,
                    snippet=f"{key_text} — итог {total.text}",
                    unit=AREA_UNIT,
                )
            )
    return found


def _titles(page: dict[str, Any]) -> list[dict[str, Any]]:
    """Заголовки экспликаций на странице. Один лист АР несёт их до трёх («Корпус 1», «Корпус 2»)."""
    return [b for b in page.get("blocks") or [] if EXPLICATION.search(collapse(b["text"]))]


def _table_below(page: dict[str, Any], title: dict[str, Any]) -> dict[str, Any] | None:
    """Ближайшая таблица под заголовком: заголовок стоит над своей таблицей, а не рядом с ней."""
    center = (title["bbox"][0] + title["bbox"][2]) / 2
    candidates = [
        table
        for table in page.get("tables") or []
        if table["bbox"][3] > title["bbox"][1]
        and table["bbox"][0] <= center <= table["bbox"][2]
        and table["bbox"][1] - title["bbox"][3] <= TITLE_DISTANCE
    ]
    return min(candidates, key=lambda t: t["bbox"][1]) if candidates else None


def _floor(title: str) -> str | None:
    """Этаж из заголовка экспликации: «-3-го этажа» → `-3`. У сводных экспликаций этажа нет."""
    match = TITLE_FLOOR.search(collapse(title))
    return match.group(1) if match else None


def _rooms(
    page: dict[str, Any], cells: list[PageCell], table: dict[str, Any], *, floor: str | None = None
) -> list[tuple[PageCell, str, str]]:
    """Строки помещений таблицы: `(ячейка площади, номер, наименование)`.

    Пара колонок «номер + площадь» выбирается по числу полных строк, а не по положению слева.
    На листе САПР в таблицу попадают и колонки подписей чертежа: отметки уровней («-13,600»)
    выглядят как номера помещений, а размеры — как площади. Настоящая пара отличается тем,
    что заполнена в двух десятках строк подряд, а случайная — в трёх-четырёх.
    """
    inside = [c for c in cells if c.table_id == table["id"]]
    columns = sorted({c.col for c in inside})
    best: list[tuple[PageCell, str, str]] = []
    for numbers in columns:
        if not _mostly(inside, table, numbers, lambda c: _split(c.text)[0] is not None, NUMBER_COLUMN_SHARE):
            continue
        for areas in (c for c in columns if c > numbers):
            if not _mostly(inside, table, areas, _looks_like_area):
                continue
            rows = _pairs(inside, numbers, areas)
            if not _one_floor((row[1] for row in rows), floor):
                continue
            named = [row for row in rows if row[2]]
            # у настоящей экспликации наименование есть почти в каждой строке; если его нет,
            # значит колонками «номер» и «площадь» оказались две колонки чисел с чертежа
            if len(named) >= COLUMN_SHARE * len(rows) and len(rows) > len(best):
                best = rows
    return best


def _pairs(inside: list[PageCell], numbers: int, areas: int) -> list[tuple[PageCell, str, str]]:
    """Строки, где заполнены обе колонки: номер помещения и его площадь.

    В одну полосу иногда попадают **две** соседние строки экспликации: полоса растёт от первой
    ячейки, а ею бывает высокая подпись с чертежа, перекрывающая обе строки. Поэтому берём не
    «первый номер полосы», а каждый номер, и подбираем к нему площадь и наименование по
    вертикальной близости — так строка не теряется.
    """
    rows: list[tuple[PageCell, str, str]] = []
    for band in bands(inside):
        for number_cell in (c for c in band if c.col == numbers):
            room, name = _split(number_cell.text)
            if room is None:
                continue
            area_cell = _nearest((c for c in band if c.col == areas and c.value is not None), number_cell)
            if area_cell is None:
                continue
            if not name:
                # всё, что стоит между номером и площадью, — наименование; отбирать по «не число»
                # нельзя: «Лестничная клетка ЛК3» с точки зрения парсера чисел содержит число
                between = (c for c in band if numbers < c.col < areas)
                name = " ".join(c.text for c in between if _same_row(c, number_cell))
            rows.append((area_cell, room, name.strip()))
    return rows


def _nearest(cells: Iterable[PageCell], reference: PageCell) -> PageCell | None:
    """Ближайшая по вертикали ячейка той же строки."""
    candidates = [c for c in cells if _same_row(c, reference)]
    return min(candidates, key=lambda c: abs(_middle(c) - _middle(reference))) if candidates else None


def _same_row(cell: PageCell, reference: PageCell) -> bool:
    """Ячейки стоят на одной высоте: середины расходятся меньше чем на полстроки."""
    height = max(reference.bottom - reference.top, cell.bottom - cell.top, 1e-6)
    return abs(_middle(cell) - _middle(reference)) <= 0.5 * height


def _middle(cell: PageCell) -> float:
    return (cell.top + cell.bottom) / 2


def _looks_like_area(cell: PageCell) -> bool:
    """Площадь помещения записывается с десятой долей: «840,7», «4,9».

    Целые числа в той же колонке — это размеры в миллиметрах с плана («2340», «3400»), и без
    этой проверки колонка размеров принималась за колонку площадей.
    """
    return cell.value is not None and cell.value != int(cell.value)


def _one_floor(numbers: Iterable[str], floor: str | None = None) -> bool:
    """Номера относятся к этажу из заголовка: «Экспликация помещений -3-го этажа» → «-3.1 … -3.16».

    Это отсекает главную ложную пару на листах планировок: площади вида «5,5» и «12,5» по форме
    неотличимы от номеров «этаж.номер», и колонка площадей одной квартиры принималась за колонку
    номеров соседней. Настоящие номера начинаются с того же этажа, что назван в заголовке.
    """
    prefixes = [m.group(1) for m in map(NUMBER_FLOOR.match, numbers) if m]
    if not prefixes:  # сквозная нумерация «012», «140» — префикса нет и проверять нечего
        return True
    common, count = Counter(prefixes).most_common(1)[0]
    if count < FLOOR_SHARE * len(prefixes):
        return False
    return floor is None or common.lstrip("0") == floor.lstrip("0") or common == floor


def _split(text: str) -> tuple[str | None, str]:
    """Разделить «-3.14 Склад» на номер и наименование; из «-3.14» вернуть только номер."""
    if ROOM_NUMBER.match(text):
        return text, ""
    merged = ROOM_NUMBER_PREFIX.match(text)
    return (merged.group(1), merged.group(2)) if merged else (None, "")


def _mostly(
    inside: list[PageCell],
    table: dict[str, Any],
    column: int,
    predicate: Callable[[PageCell], bool],
    share: float = COLUMN_SHARE,
) -> bool:
    """Достаточная доля ячеек колонки удовлетворяет условию (и таких ячеек хватает на экспликацию)."""
    cells = column_cells(inside, table["id"], column)
    hits = sum(1 for c in cells if predicate(c))
    return hits >= MIN_ROOMS and hits >= share * len(cells)


def _room_values(page: dict[str, Any], rooms: list[tuple[PageCell, str, str]]) -> list[Found]:
    found: list[Found] = []
    for area, room, name in rooms:
        found.append(
            Found(
                rule_key=f"пом. {room}",
                raw_value=area.text,
                value=area.value,
                page=page["page"],
                bbox=area.bbox,
                snippet=f"{room} {name} — {area.text}".strip(),
                unit=AREA_UNIT,
            )
        )
        if name:
            found.append(
                Found(
                    rule_key=f"пом. {room} (назначение)",
                    raw_value=name,
                    value=key(name),
                    page=page["page"],
                    bbox=area.bbox,
                    snippet=f"{room} {name}",
                )
            )
    return found


def _floor_total(
    page: dict[str, Any], cells: list[PageCell], table: dict[str, Any], rooms: list[tuple[PageCell, str, str]]
) -> PageCell | None:
    """Итог по этажу — последняя сумма в колонке площадей, стоящая ниже всех строк помещений.

    Между строками экспликации идут промежуточные итоги разделов («Автостоянка», «МОП»), а под
    таблицей — итог этажа. Берём последний: он и есть итог, промежуточные остаются выше.
    """
    column = rooms[0][0].col
    last_room = max(area.bottom for area, _room, _name in rooms)
    inside = [c for c in cells if c.table_id == table["id"] and c.col == column]
    orphans = [c for c in inside if c.top >= last_room and c.value is not None]
    return orphans[-1] if orphans else None
