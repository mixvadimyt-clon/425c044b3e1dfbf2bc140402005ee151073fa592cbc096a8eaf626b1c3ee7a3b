"""Распознавание одной страницы: рендер → плитки → строки → блоки `ParsedPage`.

Блоки OCR выглядят так же, как блоки текстового слоя, но несут `confidence` и `quality`,
а у страницы меняется `source` на `OCR`. Значения из ненадёжного OCR движок сравнения
дальше может отбросить сам — для этого уверенность и нужна.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import pymupdf

from inspector_ml.geometry import normalize_bbox
from inspector_ml.logging import get_logger
from inspector_ml.ocr.base import OcrLine, OcrOptions
from inspector_ml.ocr.render import Tile, render_page, shift, stitch, tiles

log = get_logger(__name__)


@dataclass(frozen=True)
class PageOcr:
    """Результат распознавания страницы."""

    blocks: list[dict[str, Any]]
    mean_confidence: float
    duration_ms: int

    @property
    def chars(self) -> int:
        return sum(len(block["text"]) for block in self.blocks)


def recognize_page(page: pymupdf.Page, number: int, options: OcrOptions) -> PageOcr | None:
    """Распознать страницу. `None` — движок недоступен или ничего не нашлось."""
    if options.engine is None:
        return None

    started = time.monotonic()
    image = render_page(page, options.dpi, options.max_px)
    height, width = image.shape[:2]

    found: list[tuple[Tile, list[OcrLine]]] = []
    for tile in tiles(image, options.tile_px, options.overlap_px):
        try:
            recognized = options.engine.recognize(tile.image)
        except Exception as exc:  # движок не должен ронять разбор документа
            log.warning("ocr_tile_failed", page=number, engine=options.engine.name, reason=str(exc))
            continue
        found.append((tile, [shift(line, tile) for line in recognized]))

    lines = stitch(found, float(width), float(height))
    if not lines:
        return None

    page_box = (0.0, 0.0, float(width), float(height))
    blocks = [
        {
            "id": f"p{number}-ocr{index}",
            "type": "text",
            "text": line.text,
            "bbox": normalize_bbox(line.bbox, page_box),
            "confidence": round(line.confidence, 4),
            "quality": "OK" if line.confidence >= options.min_confidence else "LOW_QUALITY",
        }
        for index, line in enumerate(lines)
    ]
    mean_confidence = sum(line.confidence for line in lines) / len(lines)
    return PageOcr(
        blocks=blocks,
        mean_confidence=round(mean_confidence, 4),
        duration_ms=round((time.monotonic() - started) * 1000),
    )
