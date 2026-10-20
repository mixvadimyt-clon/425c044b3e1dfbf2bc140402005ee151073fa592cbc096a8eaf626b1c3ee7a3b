"""Сопоставление экземпляров правила между стадиями: точное и нестрогое."""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from inspector_ml import contracts

if not contracts.is_generated():  # pragma: no cover — CI всегда выполняет uv run gen
    pytest.skip("сначала выполните uv run gen", allow_module_level=True)

from inspector_ml.compare.keys import rule_group
from inspector_ml.compare.matching import group, same_word, similarity


@dataclass(frozen=True)
class Point:
    """Минимальная замена Extraction: сопоставлению нужны только ключ и стадия."""

    stage: str
    rule_key: str | None


def keys(points: list[Point]) -> list[set[str | None]]:
    groups = group(points, lambda p: p.stage)
    return sorted((({p.rule_key for p in g}) for g in groups), key=lambda s: sorted(map(str, s)))


def test_identical_points_are_matched_exactly() -> None:
    points = [Point("PD", "Помещение 1-09"), Point("RD", "пом. 1.09")]
    assert keys(points) == [{"Помещение 1-09", "пом. 1.09"}]


def test_wording_differences_are_matched_by_rapidfuzz() -> None:
    points = [Point("PD", "стены в грунте"), Point("RD", "стена в грунте")]
    assert keys(points) == [{"стены в грунте", "стена в грунте"}]


def test_different_numbers_stay_separate() -> None:
    """«пом. 1.09» и «пом. 1.10» похожи на 95 % как строки, но это разные помещения."""
    points = [Point("PD", "пом. 1.09"), Point("RD", "пом. 1.10")]
    assert keys(points) == [{"пом. 1.09"}, {"пом. 1.10"}]


def test_same_number_with_unrelated_wording_stays_separate() -> None:
    points = [Point("PD", "этаж 1"), Point("RD", "пом. 1")]
    assert keys(points) == [{"пом. 1"}, {"этаж 1"}]


def test_bare_number_matches_named_point() -> None:
    points = [Point("PD", "1.09"), Point("RD", "пом. 1.09")]
    assert keys(points) == [{"1.09", "пом. 1.09"}]


def test_points_of_one_stage_are_never_merged() -> None:
    """Два похожих ключа внутри ПД — две разные контрольные точки, а не одна."""
    points = [Point("PD", "стены в грунте"), Point("PD", "стена в грунте")]
    assert keys(points) == [{"стена в грунте"}, {"стены в грунте"}]


def test_missing_key_is_its_own_group() -> None:
    points = [Point("PD", None), Point("RD", None), Point("RD", "пом. 1.09")]
    assert keys(points) == [{None}, {"пом. 1.09"}]


@pytest.mark.parametrize(
    ("left", "right", "matched"),
    [
        ("стены в грунте", "стена в грунте", True),
        ("фундаментная плита", "вертикальные конструкции", False),
        ("пом. 1.09", "пом. 1.09", True),
        ("пом. 1.09", "пом. 1.10", False),
        ("пом. 1.09", "кладовая 1.09", False),
        ("1.09", "пом. 1.09", True),
        # у ключа с номером один вариант может быть подробнее: номер уже опознал точку
        ("экспликация помещений 1 этажа", "экспликация 1 этажа", True),
    ],
)
def test_similarity_pairs(left: str, right: str, matched: bool) -> None:
    assert (similarity(left, right) is not None) is matched


@pytest.mark.parametrize(
    ("left", "right"),
    [
        ("Вертикальные конструкции подземной части", "Вертикальные конструкции надземной части"),
        ("Вертикальные конструкции подземной части", "Вертикальные конструкции наземной части"),
        ("пом. 1.09 подземной части", "пом. 1.09 надземной части"),
        ("Перекрытие над подвалом", "Перекрытие под подвалом"),
    ],
)
def test_opposing_qualifiers_never_merge(left: str, right: str) -> None:
    """Отличие в одну букву в начале слова меняет смысл: классы бетона разных частей — разные точки.

    Сравнение строк целиком давало этой паре 95 % и сливало точки, выдавая кандидата на нарушение,
    которого нет (нашлось при разборе ключей M-055).
    """
    assert similarity(rule_group(left), rule_group(right)) is None
    assert keys([Point("PD", left), Point("RD", right)]) == sorted([{left}, {right}], key=lambda s: sorted(s))


@pytest.mark.parametrize(
    ("left", "right", "same"),
    [
        ("стены", "стена", True),
        ("фундаментная", "фундамента", True),
        ("спецификацня", "спецификация", True),
        ("подземной", "надземной", False),
        ("перекрытие", "перегородка", False),
        ("этаж", "пом", False),
    ],
)
def test_same_word(left: str, right: str, same: bool) -> None:
    assert same_word(left, right) is same


@pytest.mark.parametrize(
    ("left", "right"),
    [
        ("ось А", "ось Б"),
        ("секция А", "секция Б"),
        ("ось А 1", "ось Б 1"),
        ("блок В", "блок Г"),
    ],
)
def test_single_letter_names_never_merge(left: str, right: str) -> None:
    """Буква — всё содержание имени оси, секции и литеры, поэтому сравниваем её только точно.

    Порог «сколько первых букв совпало» для слова из одной буквы вырождался в ноль, и «ось А»
    сливалась с «осью Б» на 100 %. Моя же регрессия из правки про «подземную/надземную часть»,
    нашлась на внешнем ревью 2026-09-20.
    """
    assert similarity(rule_group(left), rule_group(right)) is None
    assert keys([Point("PD", left), Point("RD", right)]) == sorted([{left}, {right}], key=lambda s: sorted(s))


@pytest.mark.parametrize(
    ("left", "right", "same"),
    [
        ("а", "б", False),
        ("а", "а", True),
        ("ос", "об", False),
        ("ось", "оси", True),
        ("на", "над", False),
    ],
)
def test_short_words_compare_exactly(left: str, right: str, same: bool) -> None:
    assert same_word(left, right) is same
