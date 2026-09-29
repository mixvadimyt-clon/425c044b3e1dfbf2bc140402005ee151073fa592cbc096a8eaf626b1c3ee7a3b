"""Разбор PDF через PyMuPDF → `ParsedDocument` (контракт `ml-events.v1`).

Извлекаются страницы, геометрия, текстовые блоки, слои OCG, основная надпись и метаданные
документа. Таблицы и OCR страниц без текстового слоя — в `layout/` и `ocr/`.

PyMuPDF держим за этим модулем: лицензия AGPL, при необходимости меняем на pypdfium2
([ADR-0006](../../../docs/adr/0006-ml-stack.md)) — наружу отдаём только `ParsedDocument`.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pymupdf

from inspector_ml.geometry import normalize_bbox
from inspector_ml.layout.rows import page_rows, rows_from_blocks, tables
from inspector_ml.layout.title_block import title_block_blocks
from inspector_ml.logging import get_logger
from inspector_ml.metadata.facts import describe
from inspector_ml.ocr.base import OcrOptions
from inspector_ml.ocr.page import recognize_page
from inspector_ml.quality.page_classifier import TEXT_MIN_CHARS, PageSignals, classify, readable_text
from inspector_ml.storage.files import long_path

_TEXT_BLOCK = 0  # тип блока PyMuPDF: 0 — текст, 1 — изображение

log = get_logger(__name__)


class CorruptedDocumentError(Exception):
    """Файл не открывается или не читается как PDF."""


def _image_area_ratio(page: pymupdf.Page) -> float:
    """Какую долю листа закрывают растровые изображения (признак скана)."""
    area = page.rect.width * page.rect.height
    if area <= 0:
        return 0.0
    try:
        images = page.get_image_info()
    except Exception:  # у части файлов ресурсы страницы битые — это не повод падать
        return 0.0
    covered = 0.0
    for info in images:
        bbox = pymupdf.Rect(info["bbox"])
        covered += abs(bbox.width * bbox.height)
    return min(covered / area, 1.0)


def _content_bytes(page: pymupdf.Page) -> int:
    """Размер потока команд отрисовки — дешёвая замена подсчёту векторных примитивов."""
    try:
        return len(page.read_contents())
    except Exception:
        return 0


def _layers(page: pymupdf.Page) -> list[tuple[pymupdf.Rect, str]]:
    """Текстовые фрагменты, лежащие в слоях PDF (OCG) — имена слоёв САПР.

    Вызывается только у документов со слоями: в корпусе такой текст редкий (около 1 % фрагментов),
    но имена вроде «Размеры» или «ОТКЛОНЕНИЯ» помогают отделить надписи от графики.
    """
    spans: list[tuple[pymupdf.Rect, str]] = []
    try:
        traced = page.get_texttrace()
    except Exception:
        return spans
    for span in traced:
        layer = (span.get("layer") or "").strip()
        if layer:
            spans.append((pymupdf.Rect(span["bbox"]), layer))
    return spans


def _layer_of(bbox: pymupdf.Rect, spans: list[tuple[pymupdf.Rect, str]]) -> str | None:
    for span_bbox, layer in spans:
        if bbox.contains(pymupdf.Point((span_bbox.x0 + span_bbox.x1) / 2, (span_bbox.y0 + span_bbox.y1) / 2)):
            return layer
    return None


def _page_payload(
    page: pymupdf.Page, number: int, *, read_layers: bool = False, read_tables: bool = True
) -> tuple[dict[str, Any], int]:
    """Одна страница `ParsedPage` и число символов текстового слоя."""
    rect = page.rect
    page_box = (rect.x0, rect.y0, rect.x1, rect.y1)
    # координаты текста PyMuPDF отдаёт в неповёрнутой системе — приводим к видимой
    to_visible = page.rotation_matrix
    layer_spans = _layers(page) if read_layers else []

    blocks: list[dict[str, Any]] = []
    chars = 0
    for index, block in enumerate(page.get_text("blocks")):
        x0, y0, x1, y1, text, _block_no, block_type = block[:7]
        if block_type != _TEXT_BLOCK:
            continue
        text = (text or "").strip()
        if not text:
            continue
        chars += len(text)
        raw = pymupdf.Rect(x0, y0, x1, y1)
        visible = raw * to_visible
        payload: dict[str, Any] = {
            "id": f"p{number}-b{index}",
            "type": "text",
            "text": text,
            "bbox": normalize_bbox((visible.x0, visible.y0, visible.x1, visible.y1), page_box),
        }
        layer = _layer_of(raw, layer_spans)
        if layer:
            payload["layer"] = layer
        blocks.append(payload)

    # Долю растра считаем только там, где она может изменить решение: скан — это страница
    # без читаемого текста. На текстовых листах вызов дорогой (около 30 мс) и бессмысленный.
    image_ratio = _image_area_ratio(page) if chars < TEXT_MIN_CHARS else 0.0
    signals = PageSignals(
        chars=chars,
        blocks=len(blocks),
        width_pt=rect.width,
        height_pt=rect.height,
        image_area_ratio=image_ratio,
        content_bytes=_content_bytes(page),
    )
    kind, quality = classify(signals)
    # Шрифт без дескриптора отдаёт кашу вместо кириллицы. Символы при этом есть, поэтому
    # страница выглядит пригодной и OCR на неё не запускается — пока не спросить сам текст.
    if quality == "OK" and not readable_text(" ".join(b["text"] for b in blocks)):
        quality = "LOW_QUALITY"
        log.debug("page_text_unreadable", page=number)
    for block_id in title_block_blocks(blocks):
        next(b for b in blocks if b["id"] == block_id)["type"] = "title_block"

    return (
        {
            "page": number,
            "width_pt": round(rect.width, 2),
            "height_pt": round(rect.height, 2),
            "rotation": page.rotation,
            "source": "TEXT_LAYER",
            "quality": quality,
            "is_drawing": kind == "drawing",
            "blocks": blocks,
            "tables": tables(page_rows(page), page_box, page_number=number) if read_tables and chars else [],
        },
        chars,
    )


def _apply_ocr(page: pymupdf.Page, payload: dict[str, Any], options: OcrOptions) -> bool:
    """Распознать страницу и заменить её блоки. `True`, если бюджет OCR был потрачен."""
    result = recognize_page(page, payload["page"], options)
    if result is None:
        return False

    rect = page.rect
    page_box = (rect.x0, rect.y0, rect.x1, rect.y1)
    payload["blocks"] = result.blocks
    payload["source"] = "OCR"
    payload["ocr_confidence"] = result.mean_confidence
    payload["quality"] = "OK" if result.mean_confidence >= options.min_confidence else "LOW_QUALITY"
    # Таблицы пересобираем заново. На странице без текстового слоя их не было (`chars == 0`),
    # а значения мы берём именно из таблиц — акты, журналы, спецификации, экспликации. Без этого
    # распознанный скан отдавал текст и ни одной таблицы, и параметр уходил в MISSING_EVIDENCE
    # при том, что нужное число на странице распознано.
    payload["tables"] = tables(rows_from_blocks(result.blocks, page_box), page_box, page_number=payload["page"])
    log.debug(
        "ocr_page",
        page=payload["page"],
        lines=len(result.blocks),
        confidence=result.mean_confidence,
        duration_ms=result.duration_ms,
    )
    return True


def _ocr_priority(payload: dict[str, Any]) -> tuple[int, int]:
    """Порядок распознавания при ограниченном бюджете: сначала то, где живут значения.

    Чертёж распознаётся дорого (лист A0 нарезается на десятки плиток), а параметры берутся из
    таблиц и текста — экспликаций, спецификаций, актов. Поэтому при нехватке бюджета сканы
    текстовых листов идут первыми, а внутри группы — по порядку страниц: в актах ИД всё
    существенное стоит в начале.
    """
    return (1 if payload.get("is_drawing") else 0, payload["page"])


def _recognize_pages(document: pymupdf.Document, pages: list[dict[str, Any]], ocr: OcrOptions) -> int:
    """Распознать страницы без текстового слоя в пределах бюджета `OCR_MAX_PAGES`."""
    candidates = [p for p in pages if ocr.force or p["quality"] != "OK"]
    candidates.sort(key=_ocr_priority)

    recognized = 0
    for payload in candidates:
        if ocr.max_pages and recognized >= ocr.max_pages:
            break
        if _apply_ocr(document.load_page(payload["page"] - 1), payload, ocr):
            recognized += 1
    if ocr.max_pages and len(candidates) > recognized:
        log.info("ocr_budget_spent", recognized=recognized, candidates=len(candidates), limit=ocr.max_pages)
    # Движок падает на каждой плитке молча (`ocr_tile_failed` — уровень warning на плитку),
    # и документ заканчивался нулём распознанных страниц без единой заметной записи: скан
    # выглядел как «разобрали, значений нет». Так было 22.09, когда paddlepaddle-gpu не нашёл
    # libcuda.so.1. Итог по документу говорим вслух — это разница между «нечего извлекать»
    # и «распознавание не работает».
    if candidates and not recognized:
        log.warning("ocr_recognized_nothing", candidates=len(candidates), engine=getattr(ocr.engine, "name", None))
    return recognized


def parse_pdf(
    path: Path,
    sha256: str,
    parser_version: str,
    *,
    read_layers: bool = False,
    file_name: str | None = None,
    ocr: OcrOptions | None = None,
) -> dict[str, Any]:
    """Разобрать PDF. Возвращает `ParsedDocument` словарём (готов к записи в JSON).

    `read_layers` включает чтение имён слоёв OCG для текстовых блоков: в корпусе в слоях лежит
    около 1 % фрагментов, а разбор дорожает примерно на треть, поэтому по умолчанию выключено
    (`PARSE_READ_LAYERS`).

    `ocr` задаёт распознавание страниц без текстового слоя. По умолчанию OCR не выполняется:
    без него разбор остаётся быстрым, а страницы просто помечаются `LOW_QUALITY`.
    """
    try:
        document = pymupdf.open(long_path(path))
    except Exception as exc:  # pymupdf кидает собственные исключения разных типов
        raise CorruptedDocumentError(f"Не удалось открыть PDF: {exc}") from exc

    try:
        if document.needs_pass:
            raise CorruptedDocumentError("PDF защищён паролем")
        if document.page_count == 0:
            # PyMuPDF чинит битый xref и открывает обрезанные файлы (так было с F0418 в датасете),
            # но документ без страниц разбирать нечего — это повреждённый файл
            raise CorruptedDocumentError("В документе нет страниц: файл обрезан или повреждён")

        # слои читаем только если просили и они в документе есть: это лишний проход по странице
        with_layers = read_layers and bool(document.get_ocgs())

        pages: list[dict[str, Any]] = []
        for index in range(document.page_count):
            try:
                page = document.load_page(index)
            except Exception as exc:
                raise CorruptedDocumentError(f"Страница {index + 1} не читается: {exc}") from exc
            payload, _chars = _page_payload(page, index + 1, read_layers=with_layers)
            pages.append(payload)

        if ocr is not None and ocr.enabled:
            _recognize_pages(document, pages, ocr)
    finally:
        document.close()

    return {
        "sha256": sha256,
        "parser_version": parser_version,
        "format": "PDF",
        "metadata": describe(pages, file_name=file_name or path.name, path=path),
        "pages": pages,
    }


def file_quality(parsed: dict[str, Any]) -> dict[str, Any]:
    """`FileQuality` по разобранному документу — идёт в `ParseResult` и в api."""
    pages = parsed.get("pages") or []
    with_text = [p for p in pages if p.get("quality") == "OK"]
    low_quality = [p["page"] for p in pages if p.get("quality") == "LOW_QUALITY"]
    abstain = [p["page"] for p in pages if p.get("quality") == "ABSTAIN"]
    recognized = [p for p in pages if p.get("source") == "OCR"]
    confidences = [p["ocr_confidence"] for p in recognized if p.get("ocr_confidence") is not None]
    return {
        "pages_total": len(pages),
        # страницы с текстовым слоем считаем без распознанных: это разные источники
        "pages_text_layer": len([p for p in with_text if p.get("source") != "OCR"]),
        "pages_ocr": len(recognized),
        "low_quality_pages": low_quality,
        "abstain_pages": abstain,
        "ocr_mean_confidence": round(sum(confidences) / len(confidences), 4) if confidences else None,
    }
