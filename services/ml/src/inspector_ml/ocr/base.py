"""Интерфейс OCR-движка и настройки распознавания.

Движок скрыт за протоколом: основной — PaddleOCR (кириллическая модель, Apache-2.0),
запасной — Tesseract. Конвейер обязан работать и без них: если extra `ocr` не установлен,
страницы без текстового слоя останутся `LOW_QUALITY`, но разбор не упадёт.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:  # pragma: no cover — только для подсказок типов
    import numpy as np

# Прямоугольник в пикселях отрендеренного изображения.
PixelBox = tuple[float, float, float, float]


@dataclass(frozen=True)
class OcrLine:
    """Одна распознанная строка."""

    text: str
    bbox: PixelBox
    confidence: float


class OcrEngine(Protocol):
    """Что должен уметь движок распознавания."""

    name: str

    def recognize(self, image: np.ndarray) -> list[OcrLine]:
        """Распознать изображение (BGR или оттенки серого) и вернуть строки с координатами."""
        ...


@dataclass(frozen=True)
class OcrOptions:
    """Как распознавать страницу.

    `max_px` ограничивает размер рендера: лист A0 при 300 dpi — это 14000 × 9900 пикселей,
    столько в память класть незачем. Крупные листы режутся на перекрывающиеся плитки,
    иначе мелкий шрифт на чертеже теряется.
    """

    engine: OcrEngine | None = None
    dpi: int = 300
    max_px: int = 4000
    tile_px: int = 1600
    overlap_px: int = 160
    min_confidence: float = 0.5
    max_pages: int = 0  # 0 — без ограничения
    force: bool = False

    @property
    def enabled(self) -> bool:
        return self.engine is not None
