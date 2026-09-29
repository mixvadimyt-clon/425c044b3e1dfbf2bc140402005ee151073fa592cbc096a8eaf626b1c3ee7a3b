"""Рендер страницы в растр, нарезка на плитки для OCR и склейка строк обратно.

Растр PyMuPDF уже повёрнут по `/Rotate`, поэтому координаты распознанных строк нормализуются
по размеру изображения и попадают в ту же систему, что и bbox текстового слоя:
доли страницы, начало в левом верхнем углу.

Граница плитки режет строку, которая через неё проходит: левая плитка видит «ограниченно»,
правая — «енной», и обе половины несут общий кусок из полосы перекрытия. Склейка по IoU их
не ловит (рамки пересекаются только в этой полосе), поэтому строки у внутренних границ плиток
сшиваются по общему тексту (`stitch`), а строки, срезанные сверху или снизу, уступают целой
копии из соседнего ряда плиток.
"""

from __future__ import annotations

import math
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, replace
from difflib import SequenceMatcher

import numpy as np
import pymupdf

from inspector_ml.ocr.base import OcrLine, PixelBox

PT_PER_INCH = 72.0


@dataclass(frozen=True)
class Tile:
    """Кусок страницы: изображение и его смещение в пикселях исходного растра."""

    image: np.ndarray
    offset_x: float
    offset_y: float

    @property
    def right(self) -> float:
        return self.offset_x + self.image.shape[1]

    @property
    def bottom(self) -> float:
        return self.offset_y + self.image.shape[0]


def render_page(page: pymupdf.Page, dpi: int, max_px: int) -> np.ndarray:
    """Отрендерить страницу, не раздувая память: крупные листы уменьшаются до `max_px`."""
    rect = page.rect
    scale = dpi / PT_PER_INCH
    longest = max(rect.width, rect.height) * scale
    if longest > max_px:
        scale *= max_px / longest

    pixmap = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), colorspace=pymupdf.csGRAY, alpha=False)
    image = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(pixmap.height, pixmap.width)
    return image


def tiles(image: np.ndarray, tile_px: int, overlap_px: int) -> Iterator[Tile]:
    """Нарезать изображение на перекрывающиеся плитки (перекрытие — чтобы не резать строки)."""
    height, width = image.shape[:2]
    if width <= tile_px and height <= tile_px:
        yield Tile(image=image, offset_x=0.0, offset_y=0.0)
        return

    step = max(tile_px - overlap_px, tile_px // 2)
    for top in range(0, height, step):
        if top and top + overlap_px >= height:
            break
        for left in range(0, width, step):
            if left and left + overlap_px >= width:
                break
            bottom = min(top + tile_px, height)
            right = min(left + tile_px, width)
            yield Tile(image=image[top:bottom, left:right], offset_x=float(left), offset_y=float(top))


def shift(line: OcrLine, tile: Tile) -> OcrLine:
    """Перевести координаты строки из плитки в систему всей страницы."""
    x0, y0, x1, y1 = line.bbox
    return OcrLine(
        text=line.text,
        bbox=(x0 + tile.offset_x, y0 + tile.offset_y, x1 + tile.offset_x, y1 + tile.offset_y),
        confidence=line.confidence,
    )


def _iou(first: PixelBox, second: PixelBox) -> float:
    ax0, ay0, ax1, ay1 = first
    bx0, by0, bx1, by1 = second
    inter_w = max(0.0, min(ax1, bx1) - max(ax0, bx0))
    inter_h = max(0.0, min(ay1, by1) - max(ay0, by0))
    intersection = inter_w * inter_h
    if intersection <= 0:
        return 0.0
    union = (ax1 - ax0) * (ay1 - ay0) + (bx1 - bx0) * (by1 - by0) - intersection
    return intersection / union if union > 0 else 0.0


def dedupe(lines: list[OcrLine], iou_threshold: float = 0.4) -> list[OcrLine]:
    """Убрать повторы из зон перекрытия плиток: остаётся вариант с большей уверенностью."""
    kept: list[OcrLine] = []
    for line in sorted(lines, key=lambda item: -item.confidence):
        if not any(_iou(line.bbox, other.bbox) >= iou_threshold for other in kept):
            kept.append(line)
    return reading_order(kept)


def reading_order(lines: Sequence[OcrLine]) -> list[OcrLine]:
    """Строки по рядам сверху вниз, внутри ряда — слева направо.

    Сортировка по точному верхнему краю перемешивала куски одной строки: «Общество» с верхом
    на 100.3 px вставал после «с ограниченной» с верхом на 99.8 px. Строка входит в ряд, если
    её середина по высоте не дальше половины высоты от середины первой строки ряда.
    """
    rows: list[list[OcrLine]] = []
    for line in sorted(lines, key=lambda item: (_middle(item), item.bbox[0])):
        if rows:
            anchor = rows[-1][0]
            if abs(_middle(line) - _middle(anchor)) <= min(_height(anchor), _height(line)) / 2:
                rows[-1].append(line)
                continue
        rows.append([line])
    return [line for row in rows for line in sorted(row, key=lambda item: item.bbox[0])]


# Строка касается границы плитки, если подходит к ней ближе этого: пикселей или доли своей высоты.
EDGE_PX = 4.0
EDGE_SHARE = 0.5
# Куски из соседних плиток — одна строка, если их общая высота не меньше этой доли меньшей из них.
SAME_ROW = 0.5
# Сколько символов подряд должны совпасть в полосе перекрытия, чтобы шить по общему тексту.
MIN_COMMON = 2


@dataclass(frozen=True)
class _Piece:
    """Строка в координатах страницы и стороны, с которых её срезала граница плитки."""

    line: OcrLine
    tile: Tile
    cut_left: bool = False
    cut_right: bool = False
    cut_top: bool = False
    cut_bottom: bool = False


def stitch(found: Sequence[tuple[Tile, Sequence[OcrLine]]], width: float, height: float) -> list[OcrLine]:
    """Собрать строки всех плиток страницы (уже в координатах страницы) без повторов и разрывов.

    1. Строка, срезанная верхним или нижним краем плитки, уступает целой копии из соседнего
       ряда плиток: полоса перекрытия (160 px) выше строки текста, и там строка видна целиком.
    2. Строки, разрезанные вертикальной границей, сшиваются по общему тексту в полосе
       перекрытия; если общего текста нет — по середине пересечения рамок. Кусок, который
       целиком лежит под рамкой соседа, уступает ему.
    3. Остальные повторы (строка целиком в полосе перекрытия) убирает `dedupe` по IoU.
    """
    pieces = [_piece(line, tile, width, height) for tile, lines in found for line in lines]
    pieces = [piece for piece in pieces if not _has_whole_twin(piece, pieces)]
    return dedupe([piece.line for piece in _join_rows(pieces)])


def _piece(line: OcrLine, tile: Tile, width: float, height: float) -> _Piece:
    x0, y0, x1, y1 = line.bbox
    edge = max(EDGE_PX, EDGE_SHARE * (y1 - y0))
    return _Piece(
        line=line,
        tile=tile,
        cut_left=tile.offset_x > 0 and x0 <= tile.offset_x + edge,
        cut_right=tile.right < width and x1 >= tile.right - edge,
        cut_top=tile.offset_y > 0 and y0 <= tile.offset_y + edge,
        cut_bottom=tile.bottom < height and y1 >= tile.bottom - edge,
    )


def _has_whole_twin(piece: _Piece, pieces: Sequence[_Piece]) -> bool:
    """Срезанная сверху или снизу строка, у которой в другом ряду плиток есть несрезанная копия."""
    if not (piece.cut_top or piece.cut_bottom):
        return False
    x0, y0, x1, y1 = piece.line.bbox
    for other in pieces:
        if other.tile.offset_y == piece.tile.offset_y or other.cut_top or other.cut_bottom:
            continue
        ox0, oy0, ox1, oy1 = other.line.bbox
        common_x = min(x1, ox1) - max(x0, ox0)
        if common_x >= 0.5 * min(x1 - x0, ox1 - ox0) and min(y1, oy1) > max(y0, oy0):
            return True
    return False


def _join_rows(pieces: Sequence[_Piece]) -> list[_Piece]:
    """Сшить строки, разрезанные вертикальными границами: по каждому ряду плиток слева направо."""
    result: list[_Piece] = []
    for top in sorted({piece.tile.offset_y for piece in pieces}):
        row = [piece for piece in pieces if piece.tile.offset_y == top]
        columns = sorted({piece.tile.offset_x for piece in row})
        kept = [piece for piece in row if piece.tile.offset_x == columns[0]]
        for left in columns[1:]:
            for right in sorted((p for p in row if p.tile.offset_x == left), key=lambda p: p.line.bbox[0]):
                partner = _partner(right, kept)
                joined = _join(partner, right) if partner else None
                if partner is None or joined is None:
                    kept.append(right)
                else:
                    kept.remove(partner)
                    kept.append(joined)
        result.extend(kept)
    return result


def _partner(right: _Piece, pieces: Sequence[_Piece]) -> _Piece | None:
    """Кусок левее шва, который `right` продолжает: тот же ряд текста, рамки заходят друг на друга."""
    best: tuple[float, _Piece] | None = None
    rx0, ry0, _, ry1 = right.line.bbox
    for left in pieces:
        if left.tile.right <= right.tile.offset_x or not (left.cut_right or right.cut_left):
            continue
        _, ly0, lx1, ly1 = left.line.bbox
        lower = min(ly1 - ly0, ry1 - ry0)
        if lx1 <= rx0 or lower <= 0:
            continue
        share = (min(ly1, ry1) - max(ly0, ry0)) / lower
        if share >= SAME_ROW and (best is None or share > best[0]):
            best = (share, left)
    return best[1] if best else None


def _join(left: _Piece, right: _Piece) -> _Piece | None:
    """Одна строка из двух кусков у шва; `None` — это разные строки, оставить обе."""
    lx0, ly0, lx1, ly1 = left.line.bbox
    rx0, ry0, rx1, ry1 = right.line.bbox
    edge = max(EDGE_PX, EDGE_SHARE * min(ly1 - ly0, ry1 - ry0))
    if rx0 <= lx0 + edge and rx1 >= lx1 - edge:
        return right  # левый кусок целиком под правым: он из полосы перекрытия
    if rx1 <= lx1 + edge:
        return left
    if not (left.cut_right and right.cut_left):
        return None

    lengths = len(left.line.text) + len(right.line.text)
    line = OcrLine(
        text=join_text(left.line, right.line),
        bbox=(lx0, min(ly0, ry0), rx1, max(ly1, ry1)),
        confidence=(left.line.confidence * len(left.line.text) + right.line.confidence * len(right.line.text))
        / max(1, lengths),
    )
    # сшитая строка живёт в правой плитке: оттуда её может продолжить следующая
    return replace(right, line=line, cut_left=left.cut_left)


def join_text(left: OcrLine, right: OcrLine) -> str:
    """Текст двух половин строки без повтора из полосы перекрытия.

    Общий кусок ищем в хвосте левой половины и в начале правой — в стольких символах, сколько
    помещается в пересечение рамок, с запасом. Шов — середина общего куска: у края плитки
    символ разрезан, и каждая половина вернее читает то, что дальше от её края.
    """
    lx0, _, lx1, _ = left.bbox
    rx0, _, rx1, _ = right.bbox
    overlap = max(0.0, lx1 - rx0)
    left_char = (lx1 - lx0) / max(1, len(left.text))
    right_char = (rx1 - rx0) / max(1, len(right.text))
    tail_size = min(len(left.text), math.ceil(overlap / left_char) + 2) if left_char > 0 else len(left.text)
    head_size = min(len(right.text), math.ceil(overlap / right_char) + 2) if right_char > 0 else len(right.text)
    tail = left.text[len(left.text) - tail_size :]
    head = right.text[:head_size]

    common = SequenceMatcher(None, tail, head, autojunk=False).find_longest_match(0, len(tail), 0, len(head))
    if common.size >= MIN_COMMON:
        half = common.size // 2
        return left.text[: len(left.text) - tail_size + common.a + half] + right.text[common.b + half :]

    seam = (rx0 + lx1) / 2
    keep = round((seam - lx0) / left_char) if left_char > 0 else len(left.text)
    skip = round((seam - rx0) / right_char) if right_char > 0 else 0
    return left.text[:keep] + right.text[skip:]


def _middle(line: OcrLine) -> float:
    return (line.bbox[1] + line.bbox[3]) / 2


def _height(line: OcrLine) -> float:
    return line.bbox[3] - line.bbox[1]
