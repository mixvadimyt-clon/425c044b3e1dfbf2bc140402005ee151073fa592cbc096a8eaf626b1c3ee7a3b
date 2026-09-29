"""Восстановление строк и таблиц по геометрии слов.

Значения параметров живут в таблицах: ТЭП в пояснительной записке, экспликации помещений на
листах АР, спецификации материалов в КЖ. Блоки PyMuPDF для них не годятся — один блок склеивает
несколько строк таблицы («-3.1 Автостоянка 840,7 / -3.2 Тамбур-шлюз 4,9 …») и теряет координаты
ячеек, а именно ячейка нужна как доказательство.

Поэтому строки собираются из слов (`page.get_text("words")`): слова с перекрывающимися
вертикальными отрезками — одна строка, большой горизонтальный зазор внутри строки — граница
ячейки. Дальше подряд идущие строки с совпадающими левыми краями ячеек объединяются в таблицу.

**Почему не `page.find_tables()`.** Замеры на корпусе: на листе АР формата A1 (1684 × 1190 pt)
вызов занимает **2.7 с** и возвращает одну таблицу на весь лист — линии чертежа он принимает за
разлиновку, а строки экспликации склеивает ровно так же, как блоки. На текстовой A4 он работает
(236 мс) и разбирает ТЭП верно, но ради одного формата держать второй путь незачем.
Сборка по словам стоит 2–26 мс на страницу — столько же, сколько чтение блоков.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pymupdf

from inspector_ml.geometry import Box, normalize_bbox

#: Доля высоты строки: горизонтальный зазор больше — это граница ячейки, а не пробел.
CELL_GAP_RATIO = 0.55
#: Минимальный зазор в пунктах — на мелком шрифте чертежей доля высоты слишком строга.
CELL_GAP_MIN_PT = 4.0
#: Доля высоты слова: вертикальное перекрытие больше — слова в одной строке.
LINE_OVERLAP_RATIO = 0.4
#: Допуск совпадения левых краёв ячеек соседних строк, в долях ширины страницы.
COLUMN_TOLERANCE = 0.012
#: Сколько строк подряд должно держать колонки, чтобы считать это таблицей.
MIN_TABLE_ROWS = 3
#: Предохранитель от разлиновки чертежей: больше таблиц на листе не бывает.
MAX_TABLES_PER_PAGE = 24
#: Предохранитель по размеру: очень широкие «таблицы» — это разметка чертежа, а не данные.
#: Запас большой намеренно: на листе КЖ рядом стоят четыре панели одной спецификации, и все
#: вместе они дают под тридцать колонок. Разделять их не нужно — извлечение работает по
#: координатам ячеек, а заголовок спецификации привязан к своей панели по горизонтали.
MAX_TABLE_COLUMNS = 40
#: Доля типичной высоты ячейки: пропуск по вертикали больше — колонка кончилась.
#: В экспликации между строками попадаются пустые ячейки (подзаголовок раздела, итог),
#: поэтому запас нужен не в одну строку, а в три-четыре.
ROW_GAP_RATIO = 4.0
#: Доля построчных совпадений, при которой две серии ячеек считаются колонками одной таблицы.
RUN_OVERLAP_RATIO = 0.5


@dataclass(frozen=True)
class Cell:
    """Ячейка строки: слитые соседние слова и их общий bbox в системе видимой страницы."""

    text: str
    bbox: Box


@dataclass(frozen=True)
class Row:
    """Строка страницы: ячейки слева направо."""

    cells: list[Cell]
    top: float
    bottom: float

    @property
    def height(self) -> float:
        return self.bottom - self.top

    @property
    def text(self) -> str:
        return " ".join(cell.text for cell in self.cells)

    @property
    def bbox(self) -> Box:
        return (
            min(c.bbox[0] for c in self.cells),
            self.top,
            max(c.bbox[2] for c in self.cells),
            self.bottom,
        )


def page_rows(page: pymupdf.Page) -> list[Row]:
    """Строки страницы в видимой системе координат (с учётом поворота листа)."""
    to_visible = page.rotation_matrix
    words = []
    for x0, y0, x1, y1, text, *_rest in page.get_text("words"):
        text = text.strip()
        if not text:
            continue
        visible = pymupdf.Rect(x0, y0, x1, y1) * to_visible
        words.append((visible.x0, visible.y0, visible.x1, visible.y1, text))
    return rows_from_words(words)


def rows_from_blocks(blocks: list[dict[str, Any]], page_box: Box) -> list[Row]:
    """Строки из готовых блоков с нормализованным bbox — путь для распознанных страниц.

    У скана слов нет: текстового слоя на странице не было, и после OCR остаются строки,
    найденные детектором. Внутри таблицы он режет по ячейкам, поэтому распознанная строка
    ведёт себя здесь как слово, и дальше работает та же сборка, что и для текстового слоя.

    Координаты блока нормализованы по листу, а пороги сборки заданы в пунктах
    (`CELL_GAP_MIN_PT`), поэтому bbox возвращается в пункты.
    """
    x0, y0, x1, y1 = page_box
    width, height = x1 - x0, y1 - y0
    words = []
    for block in blocks:
        text = (block.get("text") or "").strip()
        if not text:
            continue
        bx0, by0, bx1, by1 = block["bbox"]
        words.append((x0 + bx0 * width, y0 + by0 * height, x0 + bx1 * width, y0 + by1 * height, text))
    return rows_from_words(words)


def rows_from_words(words: list[tuple[float, float, float, float, str]]) -> list[Row]:
    """Собрать строки из слов `(x0, y0, x1, y1, text)`."""
    lines: list[list[tuple[float, float, float, float, str]]] = []
    for word in sorted(words, key=lambda w: (w[1], w[0])):
        for line in reversed(lines):
            if _same_line(line, word):
                line.append(word)
                break
        else:
            lines.append([word])

    rows = [_row(line) for line in lines]
    rows.sort(key=lambda r: (r.top, r.bbox[0]))
    return rows


def _same_line(line: list[tuple[float, float, float, float, str]], word: tuple[Any, ...]) -> bool:
    """Слово попадает в строку, если его вертикальный отрезок перекрывается с **первым** словом строки.

    Сравнивать с накопленным отрезком нельзя: на листе САПР строка разрасталась бы по цепочке
    (каждое следующее слово чуть ниже предыдущего) и в итоге собрала бы полстраницы.
    """
    top, bottom = line[0][1], line[0][3]
    overlap = min(bottom, word[3]) - max(top, word[1])
    smaller = min(bottom - top, word[3] - word[1])
    return smaller > 0 and overlap >= LINE_OVERLAP_RATIO * smaller


def _row(line: list[tuple[float, float, float, float, str]]) -> Row:
    line = sorted(line, key=lambda w: w[0])
    height = max(w[3] - w[1] for w in line)
    threshold = max(CELL_GAP_RATIO * height, CELL_GAP_MIN_PT)

    cells: list[Cell] = []
    chunk = [line[0]]
    for word in line[1:]:
        if word[0] - max(w[2] for w in chunk) > threshold:
            cells.append(_cell(chunk))
            chunk = []
        chunk.append(word)
    cells.append(_cell(chunk))
    return Row(cells=cells, top=min(w[1] for w in line), bottom=max(w[3] for w in line))


def _cell(chunk: list[tuple[float, float, float, float, str]]) -> Cell:
    return Cell(
        text=" ".join(w[4] for w in chunk),
        bbox=(
            min(w[0] for w in chunk),
            min(w[1] for w in chunk),
            max(w[2] for w in chunk),
            max(w[3] for w in chunk),
        ),
    )


class _Column:
    """Растущая сверху вниз колонка: помнит свой левый край и типичную высоту ячейки.

    Разрыв меряется по **своей** высоте, а не по высоте очередной ячейки страницы: рядом на листе
    всегда есть мелкие подписи, и по ним колонка закрывалась бы на середине таблицы.
    """

    def __init__(self, cell: Cell) -> None:
        self.cells = [cell]
        self._height = cell.bbox[3] - cell.bbox[1]

    def add(self, cell: Cell) -> None:
        self.cells.append(cell)
        self._height += (cell.bbox[3] - cell.bbox[1] - self._height) / len(self.cells)

    @property
    def left(self) -> float:
        return self.cells[-1].bbox[0]

    @property
    def bottom(self) -> float:
        return self.cells[-1].bbox[3]

    @property
    def gap_limit(self) -> float:
        return ROW_GAP_RATIO * max(self._height, 1.0)


def tables(rows: list[Row], page_box: Box, *, page_number: int) -> list[dict[str, Any]]:
    """Таблицы страницы → `ParsedTable` контракта (bbox нормализованы).

    Таблица ищется **от колонок, а не от строк**. Строка на листе САПР идёт через весь лист и
    собирает и ячейки экспликации, и подписи чертежа, а между двумя строками таблицы почти всегда
    вклинивается строка с размерами — по строкам таблица распадается на куски. Зато колонка
    видна сразу: полтора десятка ячеек с одинаковым левым краем и ровным шагом по вертикали.
    Одиночная подпись в такую колонку не попадает, поэтому чертёж отсеивается сам.

    Порядок: ячейки → колонки (по левому краю) → вертикальные серии внутри колонки → соседние
    серии с общим диапазоном y объединяются в таблицу → строки нумеруются по полосам y.

    Заголовок таблицы (`title`) не угадываем: на листах САПР подпись стоит отдельной строкой над
    таблицей, и её ищет уже извлечение — по якорям параметра.
    """
    width = max(page_box[2] - page_box[0], 1.0)
    tolerance = COLUMN_TOLERANCE * width
    runs = _columns(rows, tolerance)
    runs.sort(key=lambda r: (r[0].bbox[0], r[0].bbox[1]))

    result: list[dict[str, Any]] = []
    for group in _adjacent(runs):
        if len(group) < 2 or len(group) > MAX_TABLE_COLUMNS:
            continue
        table = _table(group, page_box, page_number, len(result))
        if table is not None:
            result.append(table)
        if len(result) >= MAX_TABLES_PER_PAGE:
            break
    return result


def _columns(rows: list[Row], tolerance: float) -> list[list[Cell]]:
    """Вертикальные серии ячеек с общим левым краем — колонки-кандидаты.

    Колонки растут сверху вниз, а не собираются глобальной кластеризацией левых краёв: на листе
    формата A1 краёв ячеек сотни, и при глобальной группировке одна колонка экспликации рвалась
    пополам — номера из четырёх («-3.1») и из пяти («-3.14») знаков попадали в разные кластеры.
    Локальный рост такой чувствительности не имеет: серия помнит свой край и ждёт продолжения.
    """
    open_columns: list[_Column] = []
    closed: list[_Column] = []
    for cell in sorted((cell for row in rows for cell in row.cells), key=lambda c: (c.bbox[1], c.bbox[0])):
        still_open: list[_Column] = []
        best: tuple[float, _Column] | None = None
        for column in open_columns:
            if cell.bbox[1] - column.bottom > column.gap_limit:
                closed.append(column)
                continue
            still_open.append(column)
            distance = abs(cell.bbox[0] - column.left)
            if distance <= tolerance and (best is None or distance < best[0]):
                best = (distance, column)
        open_columns = still_open
        if best is None:
            open_columns.append(_Column(cell))
        else:
            best[1].add(cell)

    return [column.cells for column in closed + open_columns if len(column.cells) >= MIN_TABLE_ROWS]


def _adjacent(runs: list[list[Cell]]) -> list[list[list[Cell]]]:
    """Колонки одной таблицы: каждая связывается с **ближайшей справа**, с которой совпадает построчно.

    Связывать «с любой подходящей» нельзя: на листе САПР у случайной колонки подписей всегда
    найдётся далёкий сосед с похожими высотами строк, и таблица разрасталась бы через весь лист.
    Ближайший сосед справа — то, чем колонки таблицы и отличаются от разрозненных подписей.
    """
    parent = list(range(len(runs)))

    def root(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    for index, run in enumerate(runs):
        for other in range(index + 1, len(runs)):
            if runs[other][0].bbox[0] <= run[0].bbox[0]:
                continue
            if _aligned(run, runs[other]) >= RUN_OVERLAP_RATIO:
                # объединяем, а не перезаписываем: на одну колонку справа могут ссылаться две
                # соседние слева, и при перезаписи таблица теряла бы колонку значений
                parent[root(other)] = root(index)
                break

    groups: dict[int, list[list[Cell]]] = {}
    for index in range(len(runs)):
        groups.setdefault(root(index), []).append(runs[index])
    return list(groups.values())


def _aligned(left: list[Cell], right: list[Cell]) -> float:
    """Доля ячеек короткой серии, у которых в другой серии есть ячейка на той же высоте.

    Пересечения диапазонов y мало: подписи на чертеже тянутся вдоль всего листа и перекрывают
    любую таблицу. А вот **построчного** совпадения у них нет — оно есть только у соседних
    колонок одной таблицы.
    """
    shorter = min(len(left), len(right))
    if shorter == 0:  # pragma: no cover — пустых серий не бывает
        return 0.0
    matched = sum(1 for cell in left if any(_same_band([other], cell) for other in right))
    return matched / shorter


def _table(group: list[list[Cell]], page_box: Box, page_number: int, index: int) -> dict[str, Any] | None:
    order = {id(run): position for position, run in enumerate(sorted(group, key=lambda r: r[0].bbox[0]))}
    placed = [(cell, order[id(run)]) for run in group for cell in run]
    lines = _lines([cell for cell, _ in placed])

    cells = [
        {
            "row": lines[id(cell)],
            "col": column,
            "text": cell.text,
            "bbox": normalize_bbox(cell.bbox, page_box),
        }
        for cell, column in placed
    ]
    box = (
        min(cell.bbox[0] for cell, _ in placed),
        min(cell.bbox[1] for cell, _ in placed),
        max(cell.bbox[2] for cell, _ in placed),
        max(cell.bbox[3] for cell, _ in placed),
    )
    return {
        "id": f"p{page_number}-t{index}",
        "bbox": normalize_bbox(box, page_box),
        "header_rows": 1,
        "cells": cells,
    }


def _lines(cells: list[Cell]) -> dict[int, int]:
    """Номер строки для каждой ячейки таблицы: ячейки на одной высоте — одна строка."""
    numbers: dict[int, int] = {}
    current: list[Cell] = []
    row = -1
    for cell in sorted(cells, key=lambda c: (c.bbox[1], c.bbox[0])):
        if current and _same_band(current, cell):
            current.append(cell)
        else:
            current = [cell]
            row += 1
        numbers[id(cell)] = row
    return numbers


def _same_band(band: list[Cell], cell: Cell) -> bool:
    top, bottom = band[0].bbox[1], band[0].bbox[3]
    overlap = min(bottom, cell.bbox[3]) - max(top, cell.bbox[1])
    smaller = min(bottom - top, cell.bbox[3] - cell.bbox[1])
    return smaller > 0 and overlap >= LINE_OVERLAP_RATIO * smaller
