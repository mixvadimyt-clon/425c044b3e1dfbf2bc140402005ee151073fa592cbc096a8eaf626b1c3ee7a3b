"""Оценка качества OCR (§14): Character Accuracy, CER, WER, покрытие.

Эталон берётся из самого документа: страницы **с текстовым слоем** рендерятся и распознаются
принудительно, а текстовый слой служит истиной. Ручная разметка для этого не нужна, документы —
настоящие (чертежи, акты, ведомости), и метрика считается на любом объекте.

Считаем двумя способами, потому что порядок и нарезка строк у текстового слоя и у OCR разные:

- **построчно** (`accuracy`): строки эталона и распознавания сопоставляются парами по сходству,
  непарные строки эталона засчитываются как нераспознанные целиком. Не зависит от порядка,
  но строга к нарезке: если OCR разбил строку эталона на два куска, второй кусок — ошибки;
- **по странице** (`page_accuracy`) — формула ТЗ как есть, 1 − Levenshtein / символов по тексту
  всей страницы. Обе стороны перед сравнением выстраиваются одинаково — по рядам сверху вниз,
  в ряду слева направо (по рамкам строк), поэтому не зависит от нарезки строк и от порядка
  блоков в выдаче, но зависит от того, одинаково ли разложились ряды (таблицы, чертежи).

WER считается по тексту страницы в том же порядке рядов.
"""

from __future__ import annotations

import time
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pymupdf
from rapidfuzz import fuzz, process
from rapidfuzz.distance import Levenshtein

from inspector_ml.geometry import normalize_bbox
from inspector_ml.ocr.base import OcrOptions
from inspector_ml.ocr.page import recognize_page
from inspector_ml.quality.page_classifier import TEXT_MIN_CHARS
from inspector_ml.storage.files import long_path


def normalize(text: str) -> str:
    """NFC, схлопнутые пробелы, без регистра — как в методике организаторов."""
    return " ".join(unicodedata.normalize("NFC", text).split()).casefold()


def cer(reference: str, hypothesis: str) -> float:
    """Character Error Rate: расстояние Левенштейна, делённое на длину эталона."""
    reference = normalize(reference)
    hypothesis = normalize(hypothesis)
    if not reference:
        return 0.0 if not hypothesis else 1.0
    return Levenshtein.distance(reference, hypothesis) / len(reference)


def wer(reference: str, hypothesis: str) -> float:
    """Word Error Rate по словам нормализованного текста."""
    ref_words = normalize(reference).split()
    hyp_words = normalize(hypothesis).split()
    if not ref_words:
        return 0.0 if not hyp_words else 1.0
    return Levenshtein.distance(ref_words, hyp_words) / len(ref_words)


def character_accuracy(reference: str, hypothesis: str) -> float:
    """1 − CER, обрезано снизу нулём."""
    return max(0.0, 1.0 - cer(reference, hypothesis))


@dataclass(frozen=True)
class PageScore:
    """Оценка одной страницы."""

    page: int
    reference_chars: int
    recognized_chars: int
    accuracy: float
    cer: float
    wer: float
    confidence: float
    duration_ms: int
    page_accuracy: float = 0.0


def _page_lines(page: pymupdf.Page) -> list[str]:
    """Строки текстового слоя: блок PyMuPDF может содержать несколько строк."""
    lines: list[str] = []
    for block in page.get_text("blocks"):
        if block[6] != 0:
            continue
        for line in (block[4] or "").splitlines():
            cleaned = normalize(line)
            if cleaned:
                lines.append(cleaned)
    return lines


def _page_text(page: pymupdf.Page) -> str:
    return " ".join(_page_lines(page))


def match_lines(reference: list[str], hypothesis: list[str], *, cutoff: float = 40.0) -> tuple[int, int]:
    """Сопоставить строки эталона и распознавания. Возвращает (ошибок, символов эталона).

    Пары выбираются по всей странице сразу, от самых похожих к менее похожим, сходство — доля
    общих символов (`fuzz.ratio`). Строка эталона без пары считается нераспознанной целиком.

    Раньше строки эталона по очереди забирали лучшую из оставшихся по `WRatio`, а он ставит 90
    за вхождение подстроки: «200» из графы «Кол-во» уводила строку «2000 мм. В комплекте…», и её
    настоящая строка эталона оставалась без пары. Такая метрика поощряла повторы: лишние копии
    строк из зон перекрытия плиток подставлялись вместо уведённых.
    """
    total = sum(len(line) for line in reference)
    if not reference or not hypothesis:
        return total, total
    scores = process.cdist(reference, hypothesis, scorer=fuzz.ratio, score_cutoff=cutoff)
    order = np.argsort(-scores, axis=None, kind="stable")
    used_reference: set[int] = set()
    used_hypothesis: set[int] = set()
    errors = 0
    for flat in order:
        row, column = divmod(int(flat), len(hypothesis))
        if scores[row, column] <= 0:
            break
        if row in used_reference or column in used_hypothesis:
            continue
        used_reference.add(row)
        used_hypothesis.add(column)
        errors += Levenshtein.distance(reference[row], hypothesis[column])
    errors += sum(len(line) for index, line in enumerate(reference) if index not in used_reference)
    return errors, total


Box = tuple[float, float, float, float]


def in_rows(lines: Sequence[tuple[str, Box]]) -> str:
    """Текст строк по рядам сверху вниз, в ряду слева направо.

    Строка входит в ряд, если её середина по высоте не дальше половины высоты от середины первой
    строки ряда. Правило одно для эталона и для распознавания, поэтому сравнение не зависит ни
    от того, как движок нарезал строки, ни от порядка блоков в его выдаче.
    """

    def middle(box: Box) -> float:
        return (box[1] + box[3]) / 2

    rows: list[list[tuple[str, Box]]] = []
    for text, box in sorted(lines, key=lambda item: (middle(item[1]), item[1][0])):
        if rows:
            anchor = rows[-1][0][1]
            if abs(middle(box) - middle(anchor)) <= min(anchor[3] - anchor[1], box[3] - box[1]) / 2:
                rows[-1].append((text, box))
                continue
        rows.append([(text, box)])
    return " ".join(text for row in rows for text, _ in sorted(row, key=lambda item: item[1][0]))


def _layer_rows(page: pymupdf.Page) -> str:
    """Текстовый слой страницы по рядам — в видимой системе координат, как рамки OCR."""
    rect = page.rect
    page_box = (rect.x0, rect.y0, rect.x1, rect.y1)
    to_visible = page.rotation_matrix
    lines: list[tuple[str, Box]] = []
    for block in page.get_text("dict")["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block["lines"]:
            text = normalize("".join(span["text"] for span in line["spans"]))
            if text:
                visible = pymupdf.Rect(line["bbox"]) * to_visible
                box = normalize_bbox((visible.x0, visible.y0, visible.x1, visible.y1), page_box)
                lines.append((text, (box[0], box[1], box[2], box[3])))
    return in_rows(lines)


def score_page(document: pymupdf.Document, index: int, options: OcrOptions) -> PageScore:
    """Распознать страницу принудительно и сравнить с её текстовым слоем (`index` — с нуля)."""
    page = document[index]
    reference_lines = _page_lines(page)
    reference = " ".join(reference_lines)
    result = recognize_page(page, index + 1, options)
    recognized_lines = [normalize(block["text"]) for block in result.blocks] if result else []
    recognized = " ".join(recognized_lines)

    errors, total = match_lines(reference_lines, recognized_lines)
    page_cer = errors / total if total else 0.0
    reference_rows = _layer_rows(page)
    recognized_rows = in_rows(
        [(normalize(block["text"]), tuple(block["bbox"])) for block in result.blocks] if result else []
    )
    return PageScore(
        page=index + 1,
        reference_chars=len(reference),
        recognized_chars=len(recognized),
        accuracy=round(max(0.0, 1.0 - page_cer), 4),
        cer=round(page_cer, 4),
        wer=round(wer(reference_rows, recognized_rows), 4),
        confidence=result.mean_confidence if result else 0.0,
        duration_ms=result.duration_ms if result else 0,
        page_accuracy=round(character_accuracy(reference_rows, recognized_rows), 4),
    )


def evaluate_pdf(path: Path, options: OcrOptions, limit: int = 5) -> dict[str, Any]:
    """Прогнать OCR по страницам с текстовым слоем и сравнить с ним.

    Возвращает сводку и постраничные оценки. `limit` — сколько страниц взять (равномерно).
    """
    if options.engine is None:
        raise RuntimeError("OCR недоступен: установите extra ocr (uv sync --extra ocr)")

    started = time.monotonic()
    document = pymupdf.open(long_path(path))
    try:
        candidates = [
            index for index in range(document.page_count) if len(_page_text(document[index])) >= TEXT_MIN_CHARS * 10
        ]
        if not candidates:
            return {"file": path.name, "pages": 0, "note": "нет страниц с достаточным текстовым слоем"}

        step = max(1, len(candidates) // limit)
        chosen = candidates[::step][:limit]

        scores = [score_page(document, index, options) for index in chosen]
    finally:
        document.close()

    total_reference = sum(score.reference_chars for score in scores)
    weighted_accuracy = (
        sum(score.accuracy * score.reference_chars for score in scores) / total_reference if total_reference else 0.0
    )
    page_accuracy = (
        sum(score.page_accuracy * score.reference_chars for score in scores) / total_reference
        if total_reference
        else 0.0
    )
    return {
        "file": path.name,
        "engine": options.engine.name,
        "dpi": options.dpi,
        "pages": len(scores),
        "character_accuracy": round(weighted_accuracy, 4),
        "cer": round(1.0 - weighted_accuracy, 4),
        "page_character_accuracy": round(page_accuracy, 4),
        "wer": round(sum(score.wer for score in scores) / len(scores), 4) if scores else 0.0,
        "coverage": round(
            sum(score.recognized_chars for score in scores) / total_reference if total_reference else 0.0, 4
        ),
        "mean_confidence": round(sum(score.confidence for score in scores) / len(scores), 4) if scores else 0.0,
        "seconds_per_page": round((time.monotonic() - started) / len(scores), 2) if scores else 0.0,
        "by_page": [score.__dict__ for score in scores],
    }
