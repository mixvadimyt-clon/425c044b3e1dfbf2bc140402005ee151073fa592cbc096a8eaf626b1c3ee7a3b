"""Разбор XML (REQ-UPL-02): элементы и атрибуты → тот же разобранный документ, что у PDF.

XML в надзоре — выгрузки из информационных систем и электронные формы исполнительной документации:
структура своя у каждой схемы, страниц нет. Поэтому разбор общий, без знания схемы:

- **пары «элемент — значение»** — листовой элемент с текстом и каждый атрибут дают строку таблицы
  из двух ячеек: имя (для атрибута — `элемент.атрибут`) и значение. Если в документе есть человекочитаемые
  наименования («<Наименование>Общая площадь здания</Наименование><Значение>3009,4</Значение>»),
  соседние наименование и значение одного родителя собираются в одну строку — так ТЭП в XML находится
  по якорям матрицы;
- **блоки текста** — та же строка текстом («Общая площадь здания: 3009,4») для шаблонов матрицы.

Безопасность: внешние сущности `xml.etree` не загружает, от «миллиарда смеха» защищает expat в составе
Python; размер файла ограничивает api (до 50 МБ). Страницы условные — см. `ingest/flow.py`.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from inspector_ml.ingest.flow import Flow
from inspector_ml.ingest.pdf import CorruptedDocumentError
from inspector_ml.metadata.facts import describe

#: Имена элементов, которые в формах обычно несут наименование и значение показателя.
NAME_TAGS = {"name", "наименование", "title", "caption", "label", "показатель", "параметр"}
VALUE_TAGS = {"value", "значение", "val", "amount", "количество", "величина"}


def parse_xml(path: Path, sha256: str, parser_version: str, *, file_name: str | None = None) -> dict[str, Any]:
    """Разобранный документ XML в форме `ParsedDocument` контракта."""
    try:
        root = ET.parse(path).getroot()
    except (ET.ParseError, OSError) as exc:
        raise CorruptedDocumentError(f"Файл XML не читается: {exc}") from exc

    rows: list[list[str]] = []
    _walk(root, rows)
    flow = Flow(source="XML")
    flow.text(f"{_local(root.tag)}: документ XML")
    flow.table(rows, sep=": ")
    pages = flow.result()
    return {
        "sha256": sha256,
        "parser_version": parser_version,
        "format": "XML",
        "metadata": describe(pages, file_name=file_name or path.name, path=path),
        "pages": pages,
    }


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _walk(element: ET.Element, rows: list[list[str]], *, paired: bool = False) -> None:
    name = _local(element.tag)
    for key, value in element.attrib.items():
        if value.strip():
            rows.append([f"{name}.{_local(key)}", value.strip()])
    children = list(element)
    # наименование и значение показателя у одного родителя — одна строка «наименование | значение»
    leaves = {_local(c.tag).casefold(): c for c in children if len(c) == 0 and (c.text or "").strip()}
    label = next((leaves[t] for t in sorted(NAME_TAGS) if t in leaves), None)
    value = next((leaves[t] for t in sorted(VALUE_TAGS) if t in leaves), None)
    pair = {id(label), id(value)} if label is not None and value is not None else set()
    if pair:
        rows.append([(label.text or "").strip(), (value.text or "").strip()])
    text = (element.text or "").strip()
    if text and not children and not paired:
        rows.append([name, text])
    for child in children:
        _walk(child, rows, paired=id(child) in pair)
