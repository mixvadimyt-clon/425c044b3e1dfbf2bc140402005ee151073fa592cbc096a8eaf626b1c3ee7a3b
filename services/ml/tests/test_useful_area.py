"""M-003 «Полезная / Расчётная площадь» здания — `extract/useful_area.py`.

Строки и фразы — из обучающих объектов: ТЭП пояснительных записок, раздел энергоэффективности РД,
ИОС2 (пожаротушение), ТХ, ООС.
"""

from __future__ import annotations

import pytest

from inspector_ml.extract import useful_area
from inspector_ml.extract.api import extractor_for
from inspector_ml.matrix import load_params


@pytest.fixture(scope="module")
def param():
    return load_params()["M-003"]


def text_page(text: str, number: int = 1) -> dict:
    return {"page": number, "blocks": [{"id": "b0", "type": "text", "text": text, "bbox": [0.1, 0.1, 0.9, 0.2]}]}


def table_page(rows: list[list[str]], number: int = 5) -> dict:
    cells = [
        {"row": r, "col": c, "text": text, "bbox": [0.1 + 0.2 * c, 0.1 + 0.03 * r, 0.28 + 0.2 * c, 0.12 + 0.03 * r]}
        for r, row in enumerate(rows)
        for c, text in enumerate(row)
    ]
    return {"page": number, "blocks": [], "tables": [{"id": "t0", "cells": cells}]}


def areas(param, pages: list[dict]) -> list[float]:
    return [found.value for found in useful_area.extract(param, pages)]


class TestTable:
    def test_tep_row(self, param) -> None:
        page = table_page([["Наименование", "Ед.", "Показатель"], ["Расчётная площадь здания", "м²", "8010,1"]])

        [found] = useful_area.extract(param, [page])

        assert (found.value, found.method, found.snippet) == (8010.1, "table", "Расчётная площадь здания — 8010,1")

    def test_thousands_with_space(self, param) -> None:
        page = table_page([["Расчетная площадь", "м2", "8 526,1"]])

        assert areas(param, [page]) == [8526.1]

    def test_per_seat_row_is_skipped(self, param) -> None:
        page = table_page([["Расчётная площадь на 1 место", "м²/место", "13,3"], ["Полезная площадь", "м²", "6 476,5"]])

        assert areas(param, [page]) == [6476.5]

    def test_table_beats_text(self, param) -> None:
        """Строка ТЭП в документе есть — фразы из текста не нужны."""
        pages = [table_page([["Расчетная площадь", "м2", "5559,7"]]), text_page("Полезная площадь здания 5600 м2.")]

        assert areas(param, pages) == [5559.7]


class TestText:
    def test_found_in_text(self, param) -> None:
        assert areas(param, [text_page("- расчетная площадь 5559,7 м2;")]) == [5559.7]

    def test_unit_digit_is_not_the_value(self, param) -> None:
        """«Ар, м2 8 526,1» — площадь 8 526,1, а не 2 из «м2»."""
        assert areas(param, [text_page("10 Расчетная площадь (общественных помещений) Ар, м2 8 526,1 -")]) == [8526.1]

    @pytest.mark.parametrize(
        "text",
        [
            "Расчётная площадь на 1 место, м²/место 13,3",
            "- минимальная расчетная площадь - 45 м2;",  # спринклерная секция
            "Суммарный расход на расчетной площади не менее Q = 27*6 + 120 = 282 л/мин.",
            "Принята расчетная площадь розлива: 0,25 м2",
            "F - полезная площадь склада, м2.",
            "расчётных площадок - 1 (узлов регулярной расчётной сетки 1681)",  # моделирование ООС
            "Расчетная площадка -200.00 50.00 400.00 50.00 600.00",
        ],
    )
    def test_not_building_area(self, param, text: str) -> None:
        assert areas(param, [text_page(text)]) == []


def test_same_value_once(param) -> None:
    pages = [table_page([["Расчетная площадь", "м2", "647"]], 1), table_page([["Расчетная площадь", "м2", "647"]], 2)]

    assert areas(param, pages) == [647.0]


def test_registered_for_m003() -> None:
    assert extractor_for("M-003") is useful_area.extract
