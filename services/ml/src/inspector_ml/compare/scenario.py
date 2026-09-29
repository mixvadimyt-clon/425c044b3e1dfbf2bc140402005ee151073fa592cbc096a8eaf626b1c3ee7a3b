"""Статусы загрузки по стадиям и сценарий проверки (docs/domain/statuses.md §2–3).

Движок даёт свою оценку, api объединяет её со своей (реестр, ошибки обработки) и берёт худшую.
X_UPLOADED — только если ожидаемый состав стадии известен (реестр или ``expected_documents``) и движок
не нашёл нехватки: без реестра система не вправе объявить комплект полным.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from inspector_ml.compare.values import STAGES, norm_code, plain
from inspector_ml.contracts.events import ExpectedDocument


@dataclass(frozen=True)
class StagedFile:
    """Файл комплекта с определённой стадией — для сопоставления с ожидаемым составом."""

    stage: str
    original_name: str | None
    document_code: str | None
    discipline: str | None


def is_expected_present(expected: ExpectedDocument, files: Iterable[StagedFile]) -> bool:
    """Ожидаемый документ загружен, если есть файл той же стадии с тем же именем, шифром или маркой (по порядку)."""
    stage = plain(expected.doc_stage)
    for f in files:
        if f.stage != stage:
            continue
        if expected.file_name:
            if f.original_name == expected.file_name:
                return True
        elif expected.document_code:
            if norm_code(expected.document_code) in norm_code(f.document_code):
                return True
        elif expected.discipline:
            if norm_code(f.discipline) == norm_code(expected.discipline):
                return True
        else:
            return True
    return False


def missing_expected(
    expected: Sequence[ExpectedDocument] | None, files: Sequence[StagedFile]
) -> list[ExpectedDocument]:
    return [e for e in expected or [] if not is_expected_present(e, files)]


def upload_status(present: set[str], short: set[str], confirmed: set[str]) -> list[str]:
    """X_MISSING — файлов стадии нет; X_UPLOADED — состав стадии подтверждён и нехватки нет; иначе X_PARTIAL."""
    result = []
    for stage in STAGES:
        complete = stage in confirmed and stage not in short
        state = "MISSING" if stage not in present else "UPLOADED" if complete else "PARTIAL"
        result.append(f"{stage}_{state}")
    return result


def scenario(present: set[str], known_gap: bool) -> str | None:
    """Сценарий по набору стадий; PARTIALLY_LOADED — только при известном пробеле в ожидаемом составе."""
    if not present:
        return None
    if known_gap:
        return "PARTIALLY_LOADED"
    stages = frozenset(present)
    if stages == {"PD", "RD", "ID"}:
        return "FULL"
    return {
        frozenset({"PD", "RD"}): "PD_RD_ONLY",
        frozenset({"PD", "ID"}): "PD_ID_ONLY",
        frozenset({"RD", "ID"}): "RD_ID_ONLY",
    }.get(stages, "SINGLE_ONLY")
