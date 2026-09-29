"""Сверка нашего разбора с разметкой организаторов.

Две проверки:

- **страницы** — наш `quality` против поля `needs_ocr` из `page_index.jsonl`
  (`LOW_QUALITY` = странице нужен OCR);
- **метаданные** — наши `doc_stage` и `discipline` против кураторских полей `stage` и `section`
  из `files_index.jsonl`, а шифр и изменение — против аннотаций `META-DOC-CODE` и `META-REVISION`.

Разница между источниками важна. `files_index` заполняли люди, ему можно верить. Аннотации
`META-*` — машинная предразметка (`AUTO_FIELD_CANDIDATE`), и в ней встречается мусор: у актов
освидетельствования в `META-DOC-CODE` попадает «ВН.ТЕР.Г» из адреса, а в `META-REVISION` — слово
«ИЗМ» без номера. Поэтому по ним считается **пересечение**, а не точность: расхождение значит
«посмотреть глазами», а не «мы ошиблись».

Это не обучение на разметке, а измерение: пороги в `quality/page_classifier.py` подобраны
по результату вручную и зафиксированы в коде.
"""

from __future__ import annotations

import re
from collections import Counter
from pathlib import Path
from typing import Any

from inspector_ml.corpus.labels import Split, pdf_files
from inspector_ml.ingest.pdf import parse_pdf
from inspector_ml.quality.page_classifier import needs_ocr

META_DOC_CODE = "META-DOC-CODE"
META_REVISION = "META-REVISION"

# В `files_index.section` марки записаны латиницей, у нас — кириллицей (как в штампе).
SECTION_ALIASES = {
    "AR": "АР",
    "KR": "КР",
    "KJ": "КЖ",
    "OV": "ОВ",
    "VK": "ВК",
    "EOM": "ЭОМ",
    "SS": "СС",
    "GP": "ГП",
    "POS": "ПОС",
    "PB": "ПБ",
    "PZ": "ПЗ",
    "PZU": "ПЗУ",
    "OOS": "ООС",
}


def _rate(part: int, whole: int) -> float:
    return round(part / whole, 4) if whole else 0.0


def calibrate_pages(root: Path, split_name: str = "TRAIN_PUBLIC", limit: int = 25) -> dict[str, Any]:
    """Совпадает ли наш признак «нужен OCR» с разметкой организаторов."""
    split = Split(root=root, name=split_name)
    if not split.exists():
        raise FileNotFoundError(f"Нет размеченной части {split_name} в {root}")

    labels = {(row["file_id"], row["source_page_number"]): row for row in split.pages()}
    matrix = Counter()
    per_file: list[dict[str, Any]] = []

    for row in pdf_files(split, limit):
        parsed = parse_pdf(split.source_path(row), row.get("source_sha256", ""), "calibration")
        agree = total = 0
        for page in parsed["pages"]:
            label = labels.get((row["file_id"], page["page"]))
            if label is None:
                continue
            ours = needs_ocr(page["quality"])
            theirs = bool(label["needs_ocr"])
            matrix[(ours, theirs)] += 1
            total += 1
            agree += ours == theirs
        per_file.append(
            {
                "file_id": row["file_id"],
                "pages": total,
                "agreement": _rate(agree, total),
                "name": Path(row["source_relative_path"]).name,
            }
        )

    tp = matrix[(True, True)]
    fp = matrix[(True, False)]
    fn = matrix[(False, True)]
    tn = matrix[(False, False)]
    total = tp + fp + fn + tn
    return {
        "split": split_name,
        "files": len(per_file),
        "pages": total,
        "accuracy": _rate(tp + tn, total),
        "precision": _rate(tp, tp + fp),
        "recall": _rate(tp, tp + fn),
        "confusion": {"tp": tp, "fp": fp, "fn": fn, "tn": tn},
        "worst_files": sorted(per_file, key=lambda r: r["agreement"])[:5],
    }


def _clean(value: str) -> str:
    return re.sub(r"[\s_]+", "", value).strip(" .,;:").upper()


def calibrate_metadata(root: Path, split_name: str = "TRAIN_PUBLIC", limit: int = 25) -> dict[str, Any]:
    """Совпадают ли шифр и изменение с аннотациями `META-*` того же файла."""
    split = Split(root=root, name=split_name)
    if not split.exists():
        raise FileNotFoundError(f"Нет размеченной части {split_name} в {root}")

    rows = pdf_files(split, limit)
    wanted = {row["file_id"] for row in rows}
    expected: dict[str, dict[str, Counter]] = {
        file_id: {META_DOC_CODE: Counter(), META_REVISION: Counter()} for file_id in wanted
    }
    for annotation in split.annotations():
        if annotation["file_id"] in wanted and annotation.get("code") in (META_DOC_CODE, META_REVISION):
            text = (annotation.get("text") or "").strip()
            if text:
                expected[annotation["file_id"]][annotation["code"]][_clean(text)] += 1

    results: list[dict[str, Any]] = []
    for row in rows:
        parsed = parse_pdf(split.source_path(row), row.get("source_sha256", ""), "calibration")
        metadata = parsed["metadata"]
        codes = expected[row["file_id"]][META_DOC_CODE]
        # в META-REVISION попадает и слово «ИЗМ» без номера — такие метки не считаем
        revisions = Counter(
            {
                text: count
                for text, count in expected[row["file_id"]][META_REVISION].items()
                if any(c.isdigit() for c in text)
            }
        )
        ours_code = _clean(metadata.get("document_code") or "")
        ours_revision = _clean(metadata.get("revision") or "")
        results.append(
            {
                "file_id": row["file_id"],
                "name": Path(row["source_relative_path"]).name,
                "code_ours": metadata.get("document_code"),
                "code_expected": codes.most_common(1)[0][0] if codes else None,
                "code_match": bool(ours_code) and any(ours_code in c or c in ours_code for c in codes),
                "revision_ours": metadata.get("revision"),
                "revision_expected": revisions.most_common(1)[0][0] if revisions else None,
                "revision_match": bool(ours_revision) and ours_revision in revisions,
                "stage": metadata.get("doc_stage"),
                "stage_expected": row.get("stage"),
                "discipline": metadata.get("discipline"),
                "discipline_expected": row.get("section"),
                "discipline_match": metadata.get("discipline") == SECTION_ALIASES.get(row.get("section", "")),
            }
        )

    with_code = [r for r in results if r["code_expected"]]
    with_revision = [r for r in results if r["revision_expected"]]
    with_stage = [r for r in results if r["stage_expected"] in {"PD", "RD", "ID"}]
    with_discipline = [r for r in results if r["discipline_expected"] not in (None, "OTHER")]
    return {
        "split": split_name,
        "files": len(results),
        "doc_stage": {
            "source": "files_index.stage (кураторское поле)",
            "labelled": len(with_stage),
            "match": _rate(sum(r["stage"] == r["stage_expected"] for r in with_stage), len(with_stage)),
        },
        "discipline": {
            "source": "files_index.section (кураторское поле)",
            "labelled": len(with_discipline),
            "match": _rate(sum(r["discipline_match"] for r in with_discipline), len(with_discipline)),
        },
        "document_code": {
            "source": "META-DOC-CODE (машинная предразметка, не эталон)",
            "extracted": _rate(sum(1 for r in results if r["code_ours"]), len(results)),
            "labelled": len(with_code),
            "overlap": _rate(sum(r["code_match"] for r in with_code), len(with_code)),
        },
        "revision": {
            "source": "META-REVISION (машинная предразметка, не эталон)",
            "extracted": _rate(sum(1 for r in results if r["revision_ours"]), len(results)),
            "labelled": len(with_revision),
            "overlap": _rate(sum(r["revision_match"] for r in with_revision), len(with_revision)),
        },
        "mismatches": [
            {k: r[k] for k in ("file_id", "name", "stage", "stage_expected", "discipline", "discipline_expected")}
            for r in results
            if (r["stage_expected"] in {"PD", "RD", "ID"} and r["stage"] != r["stage_expected"])
            or (r["discipline_expected"] not in (None, "OTHER") and not r["discipline_match"])
        ][:10],
        "samples": results[:5],
    }
