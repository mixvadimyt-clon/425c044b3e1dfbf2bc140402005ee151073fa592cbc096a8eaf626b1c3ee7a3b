"""Сводка по папке с документами: что там за PDF и что с ними будет делать конвейер.

Нужна, чтобы быстро посмотреть на новый комплект (их будут докидывать по ходу работы)
и понять объём OCR, долю чертежей и повороты, не открывая файлы руками.
"""

from __future__ import annotations

import time
from collections import Counter
from pathlib import Path
from typing import Any

from inspector_ml.ingest.pdf import CorruptedDocumentError, parse_pdf
from inspector_ml.storage.files import long_path


def pdf_paths(folder: Path, limit: int | None = None) -> list[Path]:
    paths = sorted(p for p in long_path(folder).rglob("*.pdf") if p.is_file())
    return paths[:limit] if limit else paths


def scan_folder(folder: Path, limit: int | None = None, *, read_layers: bool = False) -> dict[str, Any]:
    """Разобрать PDF из папки и собрать сводку."""
    started = time.monotonic()
    rotations: Counter[int] = Counter()
    formats: Counter[str] = Counter()
    stages: Counter[str] = Counter()
    disciplines: Counter[str] = Counter()
    pages = text_pages = low_quality = abstain = drawings = 0
    failures: list[dict[str, str]] = []
    files = 0

    for path in pdf_paths(folder, limit):
        try:
            parsed = parse_pdf(path, "", "scan", read_layers=read_layers)
        except CorruptedDocumentError as exc:
            failures.append({"file": path.name, "error": str(exc)})
            continue
        files += 1
        metadata = parsed["metadata"]
        stages[str(metadata.get("doc_stage"))] += 1
        disciplines[str(metadata.get("discipline"))] += 1
        for page in parsed["pages"]:
            pages += 1
            rotations[page["rotation"]] += 1
            formats[f"{round(page['width_pt'])}x{round(page['height_pt'])}"] += 1
            quality = page["quality"]
            text_pages += quality == "OK"
            low_quality += quality == "LOW_QUALITY"
            abstain += quality == "ABSTAIN"
            drawings += bool(page["is_drawing"])

    return {
        "folder": str(folder),
        "files": files,
        "pages": pages,
        "pages_text_layer": text_pages,
        "pages_need_ocr": low_quality,
        "pages_abstain": abstain,
        "pages_drawing": drawings,
        "rotations": dict(sorted(rotations.items())),
        "formats": dict(formats.most_common(8)),
        "stages": dict(stages.most_common()),
        "disciplines": dict(disciplines.most_common(10)),
        "failures": failures,
        "duration_s": round(time.monotonic() - started, 1),
    }
