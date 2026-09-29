"""Качество страниц: вид листа и пригодность текстового слоя для извлечения."""

from inspector_ml.quality.page_classifier import PageSignals, classify, needs_ocr, page_kind, page_quality

__all__ = ["PageSignals", "classify", "needs_ocr", "page_kind", "page_quality"]
