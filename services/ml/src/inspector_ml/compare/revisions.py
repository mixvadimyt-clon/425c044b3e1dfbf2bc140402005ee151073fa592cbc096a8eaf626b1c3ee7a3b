"""Актуальная редакция внутри документа («Перечень ИД» ред. 1.1, docs/domain/registry.md).

Правила те же, что у api при расчёте полноты комплекта (services/api/src/modules/stages.ts::ambiguousRevisions),
чтобы замечание AMBIGUOUS_REVISION в комплекте и CLARIFICATION_REQUIRED в протоколе не расходились:

- редакция, на которую ссылается другая как на предыдущую (``predecessor_id``) или у которой указана следующая
  (``successor_id``), заменена — если инспектор не выбрал её сам;
- документы группируются по стадии и шифру (нормализация — как ``norm`` в api);
- в группе из нескольких редакций однозначно, если инспектор отметил ровно одну авторитетной или утверждена
  (APPROVED / FOR_CONSTRUCTION) ровно одна — остальные в сравнение не идут;
- иначе конфликт: редакции остаются доступны извлечению (доказательства видны инспектору), но вывод о нарушении
  по значениям из них блокируется — CLARIFICATION_REQUIRED, пока инспектор не выберет редакцию.

Номер изменения («Изм. 1») и дата утверждения выбор не решают: так же, как в api, — чтобы не выбрать молча.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

from inspector_ml.compare.values import STAGE_LABEL, norm_code, plain
from inspector_ml.contracts.events import CompareFile

REFERENCE_APPROVAL = frozenset({"APPROVED", "FOR_CONSTRUCTION"})


@dataclass(frozen=True)
class Conflict:
    """Несколько действующих редакций одного документа без однозначного выбора."""

    stage: str
    document_code: str
    names: tuple[str, ...]

    def describe(self) -> str:
        return (
            f"несколько редакций «{self.document_code}» ({STAGE_LABEL.get(self.stage, self.stage)}) "
            f"без однозначного выбора ({', '.join(self.names)}), выберите авторитетную редакцию"
        )


@dataclass
class Revisions:
    superseded: dict[str, str] = field(default_factory=dict)
    """file_id → почему редакция не идёт в сравнение."""
    conflicts: dict[str, Conflict] = field(default_factory=dict)
    """file_id → конфликт редакций, в который входит файл."""


def _approval(f: CompareFile) -> str:
    return str(plain(f.metadata.approval_status) or "UNKNOWN")


def resolve(active: Sequence[CompareFile], all_files: Sequence[CompareFile]) -> Revisions:
    """Разобрать редакции среди ``active`` (уже без исключённых api); связи ищутся по всем файлам запроса."""
    result = Revisions()
    names = {str(f.file_id): f.original_name for f in all_files}
    successor_of = {str(f.predecessor_id): str(f.file_id) for f in all_files if f.predecessor_id}
    for f in all_files:
        if f.successor_id:
            successor_of.setdefault(str(f.file_id), str(f.successor_id))

    remaining: list[CompareFile] = []
    for f in active:
        file_id = str(f.file_id)
        successor = successor_of.get(file_id)
        if successor and successor in names and f.is_authoritative is not True:
            result.superseded[file_id] = f"Заменена редакцией «{names[successor]}»"
        else:
            remaining.append(f)

    groups: dict[tuple[str, str], list[CompareFile]] = {}
    for f in remaining:
        code = f.metadata.document_code
        stage = plain(f.metadata.doc_stage)
        if not code or not stage:
            continue
        groups.setdefault((str(stage), norm_code(code)), []).append(f)

    for (stage, _), group in groups.items():
        if len(group) < 2:
            continue
        chosen = [f for f in group if f.is_authoritative is True]
        approved = [f for f in group if _approval(f) in REFERENCE_APPROVAL]
        if len(chosen) == 1:
            keep, why = chosen[0], f"Инспектор выбрал редакцию «{chosen[0].original_name}»"
        elif len(approved) == 1:
            keep = approved[0]
            why = f"Утверждена редакция «{keep.original_name}» ({_approval(keep)})"
        else:
            conflict = Conflict(stage, str(group[0].metadata.document_code), tuple(f.original_name for f in group))
            for f in group:
                result.conflicts[str(f.file_id)] = conflict
            continue
        for f in group:
            if f is not keep:
                result.superseded[str(f.file_id)] = f"{why}, у этой статус {_approval(f)}"
    return result
