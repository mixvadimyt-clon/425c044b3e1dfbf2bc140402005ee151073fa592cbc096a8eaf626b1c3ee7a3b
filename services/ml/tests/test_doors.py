"""M-041 «Ширина эвакуационных выходов (дверей)» — `extract/doors.py`.

Фразы и строки спецификаций взяты из обучающих объектов (Новослободская, Алтуфьевское, «Пример
нарушений»): пояснительные записки, ПБ, спецификации заполнения проёмов РД.
"""

from __future__ import annotations

import pytest

from inspector_ml.extract import doors
from inspector_ml.extract.api import extractor_for
from inspector_ml.matrix import load_params


@pytest.fixture(scope="module")
def param():
    return load_params()["M-041"]


def text_page(text: str, number: int = 1) -> dict:
    return {"page": number, "blocks": [{"id": "b0", "type": "text", "text": text, "bbox": [0.1, 0.1, 0.9, 0.2]}]}


def cell(text: str, row: int, col: int, top: float) -> dict:
    left = 0.2 + 0.08 * col
    return {"row": row, "col": col, "text": text, "bbox": [left, top, left + 0.06, top + 0.012]}


def schedule_page(rows: list[tuple[str, str, str, str]], *, sections: dict[int, str] | None = None) -> dict:
    """Спецификация проёмов: шапка «Высота / Ширина», строки (позиция, наименование, высота, ширина).

    Наименование и заголовки разделов — текстовыми блоками, как их чаще всего и отдаёт разбор.
    """
    cells = [cell("Поз.", 0, 0, 0.10), cell("Высота Ширина Масса", 0, 6, 0.10), cell("проема проема", 1, 6, 0.113)]
    blocks = []
    for index, (position, name, height, width) in enumerate(rows):
        top = 0.20 + 0.04 * index
        cells += [cell(position, index + 2, 0, top), cell(height, index + 2, 6, top), cell(width, index + 2, 7, top)]
        blocks.append({"id": f"n{index}", "type": "text", "text": name, "bbox": [0.3, top, 0.6, top + 0.012]})
    for index, title in (sections or {}).items():
        top = 0.20 + 0.04 * index - 0.02
        blocks.append({"id": f"s{index}", "type": "text", "text": title, "bbox": [0.3, top, 0.5, top + 0.012]})
    return {"page": 14, "blocks": blocks, "tables": [{"id": "t0", "cells": cells}]}


def widths(param, pages: list[dict]) -> list[float]:
    return [found.value for found in doors.extract(param, pages)]


class TestText:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("Ширина выходов из подземной автостоянки в лестничные клетки принята 1,0 м в соответствии с СТУ ПБ.", 1.0),
            ("Эвакуация из пищеблока происходит через выход (Exit_07) по оси 18, ширина выхода 0,8 м.", 0.8),
            ("Ширина эвакуационного выхода из зала предусмотрена 1200 мм.", 1.2),  # миллиметры
            ("Ширина двери эвакуационного выхода — 90 см.", 0.9),
            (
                "3,6 м / 6 = 0,6 м - требуемая ширина эвакуационного выхода, но не менее 1,2 м - "
                "фактическая ширина выхода 1,5 м.",
                1.5,
            ),
        ],
    )
    def test_found(self, param, text: str, expected: float) -> None:
        assert widths(param, [text_page(text)]) == [expected]

    @pytest.mark.parametrize(
        "text",
        [
            # лифт: дверной проём кабины — не эвакуационный выход, и 800 — миллиметры, а не метры
            "Размер кабины лифта 1100×2100 мм с шириной дверного проема 800 мм, выход на этаж.",
            # вентиляция рядом со словом «выход»
            "Гибкие вставки, ширина*высота=1600*800 мм Вход/выход: воздушный клапан.",
            # цитата СП — требование, а не решение проекта
            "Ширина (в свету) проемов входных дверей должна быть не менее 1,2 м.",
            "Ширина марша 1,4 м, ширина выхода из лестничной клетки наружу по ширине марша.",
            "Ширина дверей 900 мм.",  # без пути эвакуации — неизвестно, какие двери
        ],
    )
    def test_not_an_evacuation_exit(self, param, text: str) -> None:
        assert widths(param, [text_page(text)]) == []


class TestSchedule:
    def test_evacuation_doors_only(self, param) -> None:
        page = schedule_page(
            [
                ("Д-6", "противопожарная, стальная, EI 60", "2100", "1300"),
                ("Д-8", "противопожарная с пределом огнестойкости EI 30", "2100", "900"),
                ("Д-11", "дверь деревянная в санузел", "2100", "700"),  # не на пути эвакуации
            ]
        )

        [found] = doors.extract(param, [page])

        assert found.value == 0.9
        assert found.raw_value == "0,9 м; 1,3 м"  # санузел в список не попал
        assert found.rule_key == "Эвакуационный выход"
        assert found.method == "table"

    def test_section_header_marks_evacuation_doors(self, param) -> None:
        """«Витражные двери» — заголовок раздела над строками; в самих строках про эвакуацию ни слова."""
        page = schedule_page(
            [("Д-1", "дверь металлическая, распашная, двупольная", "2040", "2000")],
            sections={0: "Витражные двери"},
        )

        assert widths(param, [page]) == [2.0]

    def test_height_before_width_in_header(self, param) -> None:
        """Ширина — второе из двух размеров строки, потому что в шапке «высота» стоит раньше «ширины»."""
        page = schedule_page([("Д-2", "дверь наружная автоматическая", "2040", "2600")])

        assert widths(param, [page]) == [2.6]


def test_one_value_per_document_the_narrowest(param) -> None:
    pages = [
        text_page("Ширина выходов из подземной автостоянки в лестничные клетки принята 1,0 м.", 1),
        text_page("Эвакуация из пищеблока через выход по оси 18, ширина выхода 0,8 м.", 2),
    ]

    [found] = doors.extract(param, pages)

    assert (found.value, found.page, found.raw_value) == (0.8, 2, "0,8 м; 1 м")


def test_registered_for_m041() -> None:
    assert extractor_for("M-041") is doors.extract
