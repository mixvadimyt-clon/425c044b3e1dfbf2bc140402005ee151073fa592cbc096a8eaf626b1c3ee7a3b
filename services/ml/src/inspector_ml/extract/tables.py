"""Работа с таблицами разобранной страницы.

Разбор складывает в `ParsedPage.tables` решётки ячеек с координатами
([layout/rows.py](../layout/rows.py)). Здесь — то, что нужно извлечению: ячейки страницы,
объединение их в строки, якоря наименований из матрицы и поиск значения справа от найденного
наименования.

**Почему строки собираются заново.** Одна таблица документа иногда распадается на две: в ТЭП
колонка «Наименование» и колонка «Показатель по ПД» разделены колонкой единиц, у которой ячейки
стоят не в каждой строке, и связь по вертикали рвётся. Но горизонтальная полоса на странице
остаётся одна, поэтому извлечение смотрит не «ячейка такой-то таблицы», а «ячейки на одной высоте
по всей странице» — и строка ТЭП собирается целиком независимо от того, как её нарезал детектор.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from inspector_ml.extract.lexicon import contains, words
from inspector_ml.extract.normalize import collapse, key, only_number


@dataclass(frozen=True)
class PageCell:
    """Ячейка таблицы на странице с нормализованным bbox."""

    text: str
    bbox: list[float]
    table_id: str
    row: int
    col: int

    @property
    def top(self) -> float:
        return self.bbox[1]

    @property
    def bottom(self) -> float:
        return self.bbox[3]

    @property
    def left(self) -> float:
        return self.bbox[0]

    @property
    def value(self) -> float | None:
        """Число, если ячейка — именно значение, а не подпись, норматив или дата.

        Подробности и цена ошибки — в `normalize.only_number`.
        """
        return only_number(self.text)


def page_cells(page: dict[str, Any]) -> list[PageCell]:
    """Все ячейки всех таблиц страницы."""
    return [
        PageCell(
            text=collapse(cell["text"]),
            bbox=cell["bbox"],
            table_id=table["id"],
            row=cell["row"],
            col=cell["col"],
        )
        for table in page.get("tables") or []
        for cell in table["cells"]
        if collapse(cell["text"])
    ]


def bands(cells: list[PageCell]) -> list[list[PageCell]]:
    """Ячейки, сгруппированные в горизонтальные полосы (строки страницы), слева направо."""
    result: list[list[PageCell]] = []
    for cell in sorted(cells, key=lambda c: (c.top, c.left)):
        if result and _overlaps(result[-1][0], cell):
            result[-1].append(cell)
        else:
            result.append([cell])
    return [sorted(band, key=lambda c: c.left) for band in result]


def _overlaps(first: PageCell, cell: PageCell) -> bool:
    overlap = min(first.bottom, cell.bottom) - max(first.top, cell.top)
    smaller = min(first.bottom - first.top, cell.bottom - cell.top)
    return smaller > 0 and overlap >= 0.4 * smaller


def anchors(values: Sequence[str] | str | None) -> tuple[str, ...]:
    """Якоря наименований из матрицы, приведённые к ключу сравнения (для `named_row`).

    В контракте `semantic_anchors` — массив строк, а в CSV матрицы они записаны через `|`
    (`docs/domain/matrix.md`). Принимаем оба вида: так офлайн-прогон по `data/matrix/params.csv`
    и запрос от api ищут по одним и тем же якорям.
    """
    parts = values.split("|") if isinstance(values, str) else list(values or ())
    return tuple(dict.fromkeys(name for name in map(key, parts) if name))


def named_row(
    cells: list[PageCell],
    names: tuple[str, ...],
    accept: Callable[[PageCell], bool] | None = None,
) -> tuple[PageCell, PageCell] | None:
    """Строка, наименование которой совпало с одним из якорей, и её значение.

    Значение — **самая правая** подходящая ячейка строки: в ТЭП левее стоят колонки «по ГПЗУ»
    (часто прочерк) и единицы измерения, а показатель проекта записан последним.

    Подходящая по умолчанию — числовая. Для перечислимых параметров это неверно: у «класса
    конструктивной пожарной опасности» значение «С0», а самым правым числом строки оказывалось
    «137.90» из соседней колонки (M-023 на замере находимости 24.09). Поэтому вызывающий может
    передать своё условие `accept`.
    """
    accept = accept or _numeric
    for band in bands(cells):
        for position, cell in enumerate(band):
            if not _matches(cell.text, names):
                continue
            values = [c for c in band[position + 1 :] if accept(c)]
            if values:
                return cell, values[-1]
    return None


def _numeric(cell: PageCell) -> bool:
    return cell.value is not None


def _matches(text: str, names: tuple[str, ...]) -> bool:
    """Наименование в ячейке совпало с якорем: дословно или в другой форме слов.

    Дословного вхождения мало: матрица задаёт якорь в именительном падеже («общая площадь
    здания»), а в документе строка стоит в косвенном («общей площади здания») или с лишним словом
    внутри («общая площадь жилого здания»). Формы слов сравниваются так же, как наименования
    конструкций (`lexicon.contains`): общее начало и падежное окончание, не больше одного лишнего
    слова между словами якоря.
    """
    normalized = key(text)
    return any(
        normalized.startswith(name) or (_name_like(text, name) and (name in normalized or contains(text, name)))
        for name in names
    )


#: Сколько слов сверх якоря может быть в ячейке-наименовании: «общая площадь **жилого** здания, **м2**».
EXTRA_NAME_WORDS = 4


def _name_like(text: str, name: str) -> bool:
    """Ячейка похожа на наименование строки, а не на фразу, в которой встретились слова якоря.

    Якорь в середине ячейки (дословно или в другой форме) засчитывается только в короткой ячейке;
    в длинной — только с начала. Замер 25.09: абзац «…учтена поправка на толщину конструкций
    дорожной одежды» находил строку «Конструкция дорожной одежды», а описание мебели «…поднимающие
    корзину на уровень руки. Вместимость от» — строку вместимости объекта.
    """
    return len(words(text)) <= len(words(name)) + EXTRA_NAME_WORDS


def column_cells(cells: list[PageCell], table_id: str, column: int) -> list[PageCell]:
    """Ячейки одной колонки одной таблицы, сверху вниз."""
    return sorted(
        (c for c in cells if c.table_id == table_id and c.col == column),
        key=lambda c: c.top,
    )
