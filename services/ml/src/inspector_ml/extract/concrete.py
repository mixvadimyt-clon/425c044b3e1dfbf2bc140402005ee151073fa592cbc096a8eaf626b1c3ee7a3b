"""M-055 «Класс прочности бетона монолитных конструкций».

Атомарная точка — конструкция или элемент («Фундаментная плита», «Стена в грунте»), значение —
класс бетона в каноническом виде `B25`. Сложность не в поиске марки: регулярка из матрицы ловит
её сразу. Сложность в том, **к чему** марка относится, а пишут это четырьмя разными способами —
все четыре встречаются в комплекте Новослободской:

1. **Список в общих данных.** «· фундаментная плита  B40 · пилоны, колонны, стены -3 по +1  В60»
   (ПД, КР2, стр. 49) — наименование и марка в одной строке, разными ячейками.
2. **Спецификация материалов.** Строка «ГОСТ 26633-2015 | B40,F150,W6, м3 | 1520» (РД, КЖ1.1.1,
   стр. 27) — в самой строке конструкции нет, она в заголовке спецификации над таблицей:
   «Спецификация материалов на ж/б фундаментную плиту на отм. -13.750».
3. **Сплошной текст.** «в конструкциях ограждения котлована в виде монолитной ж/б «стены в
   грунте» (бетон класса В25 F200 W8 ГОСТ 26633-2015)» (ПД, КР1, стр. 17) — конструкция названа
   в том же предложении, в косвенном падеже.
4. **Общие указания РД.** «Класс бетона по прочности на сжатие для стен В60» (РД, КЖ1.1.2, стр. 4).
5. **Акт освидетельствования (ИД).** Конструкция названа в шапке акта («Устройство стены в грунте»),
   а марка — в реестре приложений через несколько страниц: «документ о качестве партии БСТ В25»
   (ИД, АОСР №1А-БСС, стр. 2 и 5). Один файл ИД держит несколько актов подряд, поэтому конструкция
   переносится только на ближайшие страницы и только там, где своей конструкции на странице нет.
   **И только внутри акта** — на страницах после шапки «АКТ освидетельствования»: в томах ПД и
   РД конструкция, упомянутая где-то на странице, чужой марке не хозяйка. Шапку ищем на каждой
   странице, а не на первой: файл ИД бывает сшивкой десятков актов по этажу. Замер 25.09 на обучающих
   объектах: перенос давал там 21 документ ПД и 9 РД, и выборка — сплошь чужие привязки («…кроме
   фундаментной плиты выполнены из бетона класса В60» → плита B60, «покрытие пола — бетон В15» →
   стены подвала). В ИД после ограничения остались все 34 документа и 81 точка.

Поэтому поиск идёт от марки к её окружению: сначала своя строка, потом заголовок над таблицей,
потом текст блока. Если конструкцию узнать не удалось, значение **не выдаётся с пустым ключом**:
движок сравнения сложил бы такие значения в одну контрольную точку и выдал ложное расхождение.
"""

from __future__ import annotations

import re
from typing import Any

from inspector_ml.contracts.events import MatrixParam
from inspector_ml.extract.base import Found
from inspector_ml.extract.lexicon import element
from inspector_ml.extract.normalize import collapse, concrete_class
from inspector_ml.extract.tables import PageCell, bands, page_cells
from inspector_ml.layout.title_block import page_text

UNIT = "Марка (B)"
#: Заголовок спецификации, задающий конструкцию для всей таблицы под ним.
SPECIFICATION = re.compile(r"специфика\w*\s+(?:материал\w*|элемент\w*)", re.IGNORECASE)
#: Марка бетона как она написана в документе — для `raw_value` и для обхода блока текста.
#: Правило пробела то же, что в `normalize._CONCRETE`: у строчной «в» пробела быть не может,
#: иначе предлог «в 50 м» выглядит как марка. Два места должны совпадать, иначе `raw_value`
#: разойдётся со значением.
GRADE = re.compile(r"(?:[BВ]\s?|[bв])\d{1,2}(?:[.,]5)?(?!\d)")
#: Сколько символов текста до марки просматриваем в сплошном тексте.
CONTEXT_CHARS = 220
#: Сколько ячеек слева от марки считаем её подписью.
NEIGHBOUR_CELLS = 4
#: На сколько страниц вперёд действует конструкция, названная в шапке акта ИД.
CONTEXT_PAGES = 4
#: Шапка акта освидетельствования (АОСР, АООК) — только после неё конструкция переносится на
#: соседние страницы. Заглавное «АКТ» (в скане — и латиницей): строчное «с составлением акта
#: освидетельствования» пишут в томах ПОС, и это не акт.
ACT = re.compile(r"[АA][КK][ТT]\s+(?:№\s*\S+\s+)?освидетельствования")


def extract(param: MatrixParam, pages: list[dict[str, Any]]) -> list[Found]:
    """Все точки M-055 в документе.

    `param` здесь не используется: марка приводится к списку классов ГОСТ 26633
    (`normalize.concrete_class`), а наименование конструкции матрица не описывает. Аргумент
    есть ради единого интерфейса извлекателей — его требует [api.py](api.py).
    """
    found: list[Found] = []
    context: tuple[int, str] | None = None
    in_act = False
    for page in pages:
        in_act = in_act or ACT.search(page_text(page)) is not None
        cells = page_cells(page)
        page_found = _from_tables(page, cells) + _from_blocks(page)
        named = _page_element(page) if in_act else None
        if named is not None:
            context = (page["page"], named)
        if not page_found and context is not None and page["page"] - context[0] <= CONTEXT_PAGES:
            page_found = _from_context(page, cells, context[1])
        found.extend(page_found)
    return _dedupe(found)


def _page_element(page: dict[str, Any]) -> str | None:
    """Конструкция, названная где-либо на странице, — контекст для соседних страниц акта ИД."""
    for block in page.get("blocks") or []:
        name = element(block["text"])
        if name is not None:
            return name
    return None


def _from_context(page: dict[str, Any], cells: list[PageCell], name: str) -> list[Found]:
    """Марки страницы, у которой своей конструкции нет, — на конструкцию из шапки акта.

    Смотрим и ячейки, и блоки: реестр приложений к акту бывает и таблицей, и простым текстом.
    """
    places: list[tuple[str, list[float]]] = [(c.text, c.bbox) for c in cells]
    places += [(b["text"], b["bbox"]) for b in page.get("blocks") or [] if b.get("type") != "title_block"]

    found: list[Found] = []
    for text, bbox in places:
        grade = concrete_class(text)
        if grade is not None:
            found.append(
                Found(
                    rule_key=name,
                    raw_value=_raw(text),
                    value=grade,
                    page=page["page"],
                    bbox=bbox,
                    snippet=collapse(text)[:200],
                    unit=UNIT,
                    method="context",
                )
            )
    return found


def _from_tables(page: dict[str, Any], cells: list[PageCell]) -> list[Found]:
    """Марки в таблицах: конструкцию берём из своей строки, иначе из заголовка спецификации."""
    titles = _specification_titles(page)
    found: list[Found] = []
    for band in bands(cells):
        for cell in band:
            grade = concrete_class(cell.text)
            if grade is None:
                continue
            name = element(cell.text) or _in_band(band, cell) or _title_above(titles, cell)
            if name is None:
                continue
            found.append(
                Found(
                    rule_key=name,
                    raw_value=_raw(cell.text),
                    value=grade,
                    page=page["page"],
                    bbox=cell.bbox,
                    snippet=" ".join(c.text for c in band)[:200],
                    unit=UNIT,
                    method="table",
                )
            )
    return found


def _raw(text: str) -> str:
    """Марка как в документе: в ячейке рядом стоят морозостойкость и водонепроницаемость."""
    match = GRADE.search(text)
    return match.group() if match else text


def _in_band(band: list[PageCell], cell: PageCell) -> str | None:
    """Конструкция, названная в той же строке левее марки.

    Смотрим только несколько ближайших ячеек: на листе КЖ в одной горизонтальной полосе лежат
    строки четырёх панелей спецификации, и «вся строка левее» притянула бы чужую конструкцию.
    """
    left = [c.text for c in band if c.left < cell.left][-NEIGHBOUR_CELLS:]
    return element(" ".join(left)) if left else None


def _specification_titles(page: dict[str, Any]) -> list[dict[str, Any]]:
    return [b for b in page.get("blocks") or [] if SPECIFICATION.search(b["text"])]


def _title_above(titles: list[dict[str, Any]], cell: PageCell) -> str | None:
    """Конструкция из ближайшего заголовка спецификации над ячейкой и в её колонке."""
    above = [
        title
        for title in titles
        if title["bbox"][3] <= cell.bottom
        and title["bbox"][0] <= cell.bbox[2]
        and title["bbox"][2] >= cell.bbox[0]
        and element(title["text"]) is not None
    ]
    if not above:
        return None
    return element(max(above, key=lambda t: t["bbox"][3])["text"])


def _from_blocks(page: dict[str, Any]) -> list[Found]:
    """Марки в сплошном тексте: конструкция ищется в тексте перед маркой."""
    found: list[Found] = []
    for block in page.get("blocks") or []:
        if block.get("type") == "title_block":
            continue
        text = collapse(block["text"])
        for match in GRADE.finditer(text):
            grade = concrete_class(match.group())
            if grade is None:
                continue
            name = element(text[max(0, match.start() - CONTEXT_CHARS) : match.start()])
            if name is None:
                continue
            found.append(
                Found(
                    rule_key=name,
                    raw_value=match.group(),
                    value=grade,
                    page=page["page"],
                    bbox=block["bbox"],
                    snippet=text[max(0, match.start() - 120) : match.end() + 40],
                    unit=UNIT,
                    method="regex",
                )
            )
    return found


def _dedupe(found: list[Found]) -> list[Found]:
    """Одна пара «конструкция + класс» на страницу: в списке общих данных марка повторяется по этажам."""
    seen: set[tuple[int, str | None, object]] = set()
    unique: list[Found] = []
    for item in found:
        mark = (item.page, item.rule_key, item.value)
        if mark not in seen:
            seen.add(mark)
            unique.append(item)
    return unique
