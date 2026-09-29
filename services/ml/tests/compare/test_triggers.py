"""Разбор триггеров Приложения 1 и компараторы по ним."""

from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from inspector_ml import contracts

if not contracts.is_generated():  # pragma: no cover — CI всегда выполняет uv run gen
    pytest.skip("сначала выполните uv run gen", allow_module_level=True)

from inspector_ml.compare.comparators import Incomparable, Outcome, compare, decimals, enum_key
from inspector_ml.compare.keys import rule_group
from inspector_ml.compare.triggers import Direction, parse
from inspector_ml.contracts.events import MatrixParam

PARAMS_CSV = Path(__file__).resolve().parents[4] / "data" / "matrix" / "params.csv"
CONCRETE = ["B7.5", "B10", "B12.5", "B15", "B20", "B22.5", "B25", "B27.5", "B30", "B35", "B40", "B45", "B50", "B55"]


def param(trigger: str, data_type: str = "number", **extra: Any) -> MatrixParam:
    return MatrixParam.model_validate(
        {
            "id": 1,
            "created_at": "2026-09-18T10:00:00Z",
            "updated_at": "2026-09-18T10:00:00Z",
            "code": "M-900",
            "section": "ПЗ",
            "parameter_name": "Тест",
            "review_priority": "HIGH",
            "trigger_logic": trigger,
            "data_type": data_type,
            **extra,
        }
    )


@dataclass(frozen=True)
class Value:
    raw_value: str
    value: Any
    unit: str | None = None


def run(p: MatrixParam, expected: Any, actual: Any) -> Outcome | Incomparable:
    e = None if expected is None else Value(str(expected), expected)
    return compare(p, e, Value(str(actual), actual))  # type: ignore[arg-type]


M002 = param("Дельта общей площади между ПД и РД (или ИД) > 1%.", unit="м²")
M055 = param("Понижение класса бетона несущих элементов (например, B35 на B30) в РД/ИД.", "enum", enum_values=CONCRETE)


@pytest.mark.parametrize(
    ("text", "direction", "fields"),
    [
        ("Дельта общей площади между ПД и РД (или ИД) > 1%.", Direction.ANY, {"percent": 1.0}),
        ("Понижение класса бетона несущих элементов (например, B35 на B30) в РД/ИД.", Direction.DOWN, {}),
        ("Расхождение контуров здания на генплане с данными БТИ или РД > 0.", Direction.ANY, {"absolute": 0.0}),
        ("Смещение точки подключения наружной сети относительно ТУ и ПД > 0.5 м.", Direction.ANY, {"absolute": 0.5}),
        ("Увеличение или уменьшение площади твердых покрытий > 5%.", Direction.ANY, {"percent": 5.0}),
        ("Превышение итоговой стоимости строительства в РД/ИД над утвержденной ПД > 5%.", Direction.UP, {}),
        ("Ширина дверного полотна на путях эвакуации в РД/ИД < 0.9 м.", Direction.ANY, {"below": 0.9, "unit": "м"}),
        ("Снижение ширины коридора в РД/ИД менее 1.2 м (СП 1.13130).", Direction.DOWN, {"below": 1.2}),
        ("Глубина тамбура в РД/ИД менее 1.5-1.8 м (невозможность проезда коляски).", Direction.ANY, {"below": 1.5}),
        ("Высота коридоров < 2.0 м или дверей < 1.9 м (СП 1.13130).", Direction.ANY, {"below": 1.9}),
        ("Высота порога > 0.014 м (СП 59.13330).", Direction.ANY, {"above": 0.014, "percent": None}),
        ("Отсутствие или уменьшение доли мест для МГН (< 10% от общего числа).", Direction.DOWN, {"below": 10.0}),
        ("Увеличение высоты здания в РД (риск нарушения ограничений приаэродромных зон).", Direction.UP, {}),
        ('Сокращение количества динамиков; отсутствие табло "Выход" на путях эвакуации.', Direction.DOWN, {}),
        ("Замена утеплителя на аналог с более высоким коэффициентом теплопроводности.", Direction.UP, {}),
        ("Занижение или завышение токов уставки в РД.", Direction.ANY, {}),
        ("Подмена марки стали на менее прочную (например, С345 на С245).", Direction.DOWN, {}),
        ("Применение кабеля без индекса огнестойкости (например, замена FRLS на обычный LS).", Direction.DOWN, {}),
    ],
)
def test_parse_trigger_text(text: str, direction: Direction, fields: dict[str, Any]) -> None:
    trigger = parse(text)
    assert trigger.parsed
    assert trigger.direction is direction
    for name, value in fields.items():
        assert getattr(trigger, name) == value, name


def test_every_numeric_and_enum_trigger_of_the_matrix_is_parsed() -> None:
    if not PARAMS_CSV.exists():  # pragma: no cover
        pytest.skip("нет data/matrix/params.csv")
    rows = list(csv.DictReader(PARAMS_CSV.open(encoding="utf-8")))
    assert len(rows) == 132
    compared = [r for r in rows if r["data_type"] in ("number", "enum")]
    unparsed = {r["code"] for r in compared if not parse(r["trigger_logic"]).parsed}
    # качественные условия без величины — сравнение значений их не проверит, остаются NOT_COMPARABLE
    assert unparsed == {"M-065", "M-097", "M-114"}


def test_m002_delta_threshold_is_one_percent_of_the_reference() -> None:
    hit = run(M002, 3009.4, 3050.1)
    assert isinstance(hit, Outcome) and hit.triggered
    assert hit.delta == "+40.7 (+1.35 %)"
    assert "1.35 % больше порога 1 %" in hit.rationale

    small = run(M002, 3009.4, 3030.0)  # +0.68 % — различие не триггерное
    assert isinstance(small, Outcome) and not small.triggered
    assert small.delta == "+20.6 (+0.68 %)"
    assert "не больше порога" in small.rationale

    down = run(M002, 3009.4, 2950.0)  # «дельта» — в обе стороны
    assert isinstance(down, Outcome) and down.triggered


def test_numbers_equal_up_to_rounding_are_equal() -> None:
    exact = param("Расхождение контуров здания на генплане с данными БТИ или РД > 0.")
    same = compare(exact, Value("1 234,5", 1234.5), Value("1234,46", 1234.46))  # type: ignore[arg-type]
    assert isinstance(same, Outcome) and not same.triggered
    assert same.rationale == "значения совпадают с точностью округления"
    differ = compare(exact, Value("1 234,5", 1234.5), Value("1234,4", 1234.4))  # type: ignore[arg-type]
    assert isinstance(differ, Outcome) and differ.triggered
    assert decimals("3 009,40 м2") == 2 and decimals("18") == 0


def test_direction_decides_whether_a_difference_is_a_candidate() -> None:
    slab = param("Уменьшение проектной толщины плиты в РД или по факту заливки (ИД).", unit="мм")
    thinner = run(slab, 250, 200)
    assert isinstance(thinner, Outcome) and thinner.triggered
    assert thinner.rationale == "значение уменьшилось"
    thicker = run(slab, 250, 300)  # как KR-058 в эталоне: различие есть, но не триггерное
    assert isinstance(thicker, Outcome) and not thicker.triggered
    assert thicker.delta == "+50 (+20.00 %)"
    assert thicker.rationale == "увеличение значения, триггер срабатывает только на уменьшение"


def test_limit_from_matrix_checks_actual_value_even_without_reference() -> None:
    door = param("Ширина дверного полотна на путях эвакуации в РД/ИД < 0.9 м.", unit="м")
    narrow = run(door, None, 0.8)
    assert isinstance(narrow, Outcome) and narrow.triggered
    assert narrow.delta is None
    assert narrow.rationale == "0.8 м меньше предела 0.9 м из матрицы"
    wide = run(door, 1.0, 0.95)  # уже, чем в ПД, но не ниже предела
    assert isinstance(wide, Outcome) and not wide.triggered
    assert wide.rationale == "0.95 м в пределах матрицы (не меньше 0.9 м)"
    # предел в метрах, значение в миллиметрах
    mm = compare(door, None, Value("850", 850, "мм"))  # type: ignore[arg-type]
    assert isinstance(mm, Outcome) and mm.triggered
    assert mm.rationale == "850 мм меньше предела 900 мм из матрицы"


def test_min_value_of_the_matrix_is_a_limit() -> None:
    p = param("Сокращение количества машино-мест в РД.", min_value=120)
    assert isinstance(hit := run(p, 130, 110), Outcome) and hit.triggered
    assert "меньше предела 120" in hit.rationale


def test_m055_concrete_class_lowering_only() -> None:
    lower = run(M055, "B35", "В30")  # кириллическая «В» в документе
    assert isinstance(lower, Outcome) and lower.triggered
    assert lower.delta == "понижение на 1 ступ."
    higher = run(M055, "B30", "B35")
    assert isinstance(higher, Outcome) and not higher.triggered
    assert higher.rationale == "повышение: B30 → B35, триггер срабатывает только на понижение"
    same = run(M055, "В 22,5", "B22.5")
    assert isinstance(same, Outcome) and not same.triggered
    number_only = run(M055, "B30", "25")  # «бетон класса 25» без буквы
    assert isinstance(number_only, Outcome) and number_only.triggered
    unknown = run(M055, "B30", "M300")  # марка вместо класса — не угадываем
    assert isinstance(unknown, Incomparable)
    assert "не входит в перечень" in unknown.reason
    assert enum_key("в 12,5") == "B12.5"


def test_unparsed_trigger_makes_numbers_incomparable_but_strings_still_compare() -> None:
    qualitative = param("Самовольная заделка крупных проемов в РД без обрамляющего армирования.")
    result = run(qualitative, 4, 3)
    assert isinstance(result, Incomparable)
    assert "триггер матрицы не разобран" in result.reason
    text = param("Дверь открывается внутрь помещения.", "string")
    changed = run(text, "Наружу", "Внутрь")
    assert isinstance(changed, Outcome) and changed.triggered


def test_room_purpose_is_compared_as_text() -> None:
    same = run(M002, "Кладовая уборочного инвентаря.", "кладовая  уборочного инвентаря")
    assert isinstance(same, Outcome) and not same.triggered
    other = run(M002, "Кладовая", "Офис")
    assert isinstance(other, Outcome) and other.triggered


def test_boolean_follows_direction() -> None:
    meters = param("Отсутствие в РД общедомовых/поквартирных счетчиков.", "boolean")
    assert isinstance(gone := run(meters, "да", "нет"), Outcome) and gone.triggered
    assert isinstance(added := run(meters, "нет", "есть"), Outcome) and not added.triggered


def test_coordinates_shift_threshold() -> None:
    point = param("Смещение точки подключения наружной сети относительно ТУ и ПД > 0.5 м.", "coordinate", unit="м")
    near = run(point, "12.0; 30.0", "12.3; 30.3")
    assert isinstance(near, Outcome) and not near.triggered
    far = run(point, "12.0; 30.0", "12.6; 30.0")
    assert isinstance(far, Outcome) and far.triggered


@pytest.mark.parametrize(
    ("a", "b"),
    [
        ("пом. 1.09", "Помещение 1-09"),
        ("пом. 1.09", "ПОМ 1,09"),
        ("пом. 1.09 (назначение)", "Пом.1.09(Назначение)"),
        ("Общая площадь здания", "общая  площадь здания"),
    ],
)
def test_rule_group_matches_room_labels(a: str, b: str) -> None:
    assert rule_group(a) == rule_group(b)


def test_rule_group_keeps_different_rooms_apart() -> None:
    assert rule_group("пом. 1.09") != rule_group("пом. 1.9")
    assert rule_group("пом. 1.09") != rule_group("пом. 1.09 (назначение)")
