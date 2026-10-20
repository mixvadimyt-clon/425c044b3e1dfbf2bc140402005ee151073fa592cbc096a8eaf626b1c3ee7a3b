"""Тип фрагмента под областью различия (рецензия экспертов 17.10, п. 5): таблица, текст, штамп или чертёж."""

from __future__ import annotations

import cv2
import numpy as np
import pytest

from inspector_ml.suspicion import fragments

PX_PER_MM = 6.0  # 150 dpi


def blank(width: int = 600, height: int = 240) -> np.ndarray:
    return np.full((height, width, 3), 255, np.uint8)


def write(image: np.ndarray, rows: int, top: int = 30, step: int = 40) -> np.ndarray:
    """Строки мелкого текста высотой около 2,5 мм."""
    for row in range(rows):
        cv2.putText(
            image, "Exhaust unit 450 m3/h", (20, top + row * step), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 1
        )
    return image


def grid(image: np.ndarray, rows: int = 5, columns: tuple[int, ...] = (5, 200, 400, 594)) -> np.ndarray:
    height, width = image.shape[:2]
    for k in range(rows + 1):
        y = min(height - 1, 5 + k * (height - 10) // rows)
        cv2.line(image, (5, y), (width - 6, y), (0, 0, 0), 1)
    for x in columns:
        cv2.line(image, (x, 5), (x, height - 6), (0, 0, 0), 1)
    return image


class TestClassify:
    def test_table_is_a_grid(self) -> None:
        assert fragments.classify(write(grid(blank()), 5, top=32, step=46), PX_PER_MM) == fragments.TABLE

    def test_note_is_text(self) -> None:
        assert fragments.classify(write(blank(), 5), PX_PER_MM) == fragments.TEXT

    def test_drawing_lines_are_a_drawing(self) -> None:
        image = blank()
        rng = np.random.default_rng(3)
        for _ in range(12):
            points = rng.integers(0, [600, 240], size=(4, 2)).astype(np.int32)
            cv2.polylines(image, [points], False, (0, 0, 0), 3)
        assert fragments.classify(image, PX_PER_MM) == fragments.DRAWING

    def test_plan_needs_a_strict_grid(self) -> None:
        """Две стены и две размерные линии на плане — ещё не таблица; строгая сетка из многих линий — таблица."""
        walls = grid(blank(), rows=1, columns=(5, 594))
        assert fragments.classify(walls, PX_PER_MM) == fragments.TABLE
        assert fragments.classify(walls, PX_PER_MM, drawing_sheet=True) != fragments.TABLE
        assert fragments.classify(grid(blank(), rows=5), PX_PER_MM, drawing_sheet=True) == fragments.TABLE

    def test_empty_region_is_a_drawing(self) -> None:
        assert fragments.classify(np.zeros((0, 0, 3), np.uint8), PX_PER_MM) == fragments.DRAWING


class TestStamp:
    ZONE = fragments.stamp_zone(2384.0, 1684.0)  # A1: 841 × 594 мм

    def test_zone_is_the_stamp_corner(self) -> None:
        assert pytest.approx((1 - 195 / 841, 1 - 65 / 594, 1.0, 1.0), abs=1e-3) == self.ZONE

    def test_region_in_the_stamp_is_dropped(self) -> None:
        assert fragments.outside_stamp((0.8, 0.92, 0.95, 0.98), self.ZONE) is None

    def test_note_above_the_stamp_is_cut_at_its_edge(self) -> None:
        """«Тюменская 5», РД стр. 15: примечание над штампом и край штампа — одна область; штамп отрезается."""
        x0, y0, x1, y1 = fragments.outside_stamp((0.78, 0.86, 0.96, 0.9), self.ZONE)
        assert (x0, y0, x1) == (0.78, 0.86, 0.96) and y1 == pytest.approx(self.ZONE[1])

    def test_region_elsewhere_is_kept(self) -> None:
        assert fragments.outside_stamp((0.1, 0.1, 0.3, 0.2), self.ZONE) == (0.1, 0.1, 0.3, 0.2)


@pytest.mark.parametrize(
    ("names", "kind"),
    [
        (["План 1 этажа. Вентиляция"], fragments.PLAN),
        (["Ситуационный план, М 1:2000"], fragments.PLAN),
        (["Схема систем П1, В1"], fragments.SCHEME),
        (["Разрез 1-1"], fragments.SECTION),
        (["Спецификация оборудования"], fragments.TABLE),
        (["Ведомость деталей", "План"], fragments.TABLE),
        (["штамп", ""], None),
    ],
)
def test_sheet_kind_by_name(names: list[str], kind: str | None) -> None:
    assert fragments.sheet_kind(names) == kind
