"""Геометрия bbox (REQ-PRS-06): нормализация, повороты, смещённый CropBox.

Точность — 0.01 доли страницы: этого достаточно, чтобы подсветка в UI попадала в нужное место.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest

from inspector_ml.geometry import bbox_area, normalize_bbox
from inspector_ml.ingest.pdf import parse_pdf

TOLERANCE = 0.01


def test_normalize_bbox_basic() -> None:
    assert normalize_bbox((0, 0, 100, 200), (0, 0, 400, 600)) == pytest.approx([0.0, 0.0, 0.25, 1 / 3], abs=1e-6)


def test_normalize_bbox_clamps_and_orders() -> None:
    """Координаты за пределами страницы обрезаются, перевёрнутые — упорядочиваются."""
    assert normalize_bbox((-50, 700, 500, 100), (0, 0, 400, 600)) == pytest.approx([0.0, 1 / 6, 1.0, 1.0], abs=1e-6)


def test_normalize_bbox_respects_page_origin() -> None:
    """Страница может начинаться не в нуле — отсчёт идёт от её левого верхнего угла."""
    assert normalize_bbox((120, 130, 220, 230), (20, 30, 420, 630)) == pytest.approx(
        [0.25, 1 / 6, 0.5, 1 / 3], abs=1e-6
    )


def test_normalize_bbox_degenerate_page() -> None:
    assert normalize_bbox((0, 0, 10, 10), (0, 0, 0, 0)) == [0.0, 0.0, 0.0, 0.0]


def test_bbox_area() -> None:
    assert bbox_area([0.1, 0.2, 0.3, 0.7]) == pytest.approx(0.1)


def _expected_after_rotation(bbox: list[float], rotation: int) -> list[float]:
    """Куда уезжает нормализованный bbox при повороте страницы по часовой стрелке."""
    x0, y0, x1, y1 = bbox
    if rotation == 90:
        return [1 - y1, x0, 1 - y0, x1]
    if rotation == 180:
        return [1 - x1, 1 - y1, 1 - x0, 1 - y0]
    if rotation == 270:
        return [y0, 1 - x1, y1, 1 - x0]
    return bbox


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_rotation_moves_bbox(make_pdf: Callable[..., Path], rotation: int) -> None:
    """PyMuPDF отдаёт координаты текста в неповёрнутой системе — парсер обязан их развернуть."""
    straight = parse_pdf(make_pdf("rot0.pdf"), "sha", "test")["pages"][0]
    parsed = parse_pdf(make_pdf(f"rot{rotation}.pdf", rotation=rotation), "sha", "test")
    page = parsed["pages"][0]

    assert page["rotation"] == rotation
    if rotation in (90, 270):
        assert (page["width_pt"], page["height_pt"]) == (600.0, 400.0)
    else:
        assert (page["width_pt"], page["height_pt"]) == (400.0, 600.0)

    expected = _expected_after_rotation(straight["blocks"][0]["bbox"], rotation)
    assert page["blocks"][0]["bbox"] == pytest.approx(expected, abs=TOLERANCE)


def test_cropbox_shifts_origin(make_pdf: Callable[..., Path]) -> None:
    """Смещённый CropBox: bbox считается от видимой области, а не от MediaBox."""
    parsed = parse_pdf(make_pdf("crop.pdf", cropbox=(20, 30, 380, 570)), "sha", "test")
    page = parsed["pages"][0]

    assert (page["width_pt"], page["height_pt"]) == (360.0, 540.0)
    x0, y0 = page["blocks"][0]["bbox"][:2]
    # текст в (40, 60) MediaBox → (20, 30) внутри CropBox → 20/360 и (30 - высота шрифта)/540
    assert x0 == pytest.approx(20 / 360, abs=TOLERANCE)
    assert y0 == pytest.approx(17.1 / 540, abs=TOLERANCE)


def test_all_bboxes_inside_page(make_pdf: Callable[..., Path]) -> None:
    parsed = parse_pdf(make_pdf("multi.pdf", pages=3, rotation=270), "sha", "test")

    for page in parsed["pages"]:
        for block in page["blocks"]:
            x0, y0, x1, y1 = block["bbox"]
            assert 0.0 <= x0 <= x1 <= 1.0
            assert 0.0 <= y0 <= y1 <= 1.0
