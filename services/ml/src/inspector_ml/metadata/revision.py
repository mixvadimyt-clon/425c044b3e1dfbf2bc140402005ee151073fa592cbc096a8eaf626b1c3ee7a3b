"""Редакция, даты, статусы утверждения и подписи (REQ-PRS-08, контракт v0.4).

Статус утверждения берётся из штампов: «В производство работ» — это `FOR_CONSTRUCTION`,
«Утверждаю» — `APPROVED`, «Аннулировано» и «Заменено» — `CANCELLED` и `SUPERSEDED`.
Если реестр прислал свои значения (`metadata_source = MANIFEST`), api наши не применяет,
но извлекать их всё равно нужно — по ним сверяют комплект.
"""

from __future__ import annotations

import re
from datetime import date

REVISION_RE = re.compile(r"(?:Изм(?:\.|енение)?|Кор(?:\.|рект\w*)?)\s*№?\s*(\d{1,2})", re.IGNORECASE)
SHEET_RE = re.compile(r"(?:Лист|Л\.)\s*№?\s*(\d{1,4}[А-Я]?)", re.IGNORECASE)
SHEETS_TOTAL_RE = re.compile(r"Листов\s*(\d{1,4})", re.IGNORECASE)
DATE_RE = re.compile(r"\b([0-3]?\d)[.\-/]([01]?\d)[.\-/]((?:19|20)\d{2})\b")

FOR_CONSTRUCTION_MARKERS = ("в производство работ", "к производству работ")
APPROVED_MARKERS = ("утверждаю", "утверждено", "утверждена", "согласовано")
CANCELLED_MARKERS = ("аннулирован", "аннулировано")
# «Взамен инв. №» — штатное поле штампа по ГОСТ, а не статус: по нему нельзя исключать редакцию
SUPERSEDED_MARKERS = ("заменён на", "заменен на", "заменено на", "аннулирована и заменена")
QES_MARKERS = ("подписано электронной подписью", "укэп", "усиленной квалифицированной")
AS_BUILT_MARKERS = ("выполнено согласно проекту", "работы выполнены в соответствии")


def _has(text: str, markers: tuple[str, ...]) -> bool:
    lowered = text.lower()
    return any(marker in lowered for marker in markers)


def revision(text: str) -> str | None:
    match = REVISION_RE.search(text)
    return match.group(1) if match else None


def sheet(text: str) -> str | None:
    match = SHEET_RE.search(text)
    return match.group(1) if match else None


def sheets_total(text: str) -> int | None:
    match = SHEETS_TOTAL_RE.search(text)
    return int(match.group(1)) if match else None


def latest_date(text: str) -> date | None:
    """Самая поздняя дата в тексте: в штампе их несколько (разработал, проверил, утвердил)."""
    found: list[date] = []
    for day, month, year in DATE_RE.findall(text):
        try:
            found.append(date(int(year), int(month), int(day)))
        except ValueError:
            continue
    return max(found) if found else None


def approval_status(text: str) -> str:
    """`ApprovalStatus` по контракту v0.4. Неизвестно — значит `UNKNOWN`, а не «не утверждено»."""
    if _has(text, CANCELLED_MARKERS):
        return "CANCELLED"
    if _has(text, SUPERSEDED_MARKERS):
        return "SUPERSEDED"
    if _has(text, FOR_CONSTRUCTION_MARKERS):
        return "FOR_CONSTRUCTION"
    if _has(text, APPROVED_MARKERS):
        return "APPROVED"
    return "UNKNOWN"


def signature_status(text: str) -> str:
    """По тексту видно только электронную подпись; рукописную определит CV."""
    return "QES" if _has(text, QES_MARKERS) else "UNKNOWN"


def stamps(text: str) -> dict[str, bool | None]:
    """Штампы исполнительной документации (Приказ 344/пр)."""
    return {
        "in_production": True if _has(text, FOR_CONSTRUCTION_MARKERS) else None,
        "as_built": True if _has(text, AS_BUILT_MARKERS) else None,
    }
