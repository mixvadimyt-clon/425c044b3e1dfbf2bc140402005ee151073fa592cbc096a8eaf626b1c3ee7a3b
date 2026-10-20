"""Подписи листов ОВ с координатами: слова текстового слоя и распознанный шрифт САПР.

Разбор (`ingest/pdf.py`) отдаёт текст блоками, и на принципиальных схемах вентиляции подписи соседних помещений
склеены в один блок: «141 Биолого-химического | практикума | 147 Лаборантская тип АВ». А на планах РД подписи систем
и табличек воздухообмена («П2/ВЕ +400 м³/ч», «В2.7,8,9 −950 м³/ч») нарисованы шрифтом САПР — линиями, а не текстом:
в текстовом слое плана ОВ1 «Тюменской 5» номера помещений есть, а подписей систем нет ни одной. Поэтому перед
сравнением листам ОВ с номерами помещений добавляются:

- `cad_words` — слова текстового слоя с рамками в долях листа (PyMuPDF, дёшево);
- `cad_ocr` — строки OCR листа целиком, если в текстовом слое подписей систем почти нет: из кеша, а если его нет и
  движок OCR передан — распознаётся.

Только документы системы «ОВ» по шифру (`semantic.system`) и только листы-чертежи с номерами помещений. Разбор и его
кеш не меняются: подписи живут в памяти задачи, распознанное кладётся в `STORAGE_DIR/cad/{sha256}/{стр}-{dpi}.json`,
и повторное сравнение того же комплекта OCR не повторяет.
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np
import pymupdf

from inspector_ml.extract import ventilation
from inspector_ml.extract.api import LoadedDocument
from inspector_ml.logging import get_logger
from inspector_ml.ocr.base import OcrEngine
from inspector_ml.ocr.render import tiles
from inspector_ml.storage.files import long_path

log = get_logger(__name__)

#: Номер помещения: «140», «012», «012.1». Четырёхзначные — это уже размеры и отметки.
ROOM_TOKEN = re.compile(r"(?<![\d.,])\d{3}(?:\.\d)?(?![\d.,])")
#: Столько номеров помещений на листе-чертеже — это план или схема по помещениям, а не узел или разрез.
MIN_ROOMS = 8
#: Если подписей систем в текстовом слое плана меньше — они нарисованы шрифтом САПР, лист распознаётся.
MIN_TEXT_SYSTEMS = 3
#: Разрешение OCR листа: подписи САПР высотой 2,5 мм читаются уверенно (проба 16.10: 200 и 300 dpi дали те же
#: подписи систем), а лист A0 — 6600 × 9400 пикселей, 13–18 с на RTX 3050.
DPI = 200
TILE_PX = 1600
OVERLAP_PX = 160


def enrich(
    docs: Sequence[LoadedDocument],
    storage_dir: Path,
    engine: OcrEngine | None,
    *,
    budget_s: float = 0.0,
    dpi: int = DPI,
) -> dict[str, int]:
    """Добавить листам ОВ `cad_words` и, где нужно, `cad_ocr`; вернуть счётчики для журнала.

    `budget_s` — секунды на OCR всего комплекта, 0 — без ограничения. Кончилось время — оставшиеся листы идут
    без распознанных подписей, и по ним значений не будет (ложное «в РД вытяжки нет» хуже пропуска).
    """
    from inspector_ml.suspicion.semantic import system  # шифр документа → система; semantic тянет клиент LLM

    started = time.monotonic()
    counts = {"pages": 0, "ocr": 0, "ocr_cached": 0, "ocr_skipped": 0}
    for doc in docs:
        if system(doc) != "ОВ":
            continue
        pages = [p for p in doc.pages if p.get("is_drawing") and _room_tokens(p) >= MIN_ROOMS]
        if not pages:
            continue
        source = long_path(storage_dir / "raw" / doc.sha256)
        if not source.is_file():
            log.debug("cad_source_missing", sha256=doc.sha256)
            continue
        try:
            document = pymupdf.open(source)
        except Exception as exc:  # битый файл — значений по нему не будет, сравнение не падает
            log.warning("cad_source_unreadable", sha256=doc.sha256, reason=str(exc))
            continue
        with document:
            for parsed in pages:
                number = int(parsed.get("page") or 0)
                if not 1 <= number <= document.page_count:
                    continue
                page = document[number - 1]
                parsed["cad_words"] = words(page)
                counts["pages"] += 1
                # OCR — только планам с экспликацией: на схемах ПД подписи систем есть в текстовом слое, а на
                # остальных листах (таблицы, узлы, аксонометрия) системы по номерам помещений не сопоставить
                if not ventilation.schedule(parsed) or len(ventilation.labels(parsed)) >= MIN_TEXT_SYSTEMS:
                    continue
                # распознанное раньше берётся и без движка: кеш, посчитанный на видеокарте, годится процессорному
                # стенду, и протокол не зависит от того, успел ли OCR в этот раз
                lines = cached(storage_dir, doc.sha256, number, dpi)
                if lines is not None:
                    parsed["cad_ocr"] = lines
                    counts["ocr_cached"] += 1
                    continue
                if engine is None or (budget_s and time.monotonic() - started > budget_s):
                    counts["ocr_skipped"] += 1
                    continue
                parsed["cad_ocr"] = recognize(page, engine, dpi)
                path = _cache_path(storage_dir, doc.sha256, number, dpi)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(parsed["cad_ocr"], ensure_ascii=False), encoding="utf-8")
                counts["ocr"] += 1
    log.info("cad_labels", seconds=round(time.monotonic() - started, 1), **counts)
    return counts


def words(page: pymupdf.Page) -> list[dict[str, Any]]:
    """Слова текстового слоя с рамкой в долях листа; `block` и `line` — чтобы собрать подпись «012 | Венткамера»."""
    width, height = page.rect.width, page.rect.height
    return [
        {
            "text": text,
            "bbox": [round(x0 / width, 5), round(y0 / height, 5), round(x1 / width, 5), round(y1 / height, 5)],
            "block": int(block),
            "line": int(line),
        }
        for x0, y0, x1, y1, text, block, line, _word in page.get_text("words")
    ]


def recognize(page: pymupdf.Page, engine: OcrEngine, dpi: int = DPI) -> list[dict[str, Any]]:
    """Строки OCR листа целиком (плитками с перекрытием) с рамкой в долях листа и уверенностью."""
    pixmap = page.get_pixmap(dpi=dpi)
    image = np.frombuffer(pixmap.samples, np.uint8).reshape(pixmap.height, pixmap.width, pixmap.n)
    image = np.ascontiguousarray(image[..., :3][..., ::-1])  # RGB → BGR, как у остального OCR
    height, width = image.shape[:2]
    lines = []
    for tile in tiles(image, TILE_PX, OVERLAP_PX):
        for line in engine.recognize(tile.image):
            x0, y0, x1, y1 = line.bbox
            lines.append(
                {
                    "text": line.text,
                    "conf": round(float(line.confidence), 3),
                    "bbox": [
                        round((x0 + tile.offset_x) / width, 5),
                        round((y0 + tile.offset_y) / height, 5),
                        round((x1 + tile.offset_x) / width, 5),
                        round((y1 + tile.offset_y) / height, 5),
                    ],
                }
            )
    return lines


def _room_tokens(parsed: dict[str, Any]) -> int:
    text = " ".join(b.get("text") or "" for b in parsed.get("blocks") or [] if b.get("type") != "title_block")
    return len(set(ROOM_TOKEN.findall(text)))


def cached(storage_dir: Path, sha256: str, page: int, dpi: int = DPI) -> list[dict[str, Any]] | None:
    """Распознанные строки листа из кеша (`recognize`) или `None`, если лист не распознавали.

    Кеш общий для вентиляции и объектов листа: его пишет и прогон на видеокарте, и Colab (18.10, 440 листов ОВ).
    """
    path = _cache_path(storage_dir, sha256, page, dpi)
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        log.warning("cad_cache_unreadable", path=str(path))
        return None


def _cache_path(storage_dir: Path, sha256: str, page: int, dpi: int) -> Path:
    return long_path(storage_dir / "cad" / sha256 / f"{page}-{dpi}.json")
