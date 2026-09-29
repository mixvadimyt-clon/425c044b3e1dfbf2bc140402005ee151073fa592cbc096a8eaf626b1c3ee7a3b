"""M-016 «Суточный расход водопотребления» — `extract/water_flow.py`.

Фразы и строки — из обучающих объектов (ИОС2, ИОС3, ВК, ИРД, ПОС) и из пары ИОС3.2 со стенда.
"""

from __future__ import annotations

import pytest

from inspector_ml.extract import water_flow
from inspector_ml.extract.api import extractor_for
from inspector_ml.matrix import load_params


@pytest.fixture(scope="module")
def param():
    return load_params()["M-016"]


def text_page(*texts: str, number: int = 1) -> dict:
    blocks = [
        {"id": f"b{i}", "type": "text", "text": text, "bbox": [0.1, 0.1 + 0.05 * i, 0.9, 0.14 + 0.05 * i]}
        for i, text in enumerate(texts)
    ]
    return {"page": number, "blocks": blocks}


def table_page(rows: list[list[str]], number: int = 2) -> dict:
    cells = [
        {"row": r, "col": c, "text": text, "bbox": [0.1 + 0.2 * c, 0.1 + 0.03 * r, 0.28 + 0.2 * c, 0.12 + 0.03 * r]}
        for r, row in enumerate(rows)
        for c, text in enumerate(row)
    ]
    return {"page": number, "blocks": [], "tables": [{"id": "t0", "cells": cells}]}


def flows(param, pages: list[dict]) -> dict[str, float]:
    return {found.rule_key: found.value for found in water_flow.extract(param, pages)}


class TestText:
    def test_stand_pair_balance(self, param) -> None:
        """ИОС3.2 со стенда: в РД это число поменяли, а регулярка матрицы его не видела."""
        page = text_page(
            "3. Расчётные расходы в соответствии с балансом водопотребления и водоотведения составят: "
            "Q = 123,576м3/сут.; q = 8,397 л/с."
        )

        [found] = water_flow.extract(param, [page])

        assert (found.rule_key, found.value, found.unit, found.method) == ("Водоотведение", 123.576, "м³/сут", "text")

    def test_total_and_hot_water(self, param) -> None:
        page = text_page(
            "Общий расход воды составляет: - общее водопотребление: 53,22 м3/сут, 26,07 м3/ч, 9,56 л/с, "
            "в т.ч. - горячее водоснабжение: 15,08 м3/сут, 8,32 м3/ч, 3,2 л/с"
        )

        assert flows(param, [page]) == {"Водопотребление": 53.22, "Горячее водоснабжение": 15.08}

    def test_consumer_share_is_not_a_total(self, param) -> None:
        """«в т.ч. столовая» — доля потребителя: итогом системы её не считаем."""
        page = text_page("в т.ч. столовая: - общее водопотребление: 12,4 м3/сут, 6,07 м3/ч, 2,56 л/с")

        assert flows(param, [page]) == {}

    def test_label_in_previous_block(self, param) -> None:
        page = text_page("Суммарный расчетный расход воды на здания", "106,95 м3/сут.")

        assert flows(param, [page]) == {"Водопотребление": 106.95}

    @pytest.mark.parametrize(
        "text",
        [
            "подключаемой нагрузки в точке подключения в размере 107,5 куб.м/сут;",
            "Разрешаемый отбор объема холодной воды на хозяйственно-бытовые нужды 81,57 м3/сут",
            "в точке 1 ___________ м3/сут (__________ м3/час)",
            "На технологические нужды предусмотрен расход 2м3/сут.",
            "решением по защите подземной части от подтопления составляет не более 1 м3/сут.",
            "Для бытового городка согласовывается общий расход питьевой воды в количестве 3,34 м3/сут.",
        ],
    )
    def test_not_a_building_flow(self, param, text: str) -> None:
        assert flows(param, [text_page(text)]) == {}

    def test_construction_page_is_skipped(self, param) -> None:
        page = text_page(
            "Потребность в воде на период строительства.",
            "Водоснабжение гор. водопровод: 71,28 м3/сут = 0,83 л/сек",
        )

        assert flows(param, [page]) == {}


class TestTable:
    HEADER = ("Система", "Напор на вводе, м", "м3/сут", "м3/ч", "л/с")

    def test_flow_table_of_vk(self, param) -> None:
        page = table_page(
            [
                list(self.HEADER),
                ["Хозяйственно-питьевой водопровод, В1", "0,30", "9,16", "1,85", "1,21"],
                ["В том числе, горячее водоснабжение, Т3", "", "0,52", "0,47", "0,3"],
                ["Противопожарное водоснабжение, В2", "0,25", "", "", "5,8"],
                ["Бытовая канализация, К1", "", "1,16", "0,85", "2,18"],
                ["Производственная канализация, К3", "", "8,00", "1,00", "0,63"],
                ["Водостоки, К2", "", "", "", "59,0"],
            ]
        )

        assert flows(param, [page]) == {"Водопотребление": 9.16, "Горячее водоснабжение": 0.52, "Водоотведение": 1.16}

    def test_system_code_only_and_notes_on_the_right(self, param) -> None:
        """ВК: подпись строки — одно «В1», правее — примечание к листу про дождевую канализацию."""
        page = table_page(
            [
                list(self.HEADER),
                ["В1", "", "8,85", "0,9", "0,5", "Система дождевой канализации предусматривает отведение стоков"],
            ]
        )

        [found] = water_flow.extract(param, [page])

        assert (found.rule_key, found.value, found.snippet) == ("Водопотребление", 8.85, "В1 — 8,85 м³/сут")

    def test_wrapped_row_label(self, param) -> None:
        page = table_page(
            [list(self.HEADER), ["Хозяйственно-питьевой"], ["водопровод, В1", "0,30", "9,16", "1,85", "1,21"]]
        )

        assert flows(param, [page]) == {"Водопотребление": 9.16}

    def test_label_with_unit_and_value_in_one_row(self, param) -> None:
        page = table_page([["Водопотребление, м3/сут", "106,95"]])

        assert flows(param, [page]) == {"Водопотребление": 106.95}


def test_largest_value_of_a_system_is_the_total(param) -> None:
    pages = [
        text_page("общее водопотребление: 53,22 м3/сут"),
        text_page("Расход воды на приготовление пищи — 12,4 м3/сут", number=2),
    ]

    assert flows(param, pages) == {"Водопотребление": 53.22}


def test_registered_for_m016() -> None:
    assert extractor_for("M-016") is water_flow.extract
