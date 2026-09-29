"""Мини-DSL логических правил: разбор и трёхзначное вычисление.

Текст правил приходит из базы и пишется администратором, поэтому отдельно проверяем, что разбор
ничего не исполняет и на мусоре аккуратно ругается, а не падает.
"""

from __future__ import annotations

import pytest

from inspector_ml.suspicion.rules import dsl

VALUE_IN_PD_AND_RD = "exists(M-002.PD) and exists(M-002.RD)"


def resolver(values: dict[tuple[str, str], object]) -> dsl.Resolve:
    return lambda ref: values.get((ref.param, ref.stage), dsl.MISSING)


def truth(text: str, **values: object) -> bool | None:
    """Вычисление правила: ``M_002_PD=3009.4`` задаёт значение M-002 в стадии ПД."""
    place: dict[tuple[str, str], object] = {}
    for name, value in values.items():
        param, _, stage = name.rpartition("_")
        place[(param.replace("_", "-"), stage)] = value
    return dsl.truth(dsl.parse(text), resolver(place))


def test_parses_the_two_rules_from_the_task() -> None:
    assert str(dsl.parse("exists(M-055.PD)")) == "exists(M-055.PD)"
    assert str(dsl.parse(VALUE_IN_PD_AND_RD)) == "exists(M-002.PD) and exists(M-002.RD)"
    assert str(dsl.parse("M-002.RD == M-002.PD")) == "M-002.RD == M-002.PD"


def test_refs_list_every_referenced_value() -> None:
    node = dsl.parse("not (exists(M-055.PD) or M-002.RD > 10)")
    assert dsl.refs(node) == {dsl.Ref("M-055", "PD"), dsl.Ref("M-002", "RD")}


@pytest.mark.parametrize(
    "text",
    [
        "",
        "   ",
        "M-002.PD ==",
        "M-002.PD + 1",
        "exists(M-002)",
        "exists(M-002.ПД)",
        "and",
        "(M-002.PD == 1",
        "M-002.PD == 1)",
        "__import__('os').system('rm -rf /')",
        "M-002.PD == 1; drop table checks",
    ],
)
def test_broken_text_raises_instead_of_running_anything(text: str) -> None:
    with pytest.raises(dsl.RuleSyntaxError):
        dsl.parse(text)


def test_exists_and_missing_are_always_definite() -> None:
    assert truth("exists(M-002.PD)", M_002_PD=3009.4) is True
    assert truth("exists(M-002.PD)") is False
    assert truth("missing(M-002.RD)", M_002_PD=3009.4) is True


def test_comparison_without_a_value_is_unknown() -> None:
    """Нет значения — нет вывода: правило молчит, а не считает расхождение доказанным."""
    assert truth("M-002.RD == M-002.PD", M_002_PD=3009.4) is dsl.UNKNOWN


def test_kleene_logic() -> None:
    assert truth("exists(M-002.PD) and M-002.RD == 1") is False  # ложь and неизвестно — ложь
    assert truth("exists(M-002.PD) or M-002.RD == 1", M_002_PD=1.0) is True
    assert truth("exists(M-002.PD) and M-002.RD == 1", M_002_PD=1.0) is dsl.UNKNOWN
    assert truth("not M-002.RD == 1") is dsl.UNKNOWN


def test_numbers_compare_with_tolerance_and_russian_decimals() -> None:
    assert truth("M-002.RD == M-002.PD", M_002_PD=3009.4, M_002_RD=3009.4000000001) is True
    assert truth("M-002.RD > M-002.PD", M_002_PD=3009.4, M_002_RD=3030.0) is True
    assert dsl.compare("==", "3 009,4", 3009.4) is True


def test_strings_compare_without_case_and_spaces() -> None:
    assert truth("M-055.RD == M-055.PD", M_055_PD="B30", M_055_RD=" b30 ") is True
    assert truth("M-055.RD == M-055.PD", M_055_PD="B30", M_055_RD="B25") is False


def test_incomparable_types_are_unknown_not_an_error() -> None:
    assert truth("M-055.RD > M-055.PD", M_055_PD="B30", M_055_RD="B25") is dsl.UNKNOWN
    assert truth("M-055.RD == M-055.PD", M_055_PD=True, M_055_RD="B25") is False
    assert truth("M-055.RD > M-055.PD", M_055_PD=True, M_055_RD=1.0) is dsl.UNKNOWN


def test_literals_and_parentheses() -> None:
    assert truth("M-055.PD == 'B30'", M_055_PD="B30") is True
    assert truth('M-055.PD == "B30"', M_055_PD="B25") is False
    assert truth("(exists(M-002.PD) or exists(M-002.RD)) and not exists(M-002.ID)", M_002_PD=1.0) is True
    assert truth("true") is True
    assert truth("not false") is True
