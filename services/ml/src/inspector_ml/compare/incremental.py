"""Какие параметры затронула дозагрузка (REQ-CMP-11).

При дозагрузке api присылает ``mode=INCREMENTAL`` и ``changed_file_ids``, а получив ответ, переносит
из прошлой версии протокола все параметры, которых нет в ``affected_param_codes`` — вместе с решениями
инспектора (REQ-VER-06). Поэтому **пропустить затронутый параметр опаснее, чем пересчитать лишний**:
пропущенный останется в новой версии протокола со старым значением, и заметить это будет неоткуда.

Правило (ARCHITECTURE.md, «Дозагрузка»): параметр затронут, если у него есть источник в стадии
изменённого файла и марки совпали. Любая неопределённость трактуется в пользу пересчёта:

- изменённого файла нет в запросе или его стадия не определена — пересчитываем весь комплект;
- марки файла не разобрались — затронуты все параметры его стадии;
- марки параметра не определились — параметр затронут.

Марки параметра берём из таблицы разделов (``applicability.SECTION_MARKS``) и из текста источника в
матрице, оставляя только знакомые марки: в описаниях источников много прозы («Раздел АР: Лист "Общие
данные"»), и без фильтра «ЛИСТ» с «ОБЩИЕ» попали бы в марки наравне с «АР».
"""

from __future__ import annotations

from collections.abc import Collection, Sequence
from dataclasses import dataclass

from inspector_ml.compare.applicability import KNOWN_MARKS, SECTION_MARKS, doc_marks, marks
from inspector_ml.compare.values import STAGES, norm_code, plain, required_stages, source_text
from inspector_ml.contracts.events import CompareRequest, MatrixParam


@dataclass(frozen=True)
class Plan:
    """Что пересчитываем в этом прогоне."""

    params: list[MatrixParam]
    affected_codes: list[str] | None
    """``affected_param_codes`` в ответе: ``None`` для полного прогона."""

    partial: bool
    """Пересчитана только часть параметров — по стадиям судить о полноте комплекта нельзя."""


def param_marks(param: MatrixParam, stage: str) -> set[str] | None:
    """Марки, которыми параметр опознаёт свой источник в стадии; ``None`` — определить нельзя."""
    section = norm_code((plain(param.section) or "").strip())
    found = set(SECTION_MARKS.get(section, ()))
    found |= marks(source_text(param, stage)) & KNOWN_MARKS
    return found or None


def plan(request: CompareRequest, params: Sequence[MatrixParam], always: Collection[str] = ()) -> Plan:
    """Параметры к пересчёту: для FULL — все, для INCREMENTAL — затронутые изменёнными файлами.

    ``always`` — коды, которые нужны в любом прогоне: на них ссылаются логические правила,
    а гипотезы api берёт из ответа целиком и из прошлой версии не переносит. Без значений этих
    параметров правило просто замолчало бы, и гипотеза пропала бы из новой версии протокола.
    """
    everything = Plan(list(params), None, partial=False)
    if plain(request.mode) != "INCREMENTAL":
        return everything

    all_codes = [p.code for p in params]
    changed = [str(i) for i in request.changed_file_ids or []]
    by_id = {str(f.file_id): f for f in request.files}
    if not changed or any(c not in by_id for c in changed):
        # api не сказал, что изменилось, или прислал файл не из комплекта — сузить нельзя
        return Plan(list(params), all_codes, partial=False)

    wide: set[str] = set()
    """Стадии, в которых марки изменённых файлов не разобрались."""
    narrow: dict[str, set[str]] = {}

    for file_id in changed:
        f = by_id[file_id]
        stage = str(plain(f.metadata.doc_stage))
        if stage not in STAGES:
            return Plan(list(params), all_codes, partial=False)
        if found := doc_marks(f.metadata.discipline, f.metadata.document_code, f.original_name):
            narrow.setdefault(stage, set()).update(found)
        else:
            wide.add(stage)

    needed = set(always)
    affected = [p for p in params if p.code in needed or _is_affected(p, wide, narrow)]
    return Plan(affected, [p.code for p in affected], partial=len(affected) < len(params))


def _is_affected(param: MatrixParam, wide: set[str], narrow: dict[str, set[str]]) -> bool:
    for stage in required_stages(param):
        if stage in wide:
            return True
        changed_marks = narrow.get(stage)
        if not changed_marks:
            continue
        own = param_marks(param, stage)
        if own is None or own & changed_marks:
            return True
    return False
