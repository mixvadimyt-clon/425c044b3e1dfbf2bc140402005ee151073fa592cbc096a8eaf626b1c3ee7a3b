"""OCR для страниц без текстового слоя.

Основной движок — PaddleOCR (кириллица), запасной — Tesseract. Оба ставятся через extra `ocr`
и подключаются по имени из `OCR_ENGINE`; если движка нет, конвейер работает без OCR.
"""

from inspector_ml.ocr.base import OcrEngine, OcrLine, OcrOptions
from inspector_ml.ocr.engines import available_engines, build_engine
from inspector_ml.ocr.page import PageOcr, recognize_page

__all__ = [
    "OcrEngine",
    "OcrLine",
    "OcrOptions",
    "PageOcr",
    "available_engines",
    "build_engine",
    "recognize_page",
]
