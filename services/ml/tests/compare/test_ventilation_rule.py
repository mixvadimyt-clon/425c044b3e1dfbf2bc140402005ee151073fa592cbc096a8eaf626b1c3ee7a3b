"""Вентиляция по помещениям ПД ↔ РД (IOS4-078, IOS4-079) — сравнение состава систем."""

from __future__ import annotations

import pytest

from inspector_ml import contracts

if not contracts.is_generated():  # pragma: no cover — CI всегда выполняет uv run gen
    pytest.skip("сначала выполните uv run gen", allow_module_level=True)

from test_engine import cfile, compare, ex, make_request, status

from inspector_ml.compare import systems

# Строки матрицы как в data/matrix/params.csv: тип и триггер M-078 — про сечения, а значение извлечения — состав систем
M078 = {
    "code": "M-078",
    "section": "ИОС4",
    "parameter_name": "Сечения и геометрия воздуховодов общеобменной вентиляции",
    "unit": "мм²",
    "source_pd": "Принципиальные схемы вентиляции (ИОС4)",
    "source_rd": "Поэтажные планы; Разрезы; Спецификация (ОВ)",
    "source_id": "Исполнительные схемы вентиляции (геометрия коробов)",
    "trigger_logic": "Уменьшение площади сечения воздуховода в РД (падение объема воздуха, рост шума).",
    "review_priority": "HIGH",
    "data_type": "number",
}
M079 = {
    **M078,
    "code": "M-079",
    "parameter_name": "Характеристики вентиляторов общеобменной вентиляции",
    "unit": "м³/ч / Па / кВт",
    "trigger_logic": "Подмена установок на аналоги с меньшей кратностью воздухообмена.",
    "data_type": "string",
}
OV_PD = cfile(31, "PD", "Том 5.4.2 ОВ.pdf", discipline="ИОС4", document_code="П-2025-ИОС4.2")
OV_RD = cfile(32, "RD", "ОВ1.pdf", discipline="ОВ", document_code="Р-2025-ОВ1")


def run_rooms(param: dict, rooms: dict[str, tuple[str | None, str | None]]):
    values = []
    for room, (pd, rd) in rooms.items():
        if pd is not None:
            values.append(ex(param["code"], OV_PD, pd, pd, rule_key=f"пом. {room}"))
        if rd is not None:
            values.append(ex(param["code"], OV_RD, rd, rd, rule_key=f"пом. {room}"))
    result, _ = compare(make_request([OV_PD, OV_RD], params=[param]), values)
    return {c.rule_key: c for c in result.checks}


def test_exhaust_missing_in_rd_is_a_candidate_with_its_own_wording() -> None:
    checks = run_rooms(M078, {"140": ("В3.1, ВЕ", "ВЕ")})
    check = checks["пом. 140"]
    assert status(check) == ("CANDIDATE", "COMPLETE")
    assert check.rationale == "ПД: В3.1, ВЕ; РД: ВЕ. Вытяжная вентиляция в РД отсутствует: нет систем В3.1"
    assert check.delta == "−В3.1"
    # триггер матрицы про сечения воздуховодов к составу систем не относится
    assert "Триггер матрицы" not in check.rationale


def test_part_of_the_systems_missing_is_a_configuration_change() -> None:
    check = run_rooms(M078, {"147": ("В2.7, В2.8, П3", "В2.7, П3, П4")})["пом. 147"]
    assert status(check) == ("CANDIDATE", "COMPLETE")
    assert check.rationale.endswith("Конфигурация вентиляции изменена: в РД нет систем В2.8, появились П4")
    assert check.delta == "−В2.8; +П4"


def test_systems_only_added_in_rd_are_not_a_candidate() -> None:
    # в РД добавилась естественная вытяжка — состав ПД сохранён
    check = run_rooms(M078, {"168": ("В2.7", "В2.7, ВЕ")})["пом. 168"]
    assert status(check) == ("NEGATIVE_VERIFIED", "COMPLETE")
    assert "триггер это не описывает" in check.rationale


def test_incomplete_ocr_label_counts_as_the_same_system() -> None:
    # «В12.1» на плане РД распознана как «В12»; порядок и регистр значения не важны
    check = run_rooms(M078, {"201": ("В12.1, ВЕ", "ве, в12")})["пом. 201"]
    assert status(check) == ("NEGATIVE_VERIFIED", "COMPLETE")
    assert check.rationale.endswith("Состав систем совпадает")


def test_bare_natural_ventilation_matches_a_numbered_one() -> None:
    # «Тюменская 5», 008: в ПД естественный приток «ПЕ» без номера, в РД «ПЕ1» — это одна система
    checks = run_rooms(M078, {"008": ("В1, ПЕ", "В1, ПЕ1"), "009": ("ВЕ", "ВЕ16"), "010": ("В1, ПЕ, ПЕ1", "В1, ПЕ1")})
    assert status(checks["пом. 008"]) == ("NEGATIVE_VERIFIED", "COMPLETE")
    assert status(checks["пом. 009"]) == ("NEGATIVE_VERIFIED", "COMPLETE")
    # в ПД обе — и «ПЕ», и «ПЕ1»: «ПЕ1» в РД уже нашла свою пару, «ПЕ» в РД нет
    assert status(checks["пом. 010"]) == ("CANDIDATE", "COMPLETE")
    assert checks["пом. 010"].delta == "−ПЕ"
    # другая буква — другая система: «ПЕ» не «ВЕ1», «П» без номера не равно «П1»
    assert not systems._same("ПЕ", "ВЕ1")
    assert not systems._same("П", "П1")


def test_value_only_in_one_stage_is_not_a_violation() -> None:
    checks = run_rooms(M078, {"142": ("В3.2", None), "300": (None, "В5")})
    assert status(checks["пом. 142"]) == ("NOT_COMPARABLE", "NOT_COMPARABLE")
    assert status(checks["пом. 300"]) == ("NOT_COMPARABLE", "NOT_COMPARABLE")


def test_supply_units_of_a_ventilation_chamber_differ_in_any_direction() -> None:
    checks = run_rooms(M079, {"012": ("П2, П3", "П2, П2.1"), "006": ("П1", "П1")})
    chamber = checks["пом. 012"]
    assert status(chamber) == ("CANDIDATE", "COMPLETE")
    assert chamber.rationale.endswith(
        "Конфигурация приточных установок изменена: в РД нет установок П3, появились П2.1"
    )
    assert "Триггер матрицы" not in chamber.rationale
    assert status(checks["пом. 006"]) == ("NEGATIVE_VERIFIED", "COMPLETE")


def test_numeric_values_of_m078_still_go_through_the_matrix_trigger() -> None:
    # сечение воздуховода из текста (не состав систем) сравнивается по-прежнему, как число
    assert systems.parse("400") is None
    [check] = run_rooms(M078, {"1": ("400", "300")}).values()
    assert "Триггер матрицы" in check.rationale


@pytest.mark.parametrize(
    ("value", "parsed"),
    [
        ("В2.7, В2.8, В2.9", ["В2.7", "В2.8", "В2.9"]),
        ("B2.7, BE16", ["В2.7", "ВЕ16"]),
        ("ВЕ, ПЕ", ["ВЕ", "ПЕ"]),
        ("Классы В3, В4", None),
        ("", None),
    ],
)
def test_parse_accepts_only_lists_of_system_codes(value: str, parsed: list[str] | None) -> None:
    assert systems.parse(value) == parsed
