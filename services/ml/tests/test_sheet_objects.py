"""Объекты листа: изменённые подписи на совмещённой паре листов (шаг 2) и маска штампа.

Пример — разрез «Алтуфьевского, 79Б» (КР стр. 49 ↔ КЖ02 стр. 17): слой 280 → 300 мм, отметка −0.365 → −0.385, и
отметка в РД ниже на 0,009 листа — уехала вместе с утолщённым слоем.
"""

from __future__ import annotations

import pymupdf
import pytest

from inspector_ml.suspicion import sheet_objects, visual
from inspector_ml.suspicion.sheet_objects import SheetObject

IDENTITY = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]


def obj(text: str, x: float, y: float) -> SheetObject:
    kind = sheet_objects.kind_of(text)
    assert kind is not None, text
    return SheetObject(kind, text, (x - 0.004, y - 0.002, x + 0.004, y + 0.002))


def common(n: int = 12) -> list[SheetObject]:
    """Подписи, которые на обоих листах одинаковы: размеры по сетке."""
    return [obj(str(1000 + 100 * i), 0.1 + 0.06 * i, 0.2) for i in range(n)]


class TestKinds:
    @pytest.mark.parametrize(
        ("text", "kind"),
        [
            ("-0.365", "отметка"),
            ("+6.810", "отметка"),
            ("0,000", "отметка"),
            ("В25", "класс"),
            ("А500С", "класс"),
            ("Ø12", "диаметр"),
            ("Ду100", "диаметр"),
            ("500х300", "сечение"),
            ("280", "размер"),
            ("Л-8", "марка"),
            ("СВВ-3", "марка"),
            ("П2.1", "система"),
            ("В2", "система"),
            ("12", None),
            ("Примечание", None),
        ],
    )
    def test_kind_by_notation(self, text: str, kind: str | None) -> None:
        assert sheet_objects.kind_of(text) == kind


class TestChanges:
    def test_changed_label_in_place(self) -> None:
        left = [*common(), obj("280", 0.5, 0.5)]
        right = [*common(), obj("300", 0.5, 0.5)]

        [change] = sheet_objects.changes(left, right, IDENTITY)

        assert (change.kind, change.text) == ("размер", "280 → 300")

    def test_elevation_moves_with_the_layer(self) -> None:
        """Отметка «−0.385» ниже на 0,009 листа: для отметки это то же место, для размера — уже нет."""
        left = [*common(), obj("-0.365", 0.5, 0.5), obj("280", 0.7, 0.5)]
        right = [*common(), obj("-0.385", 0.5, 0.509), obj("300", 0.7, 0.509)]

        assert [c.text for c in sheet_objects.changes(left, right, IDENTITY)] == ["-0.365 → -0.385"]

    def test_moved_label_is_not_a_change(self) -> None:
        """«280» передвинули на 0,015 листа, а рядом с прежним местом стоит другой размер «300»."""
        left = [*common(), obj("280", 0.5, 0.5), obj("300", 0.5, 0.53)]
        right = [*common(), obj("280", 0.515, 0.5), obj("300", 0.503, 0.5)]

        assert sheet_objects.changes(left, right, IDENTITY) == []

    def test_homography_maps_right_sheet_onto_left(self) -> None:
        """Правый лист вдвое мельче и сдвинут: гомография переносит его подписи на места левого."""
        shrink = [2.0, 0.0, -0.2, 0.0, 2.0, -0.2, 0.0, 0.0, 1.0]  # правая точка (x, y) → левая (2x − 0,2, 2y − 0,2)
        left = [*common(), obj("280", 0.5, 0.5)]
        right = [
            SheetObject(o.kind, o.text, tuple((v + 0.2) / 2 for v in o.box))  # type: ignore[misc]
            for o in [*common(), obj("300", 0.5, 0.5)]
        ]

        assert [c.text for c in sheet_objects.changes(left, right, shrink)] == ["280 → 300"]

    def test_too_few_objects_means_no_comparison(self) -> None:
        """Растровая копия без текстового слоя против векторного листа: объектов на ней почти нет."""
        left = [*common(), obj("280", 0.5, 0.5)]
        right = [*common(3), obj("300", 0.5, 0.5)]

        assert sheet_objects.changes(left, right, IDENTITY) == []

    def test_many_changes_mean_another_edition(self) -> None:
        """Изменилась четверть подписей — это другая редакция листа или съехавшая таблица."""
        left = [*common(), *(obj(str(200 + i), 0.1 + 0.06 * i, 0.6) for i in range(4))]
        right = [*common(), *(obj(str(300 + i), 0.1 + 0.06 * i, 0.6) for i in range(4))]

        assert sheet_objects.changes(left, right, IDENTITY) == []

    def test_objects_outside_the_shared_area_are_ignored(self) -> None:
        left = [*common(), obj("280", 0.5, 0.9)]
        right = [*common(), obj("300", 0.5, 0.9)]

        assert sheet_objects.changes(left, right, IDENTITY, right_area=(0.0, 0.0, 1.0, 0.8)) == []


def test_read_takes_words_outside_the_stamp() -> None:
    document = pymupdf.open()
    page = document.new_page(width=842, height=595)
    for x, text in ((100, "-0.365"), (200, "B25"), (300, "280"), (400, "Разрез"), (700, "2026")):
        page.insert_text((x, 300 if x < 700 else 560), text, fontsize=8)

    found = sheet_objects.read(page, exclude=[(0.75, 0.85, 1.0, 1.0)])

    assert [(o.kind, o.text) for o in found] == [("отметка", "-0.365"), ("класс", "В25"), ("размер", "280")]


def test_read_takes_cad_font_labels_from_ocr() -> None:
    """Подписи шрифтом САПР — из строк OCR листа: место слова в строке по доле символов, повтор слоя — один объект."""
    document = pymupdf.open()
    page = document.new_page(width=842, height=595)
    page.insert_text((100, 300), "280", fontsize=8)  # то же «280» есть и в текстовом слое
    x0, y0 = 100 / 842, (300 - 7) / 595
    ocr = [
        {"text": "280", "conf": 0.95, "bbox": [x0, y0, x0 + 0.02, y0 + 0.012]},
        {"text": "П2/ВЕ 500x300", "conf": 0.9, "bbox": [0.5, 0.2, 0.63, 0.21]},
        {"text": "В25", "conf": 0.4, "bbox": [0.5, 0.4, 0.52, 0.41]},  # неуверенная строка не берётся
    ]

    found = {(o.kind, o.text): o for o in sheet_objects.read(page, ocr=ocr)}

    assert set(found) == {("размер", "280"), ("сечение", "500х300")}
    section = found[("сечение", "500х300")].center
    assert section[0] == pytest.approx(0.5 + 0.13 * (6 + 13) / 2 / 13, abs=1e-6)  # вторая половина строки


A1 = {"width_pt": 2384.0, "height_pt": 1684.0}  # 841 × 594 мм


def block(*bbox: float, kind: str = "title_block") -> dict:
    return {"type": kind, "bbox": list(bbox), "text": "…"}


class TestStampMask:
    def test_table_above_the_stamp_is_not_masked(self) -> None:
        """Таблица над штампом с меткой «основная надпись» — содержание листа: закрашивается только штамп."""
        parsed = {**A1, "blocks": [block(0.8, 0.92, 0.98, 0.98), block(0.55, 0.66, 0.98, 0.9)]}

        [mask] = visual._stamp_masks(parsed)

        assert mask[0] == pytest.approx(0.795) and mask[1] == pytest.approx(0.915)

    def test_side_graphs_are_masked_separately(self) -> None:
        parsed = {**A1, "blocks": [block(0.8, 0.92, 0.98, 0.98), block(0.01, 0.6, 0.025, 0.98)]}

        assert len(visual._stamp_masks(parsed)) == 2

    def test_no_stamp_in_its_zone_masks_the_zone(self) -> None:
        """Метку штампа получили только строки таблицы через весь лист — закрашивается стандартная зона штампа."""
        parsed = {**A1, "blocks": [block(0.08, 0.7, 0.92, 0.72)]}

        [mask] = visual._stamp_masks(parsed)

        assert mask[0] == pytest.approx(1 - 195 / 841, abs=0.01) and mask[2] == 1.0

    def test_no_stamp_blocks_no_mask(self) -> None:
        assert visual._stamp_masks({**A1, "blocks": [block(0.1, 0.1, 0.2, 0.2, kind="text")]}) == []
