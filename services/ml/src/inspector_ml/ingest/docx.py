"""Разбор DOCX (REQ-UPL-02): абзацы и таблицы Word → тот же разобранный документ, что у PDF.

Файл Word — zip с `word/document.xml`: тело из абзацев (`w:p`) и таблиц (`w:tbl`) в порядке документа.
Читаем стандартной библиотекой, без новых зависимостей в образе. Что берётся:

- **абзацы** — текст всех прогонов (`w:t`), табуляция — пробел, явный разрыв страницы («разрыв страницы»
  или «с новой страницы» в свойствах абзаца) — новая страница; абзацы и таблицы внутри элементов
  управления содержимым (`w:sdt`: титульный лист, оглавление) — как обычные;
- **таблицы** — строки и ячейки; объединённые по горизонтали ячейки (`w:gridSpan`) занимают свои
  колонки, чтобы номер колонки значения совпадал у всех строк: ТЭП «Наименование | ед. | значение»
  тогда находится по якорям матрицы так же, как в PDF;
- **колонтитулы** — в проектной документации в них стоит штамп (шифр, стадия, наименование), поэтому их
  текст идёт блоками основной надписи (`title_block`) на первую страницу: по нему классификатор
  определяет стадию и шифр.

Не берутся: сноски, примечания, надписи в фигурах и встроенные объекты (чертежи внутри DOCX). Страницы
условные — см. `ingest/flow.py`.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any

from inspector_ml.ingest.flow import Flow
from inspector_ml.ingest.pdf import CorruptedDocumentError
from inspector_ml.metadata.facts import describe

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_PARTS = re.compile(r"word/(header|footer)\d*\.xml$")


def parse_docx(path: Path, sha256: str, parser_version: str, *, file_name: str | None = None) -> dict[str, Any]:
    """Разобранный документ DOCX в форме `ParsedDocument` контракта."""
    try:
        with zipfile.ZipFile(path) as archive:
            body = ET.fromstring(archive.read("word/document.xml")).find(f"{W}body")
            margins = [ET.fromstring(archive.read(name)) for name in sorted(archive.namelist()) if _PARTS.match(name)]
    except (zipfile.BadZipFile, KeyError, ET.ParseError, OSError) as exc:
        raise CorruptedDocumentError(f"Файл DOCX не читается: {exc}") from exc
    if body is None:
        raise CorruptedDocumentError("В файле DOCX нет тела документа (word/document.xml)")

    flow = Flow(source="DOCX")
    stamp: list[str] = []
    for part in margins:
        for element in part:
            stamp += _texts(element)
    for text in dict.fromkeys(stamp):  # одинаковые колонтитулы разделов — один раз
        flow.text(text, kind="title_block")

    _body(flow, body)
    pages = flow.result()
    return {
        "sha256": sha256,
        "parser_version": parser_version,
        "format": "DOCX",
        "metadata": describe(pages, file_name=file_name or path.name, path=path),
        "pages": pages,
    }


def _body(flow: Flow, container: ET.Element) -> None:
    for element in container:
        if element.tag == f"{W}p":
            if _page_break(element):
                flow.new_page()
            flow.text(_paragraph(element))
        elif element.tag == f"{W}tbl":
            flow.table(_rows(element))
        elif element.tag in (f"{W}sdt", f"{W}sdtContent", f"{W}customXml"):
            _body(flow, element)


def _paragraph(p: ET.Element) -> str:
    parts: list[str] = []
    for node in p.iter():
        if node.tag == f"{W}t" and node.text:
            parts.append(node.text)
        elif node.tag in (f"{W}tab", f"{W}br", f"{W}cr"):
            parts.append(" ")
    return re.sub(r"\s+", " ", "".join(parts)).strip()


def _page_break(p: ET.Element) -> bool:
    before = p.find(f"{W}pPr/{W}pageBreakBefore")
    if before is not None and before.get(f"{W}val", "true") not in ("0", "false"):
        return True
    return any(node.get(f"{W}type") == "page" for node in p.iter(f"{W}br"))


def _rows(table: ET.Element) -> list[list[str]]:
    rows: list[list[str]] = []
    for tr in table.findall(f"{W}tr"):
        row: list[str] = []
        for tc in tr.findall(f"{W}tc"):
            span_el = tc.find(f"{W}tcPr/{W}gridSpan")
            span = int(span_el.get(f"{W}val", "1")) if span_el is not None else 1
            text = " ".join(t for t in (_paragraph(p) for p in tc.iter(f"{W}p")) if t)
            row += [text] + [""] * (span - 1)
        rows.append(row)
    return rows


def _texts(element: ET.Element) -> list[str]:
    """Текст колонтитула: абзацы и ячейки таблиц штампа — строками."""
    if element.tag == f"{W}p":
        text = _paragraph(element)
        return [text] if text else []
    if element.tag == f"{W}tbl":
        return [" ".join(cell for cell in row if cell) for row in _rows(element) if any(row)]
    return [t for child in element for t in _texts(child)]
