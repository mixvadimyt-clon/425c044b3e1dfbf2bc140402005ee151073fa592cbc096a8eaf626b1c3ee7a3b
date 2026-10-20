"""Офлайн-оценка качества (§14)."""

from inspector_ml.eval.ocr_metrics import cer, character_accuracy, evaluate_pdf, normalize, wer

__all__ = ["cer", "character_accuracy", "evaluate_pdf", "normalize", "wer"]
