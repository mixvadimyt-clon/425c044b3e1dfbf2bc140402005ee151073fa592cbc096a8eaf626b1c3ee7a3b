"""Какие параметры пересчитывает дозагрузка (REQ-CMP-11).

Пропустить затронутый параметр опаснее, чем пересчитать лишний: api перенесёт непересчитанный из
прошлой версии протокола как есть. Поэтому каждая неопределённость проверяется отдельным тестом.
"""

from __future__ import annotations

from typing import Any

import pytest

from inspector_ml import contracts

if not contracts.is_generated():  # pragma: no cover — CI всегда выполняет uv run gen
    pytest.skip("сначала выполните uv run gen", allow_module_level=True)

from fixtures import file, param, request

from inspector_ml.compare.incremental import param_marks, plan

AREA = param(
    "M-002",
    "ПЗ",
    source_pd="Раздел ПЗ: Таблица ТЭП (текстовая часть)",
    source_rd='Раздел АР: Лист "Общие данные", Сводная экспликация',
)
CONCRETE = param(
    "M-055",
    "КР",
    source_pd="Общие данные; Спецификация материалов (КР)",
    source_rd="Общие указания; Спецификация элементов (КЖ)",
    source_id="Журнал бетонных работ; Паспорта на БСГ",
)
PARAMS = [AREA, CONCRETE]

PD_PZ = file(1, "PD", "1. П-2025-04.266-ПЗ.pdf", discipline="ПЗ")
PD_KR = file(2, "PD", "4. П-2025-04-266-КР.pdf", discipline="КР")
RD_KJ = file(3, "RD", "П-2025-04-266-КЖ01.pdf", discipline="КЖ")
RD_AR = file(4, "RD", "РД-2025-04-266-АР2.pdf", discipline="АР")
RD_SCAN = file(5, "RD", "скан.pdf")
NO_STAGE = file(6, None, "без стадии.pdf")
ALL_FILES = [PD_PZ, PD_KR, RD_KJ, RD_AR, RD_SCAN, NO_STAGE]


def made(changed: list[dict[str, Any]], params: list[Any] = PARAMS, **extra: Any):
    req = request(
        ALL_FILES,
        params=params,
        mode="INCREMENTAL",
        changed_file_ids=[f["file_id"] for f in changed],
        **extra,
    )
    return plan(req, params)


def test_full_mode_recalculates_everything() -> None:
    made_plan = plan(request(ALL_FILES, params=PARAMS), PARAMS)
    assert [p.code for p in made_plan.params] == ["M-002", "M-055"]
    assert made_plan.affected_codes is None
    assert not made_plan.partial


def test_changed_working_drawing_touches_only_its_section() -> None:
    """КЖ — рабочая марка раздела КР: пересчитываем класс бетона, площадь не трогаем."""
    made_plan = made([RD_KJ])
    assert made_plan.affected_codes == ["M-055"]
    assert made_plan.partial


def test_changed_architectural_sheet_touches_only_the_area_param() -> None:
    made_plan = made([RD_AR])
    assert made_plan.affected_codes == ["M-002"]
    assert made_plan.partial


def test_changed_design_section_is_matched_in_pd_too() -> None:
    assert made([PD_KR]).affected_codes == ["M-055"]
    assert made([PD_PZ]).affected_codes == ["M-002"]


def test_several_changed_files_are_summed() -> None:
    made_plan = made([RD_KJ, RD_AR])
    assert made_plan.affected_codes == ["M-002", "M-055"]
    assert not made_plan.partial


def test_file_without_marks_touches_every_param_of_its_stage() -> None:
    """У «скан.pdf» ни марки, ни шифра — сузить до раздела нельзя, пересчитываем всю стадию."""
    assert made([RD_SCAN]).affected_codes == ["M-002", "M-055"]


def test_file_without_stage_recalculates_everything() -> None:
    made_plan = made([NO_STAGE])
    assert made_plan.affected_codes == ["M-002", "M-055"]
    assert not made_plan.partial


def test_unknown_changed_file_recalculates_everything() -> None:
    req = request(
        ALL_FILES,
        params=PARAMS,
        mode="INCREMENTAL",
        changed_file_ids=["00000000-0000-4000-8000-000000000999"],
    )
    made_plan = plan(req, PARAMS)
    assert made_plan.affected_codes == ["M-002", "M-055"]
    assert not made_plan.partial


def test_incremental_without_changed_ids_recalculates_everything() -> None:
    made_plan = plan(request(ALL_FILES, params=PARAMS, mode="INCREMENTAL"), PARAMS)
    assert made_plan.affected_codes == ["M-002", "M-055"]
    assert not made_plan.partial


def test_param_with_unknown_marks_is_always_affected() -> None:
    odd = param("M-900", "НЕТ-В-ТАБЛИЦЕ", source_rd="Ведомость без марки")
    assert param_marks(odd, "RD") is None
    assert made([RD_KJ], params=[odd]).affected_codes == ["M-900"]


def test_param_marks_ignore_prose_in_the_source_description() -> None:
    """Из «Раздел АР: Лист "Общие данные"» марка — только АР, «ЛИСТ» и «ОБЩИЕ» не в счёт."""
    # «ОПЗ» — синоним раздела ПЗ из `SECTION_MARKS`: так пояснительную записку называют в шифрах.
    assert param_marks(AREA, "RD") == {"ПЗ", "ОПЗ", "АР"}
    assert param_marks(CONCRETE, "RD") == {"КР", "КЖ", "КМ", "КМД", "КД"}


def test_param_without_source_in_the_changed_stage_is_untouched() -> None:
    """У площади нет источника в ИД — акт её не затрагивает."""
    akt = file(7, "ID", "АОСР №1 бетонирование.pdf", discipline="КЖ")
    req = request(
        [*ALL_FILES, akt],
        params=PARAMS,
        mode="INCREMENTAL",
        changed_file_ids=[akt["file_id"]],
    )
    assert plan(req, PARAMS).affected_codes == ["M-055"]
