"""Метрики компьютерного зрения против разметки организаторов (`inspector-ml eval cv`).

Что меряем и с чем сверяем — только открытая обучающая часть `РАЗМЕЧЕННЫЙ_TRAIN_PUBLIC_203`
(скрытую `РАЗМЕЧЕННЫЙ_TEST__213` не открываем):

- `pages` — нужен ли странице OCR: accuracy, precision / recall / F1 класса «нужен»; эталон —
  `page_index.needs_ocr`, 10 146 страниц;
- `stage` — стадия документа по штампу: accuracy, precision / recall / F1 по стадиям, macro-F1;
  эталон — `files_index.stage`;
- `localization` — страница и рамка доказательства: доля верных страниц, IoU ≥ 0.5 и попадание
  центра эталонной рамки внутрь нашей; эталон — проверки организаторов и выверенные аннотации
  с точной локализацией текста (`TEXT_EXACT`);
- `ocr` (по флагу) — Character Accuracy, CER, WER всего и отдельно для чертежей и текста; эталон —
  текстовый слой той же страницы.

Всё, кроме OCR, считается **по кешу разбора**: решение классификатора, штамп и извлечённые
значения там уже есть, поэтому 203 файла проходят за минуты, а не за часы. OCR — по исходным PDF:
его и надо мерить заново, когда меняются настройки.

**Про оси.** Рамки организаторов отсчитываются от нижнего края страницы, наши — от верхнего;
перед сравнением эталон переводится в наши координаты (`top_left`).

**Про IoU.** Рамка эталона обводит одно значение («B40»), а наше доказательство — ячейка таблицы
или абзац. IoU ≥ 0.5 (порог ТЗ) при такой разнице масштабов почти не проходит даже при верном месте,
поэтому рядом — попадание центра эталонной рамки внутрь нашей: это и есть «подсветили то место».
"""

from __future__ import annotations

import hashlib
import json
import time
from collections import Counter, defaultdict
from collections.abc import Callable, Mapping, Sequence
from itertools import pairwise
from pathlib import Path
from typing import Any

from inspector_ml.compare.keys import rule_group
from inspector_ml.contracts.events import MatrixParam
from inspector_ml.corpus.labels import Split, read_jsonl
from inspector_ml.eval.extract_metrics import PARAMETERS
from inspector_ml.metadata.document import document_metadata

STAGES = ("PD", "RD", "ID")
#: Смешанная папка разметки: верной считаем любую из двух стадий.
MIXED = {"RD_ID_MIXED": {"RD", "ID"}}
IOU_THRESHOLD = 0.5

Loader = Callable[[str], dict[str, Any] | None]


def cache_loader(storage: Path, parser_version: str) -> Loader:
    """Разобранный документ из кеша по sha256 исходного файла."""

    def load(sha256: str) -> dict[str, Any] | None:
        path = storage / "parsed" / sha256 / f"{parser_version}.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None

    return load


def evaluate_cv(
    split: Split, load: Loader, params: Mapping[str, MatrixParam], *, ocr_pages: int = 0, ocr: Any = None
) -> dict[str, Any]:
    """Сводный отчёт по всем разделам. `ocr_pages` > 0 — ещё и распознавание (долго, лучше на GPU)."""
    if split.name != "TRAIN_PUBLIC":
        raise ValueError("мерим только на открытой обучающей части: скрытую TEST не открываем")
    files = split.files()
    parsed = {row["file_id"]: load(row.get("source_sha256") or "") for row in files}
    report: dict[str, Any] = {
        "split": split.name,
        "files": len(files),
        "files_in_cache": sum(1 for doc in parsed.values() if doc is not None),
        "pages": page_metrics(split.pages(), parsed),
        "stage": stage_metrics(files, parsed),
        "localization": localization_metrics(split, files, parsed, params),
    }
    if ocr_pages:
        report["ocr"] = ocr_metrics(split, files, split.pages(), parsed, ocr, limit=ocr_pages)
    return report


# ------------------------------------------------------------------ классификатор страниц


def page_metrics(labels: Sequence[Mapping[str, Any]], parsed: Mapping[str, dict[str, Any] | None]) -> dict[str, Any]:
    """Совпадает ли наше решение «странице нужен OCR» с разметкой — по всем страницам кеша.

    Наше решение: страница ушла в распознавание (`source = OCR`) или классификатор счёл её
    текстовый слой негодным (`LOW_QUALITY`).
    """
    overall: Counter[tuple[bool, bool]] = Counter()
    by_source: dict[str, Counter[tuple[bool, bool]]] = defaultdict(Counter)
    for label in labels:
        document = parsed.get(label["file_id"])
        if document is None:
            continue
        pages = document.get("pages") or []
        number = int(label["source_page_number"])
        if not 1 <= number <= len(pages):
            continue
        page = pages[number - 1]
        ours = page.get("source") == "OCR" or page.get("quality") == "LOW_QUALITY"
        theirs = bool(label["needs_ocr"])
        overall[(ours, theirs)] += 1
        by_source[str(label.get("text_source"))][(ours, theirs)] += 1
    return {**_binary(overall), "by_text_source": {source: _binary(c) for source, c in sorted(by_source.items())}}


def _binary(matrix: Counter[tuple[bool, bool]]) -> dict[str, Any]:
    tp, fp, fn, tn = matrix[(True, True)], matrix[(True, False)], matrix[(False, True)], matrix[(False, False)]
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    total = tp + fp + fn + tn
    return {
        "pages": total,
        "accuracy": _round((tp + tn) / total if total else 0.0),
        "precision": _round(precision),
        "recall": _round(recall),
        "f1": _round(2 * precision * recall / (precision + recall) if precision + recall else 0.0),
        "confusion": {"tp": tp, "fp": fp, "fn": fn, "tn": tn},
    }


# ------------------------------------------------------------------ стадия по штампу


def stage_metrics(files: Sequence[Mapping[str, Any]], parsed: Mapping[str, dict[str, Any] | None]) -> dict[str, Any]:
    """Стадия, которую определяет разбор, против `files_index.stage`. `UNKNOWN` в разметке пропускаем."""
    pairs: list[tuple[set[str], str | None]] = []
    confusion: Counter[str] = Counter()
    for row in files:
        document = parsed.get(row["file_id"])
        truth = MIXED.get(row.get("stage") or "", {row.get("stage")} if row.get("stage") in STAGES else set())
        if document is None or not truth:
            continue
        name = Path(str(row.get("source_relative_path") or "")).name or None
        ours = document_metadata(document.get("pages") or [], file_name=name)["doc_stage"]
        pairs.append((truth, ours))
        confusion[f"{'/'.join(sorted(truth))} → {ours}"] += 1

    correct = sum(1 for truth, ours in pairs if ours in truth)
    per_stage: dict[str, dict[str, float]] = {}
    for stage in STAGES:
        tp = sum(1 for truth, ours in pairs if ours == stage and stage in truth)
        fp = sum(1 for truth, ours in pairs if ours == stage and stage not in truth)
        fn = sum(1 for truth, ours in pairs if stage in truth and len(truth) == 1 and ours != stage)
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        per_stage[stage] = {"precision": _round(precision), "recall": _round(recall), "f1": _round(f1)}
    return {
        "files": len(pairs),
        "accuracy": _round(correct / len(pairs) if pairs else 0.0),
        "macro_f1": _round(sum(s["f1"] for s in per_stage.values()) / len(per_stage)),
        "per_stage": per_stage,
        "confusion": dict(confusion.most_common()),
    }


# ------------------------------------------------------------------ локализация доказательства


def localization_metrics(
    split: Split,
    files: Sequence[Mapping[str, Any]],
    parsed: Mapping[str, dict[str, Any] | None],
    params: Mapping[str, MatrixParam],
) -> dict[str, Any]:
    """Страница и рамка доказательства против эталона — по параметрам, которые мы извлекаем."""
    by_id = {row["file_id"]: row for row in files}
    found_cache: dict[tuple[str, str], list[Any]] = {}

    def found(file_id: str, code: str) -> list[Any]:
        if (file_id, code) not in found_cache:
            document = parsed.get(file_id)
            param_code, extractor = PARAMETERS[code]
            param = params.get(param_code)
            pages = (document or {}).get("pages") or []
            found_cache[(file_id, code)] = extractor(param, pages) if param is not None and pages else []
        return found_cache[(file_id, code)]

    # страница: эталонные проверки, у каждой — файлы и страницы доказательств
    checks = [c for c in read_jsonl(split.data_dir / "public_gold_checks.jsonl") if c["parameter_code"] in PARAMETERS]
    page_hits = page_total = 0
    for check in checks:
        wanted = rule_group(check.get("location"))
        for evidence in check.get("evidence") or []:
            if evidence["file_id"] not in by_id or parsed.get(evidence["file_id"]) is None:
                continue
            page_total += 1
            items = found(evidence["file_id"], check["parameter_code"])
            page_hits += any(rule_group(i.rule_key) == wanted and i.page == evidence["pdf_page_number"] for i in items)

    # рамка: выверенные аннотации с точной локализацией текста
    boxes: list[dict[str, Any]] = []
    for note in split.annotations():
        if note.get("location_precision") != "TEXT_EXACT" or note.get("code") not in PARAMETERS:
            continue
        if note["annotation_type"] not in ("CONFIRMED_VIOLATION_EVIDENCE", "SECOND_REVIEW_CHECK"):
            continue
        if parsed.get(note["file_id"]) is None:
            continue
        wanted = rule_group(note.get("location"))
        ours = [
            i.bbox
            for i in found(note["file_id"], note["code"])
            if i.page == note["page_number"] and rule_group(i.rule_key) == wanted
        ]
        gold = gold_boxes(note)
        best = max((iou(box, g) for box in ours for g in gold), default=0.0)
        boxes.append(
            {
                "annotation": note["annotation_id"],
                "code": note["code"],
                "iou": _round(best),
                "center_inside": any(_contains(box, _center(g)) for box in ours for g in gold),
                "found_on_page": bool(ours),
            }
        )
    return {
        "page": {
            "evidence": page_total,
            "hits": page_hits,
            "accuracy": _round(page_hits / page_total if page_total else 0.0),
        },
        "bbox": {
            "annotations": len(boxes),
            "iou_ge_05": _round(sum(b["iou"] >= IOU_THRESHOLD for b in boxes) / len(boxes) if boxes else 0.0),
            "center_inside": _round(sum(b["center_inside"] for b in boxes) / len(boxes) if boxes else 0.0),
            "items": boxes,
        },
    }


def top_left(box: Sequence[float]) -> list[float]:
    """Рамка организаторов в наших координатах: начало — левый **верхний** угол.

    `bbox_normalized` в разметке отсчитывается от нижнего края страницы, как в самом PDF, хотя
    в описании выгрузки сказано обратное. Проверено 25.09 на обучающей части: из 60 полей штампа
    (`DOCUMENT_FIELD`) 58 совпадают с нашим блоком того же текста только при отражённой оси y.
    """
    x0, y0, x1, y1 = box
    return [x0, 1.0 - y1, x1, 1.0 - y0]


def gold_boxes(note: Mapping[str, Any]) -> list[list[float]]:
    """Рамки эталона в наших координатах — каждая отдельно.

    Аннотация бывает на несколько значений сразу («1000 | 1200 | 1500»): тогда `bbox_normalized` —
    общая рамка вокруг всех, и сравнивать с ней одну нашу ячейку нечестно. Берём отдельные рамки
    `boxes_pdf` (в пунктах, от нижнего края), нормируем по размеру страницы.
    """
    width, height = float(note.get("page_width") or 0), float(note.get("page_height") or 0)
    boxes = note.get("boxes_pdf") or []
    if width > 0 and height > 0 and boxes:
        return [top_left([b[0] / width, b[1] / height, b[2] / width, b[3] / height]) for b in boxes]
    return [top_left(note["bbox_normalized"])]


def iou(a: Sequence[float], b: Sequence[float]) -> float:
    """Пересечение по объединению двух рамок `[x0, y0, x1, y1]`."""
    width = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    height = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = width * height
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def _center(box: Sequence[float]) -> tuple[float, float]:
    return (box[0] + box[2]) / 2, (box[1] + box[3]) / 2


def _contains(box: Sequence[float], point: tuple[float, float]) -> bool:
    return box[0] <= point[0] <= box[2] and box[1] <= point[1] <= box[3]


# ------------------------------------------------------------------ OCR на постоянном наборе страниц


def ocr_sample(
    labels: Sequence[Mapping[str, Any]], limit: int, parsed: Mapping[str, dict[str, Any] | None] | None = None
) -> list[tuple[str, int]]:
    """Постоянный набор страниц с текстовым слоем: порядок по хешу — один и тот же при каждом прогоне.

    Сравнивать Accuracy можно только на одних и тех же страницах (в `docs/services/ml.md` видно, как
    смена четырёх страниц двигает цифру на 17 п.п.), поэтому выборка не случайная, а по хешу ключа.

    Эталон — текстовый слой, и он должен быть годным **и по разметке, и по нашему классификатору**:
    в трёх томах «Примера нарушений» разметка считает слой хорошим, а там мусор («Ɉ5M5EF6> E…»),
    и такие страницы давали Character Accuracy 0 при любом распознавании (замер 25.09).
    """

    def good_layer(file_id: str, number: int) -> bool:
        if parsed is None:
            return True
        pages = (parsed.get(file_id) or {}).get("pages") or []
        if not 1 <= number <= len(pages):
            return False
        page = pages[number - 1]
        if page.get("source") == "OCR" or page.get("quality") != "OK":
            return False
        return reference_is_valid(" ".join(str(b.get("text") or "") for b in page.get("blocks") or []))

    usable = [
        (row["file_id"], int(row["source_page_number"]))
        for row in labels
        if row.get("text_source") == "PDF_TEXT_LAYER"
        and not row.get("needs_ocr")
        and good_layer(row["file_id"], int(row["source_page_number"]))
    ]
    usable.sort(key=lambda key: hashlib.sha256(f"{key[0]}:{key[1]}".encode()).hexdigest())
    return usable[:limit]


#: Доля кириллицы среди букв, ниже которой текстовый слой русского документа — не текст, а мусор.
MIN_CYRILLIC = 0.5
#: Доля слов, повторяющих предыдущее, выше которой слой продублирован (текст напечатан поверх себя).
MAX_REPEATS = 0.2


def reference_is_valid(text: str) -> bool:
    """Годится ли текстовый слой страницы эталоном для OCR.

    Замер 25.09 на обучающей части нашёл два вида негодного эталона, на которых Character Accuracy
    выходил 0 при любом распознавании:

    - **мусор вместо кириллицы**, который не поймал и наш классификатор: «D545?L=O5 (<<=<<4?L=O5»,
      «8" 9 39 6 rF I 9r» — шрифт без таблицы кодов;
    - **продублированный слой**: «Заказчик: Заказчик: Заказчик: Заказчик:» — текст напечатан поверх
      себя, и эталон вчетверо длиннее того, что видно на странице.
    """
    letters = [ch for ch in text if ch.isalpha()]
    if not letters:
        return False
    cyrillic = sum(1 for ch in letters if "Ѐ" <= ch <= "ӿ")
    if cyrillic / len(letters) < MIN_CYRILLIC:
        return False
    words = text.split()
    repeats = sum(1 for previous, word in pairwise(words) if previous == word)
    return repeats / max(len(words) - 1, 1) <= MAX_REPEATS


def ocr_metrics(
    split: Split,
    files: Sequence[Mapping[str, Any]],
    labels: Sequence[Mapping[str, Any]],
    parsed: Mapping[str, dict[str, Any] | None],
    options: Any,
    *,
    limit: int,
) -> dict[str, Any]:
    """Character Accuracy, CER и WER на постоянном наборе страниц — всего и отдельно чертежи и текст."""
    import pymupdf

    from inspector_ml.eval.ocr_metrics import score_page
    from inspector_ml.storage.files import long_path

    # MuPDF печатает свои предупреждения («missing font descriptor») прямо в stdout, а там — JSON отчёта
    pymupdf.TOOLS.mupdf_display_errors(False)
    by_id = {row["file_id"]: row for row in files}
    chosen = ocr_sample(labels, limit, parsed)
    kinds: dict[str, list[Any]] = defaultdict(list)
    per_page: list[dict[str, Any]] = []
    started = time.monotonic()
    for file_id, number in chosen:
        row = by_id.get(file_id)
        if row is None:
            continue
        pages = (parsed.get(file_id) or {}).get("pages") or []
        kind = "drawing" if number <= len(pages) and pages[number - 1].get("is_drawing") else "text"
        with pymupdf.open(long_path(split.source_path(row))) as document:
            score = score_page(document, number - 1, options)
        kinds[kind].append(score)
        per_page.append(
            {
                "page": f"{file_id}:{number}",
                "kind": kind,
                "accuracy": score.accuracy,
                "page_accuracy": score.page_accuracy,
                "reference_chars": score.reference_chars,
                "recognized_chars": score.recognized_chars,
            }
        )
    return {
        "sample": [f"{file_id}:{number}" for file_id, number in chosen],
        "seconds_per_page": _round((time.monotonic() - started) / len(chosen) if chosen else 0.0),
        "dpi": getattr(options, "dpi", None),
        **_ocr_summary([score for scores in kinds.values() for score in scores]),
        "by_kind": {kind: _ocr_summary(scores) for kind, scores in sorted(kinds.items())},
        "by_page": per_page,
    }


def _ocr_summary(scores: Sequence[Any]) -> dict[str, Any]:
    reference = sum(s.reference_chars for s in scores)
    accuracy = sum(s.accuracy * s.reference_chars for s in scores) / reference if reference else 0.0
    by_page = sum(s.page_accuracy * s.reference_chars for s in scores) / reference if reference else 0.0
    return {
        "pages": len(scores),
        "character_accuracy": _round(accuracy),
        "cer": _round(1.0 - accuracy),
        "page_character_accuracy": _round(by_page),
        "wer": _round(sum(s.wer for s in scores) / len(scores) if scores else 0.0),
    }


def _round(value: float) -> float:
    return round(value, 4)
