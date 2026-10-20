"""Какие файлы идут в эталонное сравнение («Перечень ИД» ред. 1.1, docs/domain/registry.md).

Сначала — правила, которые api уже применил к комплекту: исключённые файлы (``excluded_files``),
заменённые и аннулированные редакции, ручной выбор инспектора. Затем — цепочки редакций
и неоднозначности внутри документа (``revisions.py``).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from inspector_ml.compare.revisions import Conflict, resolve
from inspector_ml.compare.values import STAGES, plain
from inspector_ml.contracts.events import CompareFile, CompareRequest

EXCLUDED_APPROVAL = {"SUPERSEDED": "Редакция заменена (SUPERSEDED)", "CANCELLED": "Редакция аннулирована (CANCELLED)"}
METADATA_SOURCE = {"MANIFEST": "по реестру", "ML": "по оценке ML", "FILENAME": "по имени файла"}


@dataclass
class Selection:
    """Файлы актуальных редакций по стадиям и объяснение выбора для ``file_resolution``."""

    active: list[CompareFile] = field(default_factory=list)
    stage_of: dict[str, str] = field(default_factory=dict)
    resolution: list[dict[str, str]] = field(default_factory=list)
    conflicts: dict[str, Conflict] = field(default_factory=dict)
    """Файлы неоднозначных редакций: извлечение идёт, вывод о нарушении по их значениям блокируется."""

    @property
    def stages_present(self) -> set[str]:
        return {self.stage_of[str(f.file_id)] for f in self.active}


def select_files(request: CompareRequest) -> Selection:
    excluded = {str(e.file_id): e.reason for e in request.excluded_files or []}
    selection = Selection()
    for f in request.files:
        file_id = str(f.file_id)
        stage = plain(f.metadata.doc_stage)
        approval = plain(f.metadata.approval_status)
        if stage not in STAGES:
            unresolved = {"file_id": file_id, "role": "UNRESOLVED", "reason": "Стадия документа не определена"}
            selection.resolution.append(unresolved)
            continue
        reason: str | None = None
        if f.is_authoritative is False:
            reason = "Исключён инспектором"
        elif f.is_authoritative is not True:
            # ручной выбор инспектора важнее статуса редакции и исключения по реестру
            reason = excluded.get(file_id) or EXCLUDED_APPROVAL.get(str(approval))
        if reason:
            selection.resolution.append({"file_id": file_id, "role": "SUPERSEDED", "reason": reason})
            continue
        selection.active.append(f)

    revisions = resolve(selection.active, request.files)
    kept: list[CompareFile] = []
    for f in selection.active:
        file_id = str(f.file_id)
        approval = plain(f.metadata.approval_status)
        if file_id in revisions.superseded:
            reason = revisions.superseded[file_id]
            selection.resolution.append({"file_id": file_id, "role": "SUPERSEDED", "reason": reason})
            continue
        kept.append(f)
        selection.stage_of[file_id] = str(plain(f.metadata.doc_stage))
        conflict = revisions.conflicts.get(file_id)
        if conflict:
            selection.conflicts[file_id] = conflict
            reason = conflict.describe()
            reason = reason[0].upper() + reason[1:]
            selection.resolution.append({"file_id": file_id, "role": "CONFLICT", "reason": reason})
            continue
        source = METADATA_SOURCE.get(str(plain(f.metadata_source)), "источник метаданных неизвестен")
        basis = (
            "выбрана инспектором" if f.is_authoritative else f"статус утверждения {approval or 'UNKNOWN'} ({source})"
        )
        selection.resolution.append({"file_id": file_id, "role": "ACTUAL", "reason": f"Актуальная редакция: {basis}"})
    selection.active = kept
    order = {str(f.file_id): i for i, f in enumerate(request.files)}
    selection.resolution.sort(key=lambda r: order[r["file_id"]])  # в порядке файлов запроса
    return selection
