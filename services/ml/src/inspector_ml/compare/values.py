"""Общие мелочи движка: значения перечислений контракта и подписи стадий."""

from __future__ import annotations

import re

from pydantic import RootModel

from inspector_ml.contracts.events import MatrixParam

STAGES: tuple[str, ...] = ("PD", "RD", "ID")
STAGE_LABEL: dict[str, str] = {"PD": "ПД", "RD": "РД", "ID": "ИД"}
SOURCE_FIELD: dict[str, str] = {"PD": "source_pd", "RD": "source_rd", "ID": "source_id"}


def source_text(param: MatrixParam, stage: str) -> str:
    """Описание источника параметра в стадии из матрицы (source_pd / source_rd / source_id)."""
    return getattr(param, SOURCE_FIELD[stage], None) or ""


def required_stages(param: MatrixParam) -> list[str]:
    """Стадии, в которых матрица указывает источник параметра."""
    return [s for s in STAGES if source_text(param, s).strip()]


def plain(value: object) -> object:
    """Значение перечисления из сгенерированной модели (RootModel) как обычная строка."""
    return value.root if isinstance(value, RootModel) else value


def stage_order(stage: str) -> int:
    return STAGES.index(stage) if stage in STAGES else len(STAGES)


def norm_code(value: str | None) -> str:
    """Нормализация шифра и марки для сопоставления — как ``norm`` в services/api/src/modules/stages.ts."""
    return re.sub(r"[\s_]+", "-", (value or "").upper()).replace("Ё", "Е")
