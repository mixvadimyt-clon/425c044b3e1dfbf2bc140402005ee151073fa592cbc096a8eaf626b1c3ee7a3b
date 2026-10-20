"""Проверка настоящего движка OCR на синтетической странице.

Тест пропускается, если extra `ocr` не установлен (так и в CI: там ставится только базовый набор).
При первом запуске PaddleOCR скачивает веса, поэтому тест медленный — включается переменной
`ML_TEST_OCR=1`, чтобы не тормозить обычный прогон.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from pathlib import Path

import pymupdf
import pytest

from conftest import cyrillic_font
from inspector_ml.eval.ocr_metrics import character_accuracy, normalize
from inspector_ml.ocr.base import OcrOptions
from inspector_ml.ocr.engines import available_engines, build_engine
from inspector_ml.ocr.page import recognize_page

pytestmark = [
    pytest.mark.skipif(
        not available_engines() or os.environ.get("ML_TEST_OCR") != "1",
        reason="нужен extra ocr и ML_TEST_OCR=1 (тест скачивает веса и работает секунды)",
    ),
    pytest.mark.skipif(
        cyrillic_font() is None,
        reason="нет системного шрифта с кириллицей — распознавать будет нечего",
    ),
]

TEXT = "Класс бетона B25 Экспликация помещений"


def test_engine_reads_russian_text(make_pdf: Callable[..., Path]) -> None:
    """Движок читает кириллицу и обозначения классов бетона.

    Класс бетона принимается в любом алфавите: OCR уверенно читает латинскую «B» в «B25»
    как кириллическую «В» — они выглядят одинаково. Приводить к латинице будет
    нормализация значений, а не движок.
    """
    path = make_pdf("ru.pdf", text=TEXT, width=900, height=300)
    document = pymupdf.open(path)
    engine = build_engine("paddle")
    assert engine is not None

    result = recognize_page(document[0], 1, OcrOptions(engine=engine, dpi=200, max_px=2000))

    assert result is not None
    recognized = normalize(" ".join(block["text"] for block in result.blocks))
    assert "b25" in recognized or "в25" in recognized
    assert "экспликация" in recognized
    assert character_accuracy(TEXT, recognized) > 0.6
    assert result.mean_confidence > 0.5
