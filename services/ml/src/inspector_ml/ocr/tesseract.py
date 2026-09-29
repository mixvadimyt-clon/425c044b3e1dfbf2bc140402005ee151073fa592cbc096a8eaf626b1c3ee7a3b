"""Tesseract — запасной движок распознавания (`rus+eng`).

Нужен и сам бинарник Tesseract, и пакет `pytesseract`. Организаторы своей предразметке
помечали строки источником `TESSERACT_RUS_ENG_PAGE1`, так что движок уместен как запасной:
он слабее Paddle на чертежах, но не требует загрузки весов из сети.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from inspector_ml.logging import get_logger
from inspector_ml.ocr.base import OcrLine

log = get_logger(__name__)

LANG = "rus+eng"
MIN_CONFIDENCE = 0.0


class TesseractEngine:
    """Обёртка над `pytesseract.image_to_data`: строки собираются по номеру блока и строки."""

    name = "tesseract"

    def __init__(self, lang: str = LANG) -> None:
        self.lang = lang

    @staticmethod
    def available() -> bool:
        try:
            import pytesseract
        except ImportError:
            return False
        try:
            pytesseract.get_tesseract_version()
        except Exception:  # pragma: no cover — бинарника нет или он недоступен
            return False
        return True

    def recognize(self, image: np.ndarray) -> list[OcrLine]:
        import pytesseract

        data: dict[str, list[Any]] = pytesseract.image_to_data(
            image, lang=self.lang, output_type=pytesseract.Output.DICT
        )

        grouped: dict[tuple[int, int, int], list[tuple[str, float, tuple[int, int, int, int]]]] = {}
        for index, text in enumerate(data["text"]):
            word = (text or "").strip()
            if not word:
                continue
            confidence = float(data["conf"][index])
            if confidence < MIN_CONFIDENCE:
                continue
            key = (data["block_num"][index], data["par_num"][index], data["line_num"][index])
            box = (data["left"][index], data["top"][index], data["width"][index], data["height"][index])
            grouped.setdefault(key, []).append((word, confidence / 100.0, box))

        lines: list[OcrLine] = []
        for words in grouped.values():
            text = " ".join(word for word, _conf, _box in words)
            x0 = min(box[0] for _w, _c, box in words)
            y0 = min(box[1] for _w, _c, box in words)
            x1 = max(box[0] + box[2] for _w, _c, box in words)
            y1 = max(box[1] + box[3] for _w, _c, box in words)
            confidence = sum(conf for _w, conf, _b in words) / len(words)
            lines.append(OcrLine(text=text, bbox=(float(x0), float(y0), float(x1), float(y1)), confidence=confidence))
        return lines
