"""Поток текста без геометрии → страницы разобранного документа (DOCX и XML).

У PDF геометрия есть: блок текста лежит на странице там, где его нарисовал САПР. У DOCX и XML её нет —
документ Word раскладывает текст сам при печати, XML вообще не имеет страниц. Извлечению при этом нужны
те же страницы, что у PDF: блоки текста для шаблонов матрицы и таблицы с ячейками для якорей
(`extract/tables.named_row` группирует ячейки в строки по высоте). Поэтому текст раскладывается по
условным страницам A4 в порядке документа: абзац — блок на своей высоте, строка таблицы — ячейки на одной
высоте, колонки — равными долями ширины. Доказательство указывает на такую страницу и фрагмент текста,
а не на место на печатном листе, — это честно, другого места у DOCX и XML нет.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

#: A4 в пунктах — чтобы страницы DOCX и XML не выделялись среди страниц PDF.
PAGE_WIDTH_PT, PAGE_HEIGHT_PT = 595.28, 841.89
MARGIN_X, MARGIN_Y = 0.08, 0.06
LINES_PER_PAGE = 50
#: Символов в строке на всю ширину — чтобы длинный абзац занимал несколько строк, а не одну.
CHARS_PER_LINE = 100
LINE = (1 - 2 * MARGIN_Y) / LINES_PER_PAGE


@dataclass
class _Page:
    number: int
    blocks: list[dict[str, Any]] = field(default_factory=list)
    tables: list[dict[str, Any]] = field(default_factory=list)
    line: int = 0


@dataclass
class Flow:
    """Раскладка потока абзацев и таблиц по условным страницам."""

    source: str  # «DOCX» или «XML» — источник текста в контракте (`TextSource`)
    pages: list[_Page] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.pages.append(_Page(1))

    @property
    def _page(self) -> _Page:
        return self.pages[-1]

    def new_page(self) -> None:
        if self._page.blocks or self._page.tables:
            self.pages.append(_Page(len(self.pages) + 1))

    def _room(self, lines: int) -> None:
        if self._page.line + lines > LINES_PER_PAGE and self._page.line > 0:
            self.new_page()

    def _y(self, lines: int) -> tuple[float, float]:
        top = MARGIN_Y + self._page.line * LINE
        self._page.line += lines
        return round(top, 4), round(top + lines * LINE, 4)

    def text(self, text: str, *, kind: str = "text") -> None:
        """Абзац — один блок; длинный занимает несколько строк страницы."""
        text = text.strip()
        if not text:
            return
        lines = min(max(1, -(-len(text) // CHARS_PER_LINE)), LINES_PER_PAGE)
        self._room(lines)
        top, bottom = self._y(lines)
        page = self._page
        page.blocks.append(
            {
                "id": f"p{page.number}-b{len(page.blocks)}",
                "type": kind,
                "text": text,
                "bbox": [MARGIN_X, top, 1 - MARGIN_X, bottom],
            }
        )

    def table(self, rows: list[list[str]], *, sep: str = " ") -> None:
        """Таблица: ячейки строки на одной высоте, колонки равными долями ширины.

        Строка таблицы идёт ещё и блоком текста («Общая площадь здания м² 3009,4»): шаблоны матрицы
        работают по блокам, якоря — по ячейкам, и значение должно находиться обоими путями, как в PDF.
        Таблица, не поместившаяся на страницу, продолжается на следующей отдельной таблицей.
        """
        rows = [row for row in rows if any(cell.strip() for cell in row)]
        if not rows:
            return
        columns = max(len(row) for row in rows)
        width = (1 - 2 * MARGIN_X) / columns
        current: dict[str, Any] | None = None
        row_number = 0
        for row in rows:
            lines = max(1, max(-(-len(cell) // max(CHARS_PER_LINE // columns, 1)) for cell in row))
            lines = min(lines, 4)
            if current is None or self._page.line + lines > LINES_PER_PAGE:
                if current is not None:
                    self.new_page()
                page = self._page
                current = {
                    "id": f"p{page.number}-t{len(page.tables)}",
                    "bbox": [0, 0, 0, 0],
                    "header_rows": 1,
                    "cells": [],
                }
                page.tables.append(current)
                row_number = 0
            top, bottom = self._y(lines)
            for col, cell in enumerate(row):
                if cell.strip():
                    left = MARGIN_X + col * width
                    current["cells"].append(
                        {
                            "row": row_number,
                            "col": col,
                            "text": cell.strip(),
                            "bbox": [round(left, 4), top, round(left + width, 4), bottom],
                        }
                    )
            page = self._page
            page.blocks.append(
                {
                    "id": f"p{page.number}-b{len(page.blocks)}",
                    "type": "text",
                    "text": sep.join(c.strip() for c in row if c.strip()),
                    "bbox": [MARGIN_X, top, 1 - MARGIN_X, bottom],
                }
            )
            row_number += 1
            cells = current["cells"]
            if cells:
                current["bbox"] = [
                    min(c["bbox"][0] for c in cells), min(c["bbox"][1] for c in cells),
                    max(c["bbox"][2] for c in cells), max(c["bbox"][3] for c in cells),
                ]  # fmt: skip

    def result(self) -> list[dict[str, Any]]:
        """Страницы в форме `ParsedPage`, как у PDF."""
        return [
            {
                "page": page.number,
                "width_pt": PAGE_WIDTH_PT,
                "height_pt": PAGE_HEIGHT_PT,
                "rotation": 0,
                "source": self.source,
                "quality": "OK",
                "is_drawing": False,
                "blocks": page.blocks,
                "tables": [t for t in page.tables if t["cells"]],
            }
            for page in self.pages
            if page.blocks or page.tables
        ]
