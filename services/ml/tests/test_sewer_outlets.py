"""M-074 «Диаметры выпусков и магистралей К1/К2» — `extract/sewer_outlets.py`.

Подписи и фразы — из обучающих объектов (ИОС3, ВК, сводные планы сетей) и из пары ИОС3.2 со стенда.
"""

from __future__ import annotations

import pytest

from inspector_ml.extract import sewer_outlets
from inspector_ml.extract.api import extractor_for
from inspector_ml.matrix import load_params


@pytest.fixture(scope="module")
def param():
    return load_params()["M-074"]


def page(*texts: str, number: int = 1) -> dict:
    blocks = [
        {"id": f"b{i}", "type": "text", "text": text, "bbox": [0.1, 0.1 + 0.05 * i, 0.5, 0.13 + 0.05 * i]}
        for i, text in enumerate(texts)
    ]
    return {"page": number, "blocks": blocks}


def diameters(param, *pages: dict) -> dict[str, float]:
    return {found.rule_key: found.value for found in sewer_outlets.extract(param, list(pages))}


def test_plan_labels_without_numbers(param) -> None:
    found = sewer_outlets.extract(param, [page("Выпуск К1 Ø110", "Выпуск К2 Ø250", "Выпуск К2 Ø50")])

    assert {f.rule_key: (f.value, f.raw_value) for f in found} == {
        "Выпуски К1": (110.0, "Ø110"),
        "Выпуски К2": (250.0, "Ø250, Ø50"),
    }


def test_numbered_outlets_in_both_notations(param) -> None:
    """«1-К1» на сводном плане и «К1-1» на плане подвала — один выпуск."""
    labels = page(
        "Выпуск 1-К1 ∅160 в футл., Отм.низ.тр. 163.30",
        "Выпуск К1-2 ∅110",
        "∅200 Выпуск К2-6",
        "Выпуск дождевой канализации К 2-2 ф200, L-4.10",
    )

    assert diameters(param, labels) == {
        "Выпуск К1-1": 160.0,
        "Выпуск К1-2": 110.0,
        "Выпуск К2-6": 200.0,
        "Выпуск К2-2": 200.0,
    }


def test_label_split_over_two_lines(param) -> None:
    assert diameters(param, page("Выпуск бытовой", "канализации К1-1 Ф100, L-3.12")) == {"Выпуск К1-1": 100.0}


def test_explanatory_note(param) -> None:
    text = (
        "Данным проектом предусмотрено три выпуска полипропиленовых труб Д100 с системы К1, "
        "два выпуска полипропиленовых труб Д160 с системы К2."
    )

    assert diameters(param, page(text)) == {"Выпуски К1": 100.0, "Выпуски К2": 160.0}


def test_stand_pair_casing_is_not_the_outlet(param) -> None:
    """ИОС3.2 со стенда: Ø100 — выпуск, Ø325 — стальной футляр, в котором он проложен."""
    text = (
        "1. Устройство выпусков хозяйственно – бытовой канализации из труб ВЧШГ Ø100мм по ГОСТ ISO 2531-2022 "
        "с внутренним ЦПП. Трубопровод на выпусках прокладывается открытым способом работ в стальном футляре "
        "Ø325х7мм по ГОСТ 10704-91."
    )

    assert diameters(param, page(text)) == {"Выпуски К1": 100.0}


def test_storm_outlets_by_words(param) -> None:
    text = (
        "Водоотведение дождевых и талых вод с кровли здания осуществляется во внутриплощадочную сеть "
        "по выпускам из труб ВЧШГ диаметром 100, 150 и 200 мм ГОСТ ISO 2531-2012."
    )

    assert diameters(param, page(text)) == {"Выпуски К2": 200.0}


@pytest.mark.parametrize(
    "text",
    [
        "Ст К2-6 ⌀250х7.3",
        "К2 Хомут для трубы Ø110 шт. 100",
        "Сваи С90.40-5 по серии 1.011.1-10 выпуск 1 длиной 9 м",
        "На выпуске К4-1 от трапов в приямке предусматривается канализационный затвор ТП-85.100-К3Э.",
        "Высота выпускного патрубка, мм 1790",
        "Коллектор выпуска воды (напорный) Ду150",
    ],
)
def test_not_an_outlet_diameter(param, text: str) -> None:
    assert diameters(param, page(text)) == {}


def test_glued_table_row_is_split_by_label(param) -> None:
    """Детектор таблиц склеивает подписи чертежа в одну строку — каждая подпись со своим диаметром."""
    cells = [
        {"row": 0, "col": 0, "text": "Выпуск 3-К2 ∅160", "bbox": [0.1, 0.1, 0.3, 0.12]},
        {"row": 0, "col": 1, "text": "Выпуск 2-К1 ∅110", "bbox": [0.5, 0.1, 0.7, 0.12]},
    ]
    table = {"page": 3, "blocks": [], "tables": [{"id": "t0", "cells": cells}]}

    assert diameters(param, table) == {"Выпуск К2-3": 160.0, "Выпуск К1-2": 110.0}


def test_registered_for_m074() -> None:
    assert extractor_for("M-074") is sewer_outlets.extract
