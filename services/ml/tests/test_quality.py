"""Классификатор страниц: вид листа и пригодность текстового слоя."""

from __future__ import annotations

import pytest

from inspector_ml.quality.page_classifier import PageSignals, classify, needs_ocr


def signals(**overrides: float) -> PageSignals:
    base = {
        "chars": 1500,
        "blocks": 20,
        "width_pt": 595.0,
        "height_pt": 842.0,
        "image_area_ratio": 0.0,
        "content_bytes": 5_000,
    }
    base.update(overrides)
    return PageSignals(**base)  # type: ignore[arg-type]


def test_text_page() -> None:
    assert classify(signals()) == ("text", "OK")


def test_scan_needs_ocr() -> None:
    """Скан акта: растр на весь лист, текста нет."""
    kind, quality = classify(signals(chars=0, blocks=0, image_area_ratio=0.98, content_bytes=2_500))

    assert (kind, quality) == ("scan", "LOW_QUALITY")
    assert needs_ocr(quality) is True


def test_large_sheet_is_drawing() -> None:
    kind, _ = classify(signals(width_pt=2384.0, height_pt=1684.0))

    assert kind == "drawing"


def test_dense_vector_page_is_drawing() -> None:
    """A4 с тяжёлым потоком отрисовки — тоже чертёж (узел, схема)."""
    kind, _ = classify(signals(content_bytes=500_000))

    assert kind == "drawing"


def test_scanned_drawing_counts_as_scan() -> None:
    """Скан чертежа читать нечем: OCR важнее, чем то, что это чертёж."""
    kind, quality = classify(signals(chars=0, image_area_ratio=0.9, width_pt=2384.0, height_pt=1684.0))

    assert (kind, quality) == ("scan", "LOW_QUALITY")


def test_empty_page_abstains() -> None:
    """Пустой странице OCR не поможет — это ABSTAIN, а не LOW_QUALITY."""
    kind, quality = classify(signals(chars=0, blocks=0, content_bytes=100))

    assert quality == "ABSTAIN"
    assert needs_ocr(quality) is False
    assert kind == "text"


@pytest.mark.parametrize(("chars", "expected"), [(0, "LOW_QUALITY"), (5, "LOW_QUALITY"), (10, "OK"), (200, "OK")])
def test_text_threshold(chars: int, expected: str) -> None:
    """Порог 10 символов подобран по разметке организаторов (см. docstring модуля).

    Страница без текста, но с графикой — это `LOW_QUALITY` (её заберёт OCR), а не `ABSTAIN`.
    """
    _kind, quality = classify(signals(chars=chars, content_bytes=5_000))

    assert quality == expected
