"""Листы-чертежи ПД ↔ РД ↔ ИД: совмещение растров и гипотеза о различиях.

Зачем. Куратор загрузил пару «Ситуационный план, М 1:2000»: в ПД на подложке канализация
(`d=200-225`, выпуски К1), в РД — водопровод (`d=300`, `d=250`, колодцы 70278…65265). Сам план в
обоих листах — растр, и система ответила «Нет доказательств» по всем 132 параметрам. Числа с чертежа
не станут параметрами матрицы, но показать инспектору, *где* листы расходятся, можно и нужно.

Как:

1. **Листы-чертежи.** Страница с растром не меньше `sheetdiff.MIN_SHARE` листа и коротким текстом
   (разобранный текст вне штампа — меньше `MAX_TEXT_CHARS`): так отсекаются сканы записок и актов,
   где распознанного текста много. Растр берётся из исходного файла — `STORAGE_DIR/raw/{sha256}`,
   общего для api и ml; разбор и его кеш не меняются.
2. **Пары.** Каждый лист ПД сравнивается с листами РД и ИД; парой считается лист, с которым растры
   совмещаются (`sheetdiff.align`). Разные чертежи не совмещаются — гипотезы нет.
3. **Различия и подписи.** Области, где на одном листе есть линии и подписи, которых нет рядом на
   другом. Если есть OCR, подписи читаются только в этих областях и в полосе заголовка — весь лист
   на процессоре распознаётся дольше 30 секунд, а области — за секунды.
4. **Результат** — гипотеза `VISUAL_DIFF` с низкой уверенностью и рамками на обоих листах, плюс пара
   листов с гомографией и областями различий: экран сравнения показывает наложение.
   `CONFIRMED_VIOLATION` ставит только инспектор.
"""

from __future__ import annotations

import hashlib
import re
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pymupdf

from inspector_ml.compare.keys import suspicion_key
from inspector_ml.contracts.events import EvidenceFragment, PagePairResult, SuspicionResult
from inspector_ml.cv import sheetdiff
from inspector_ml.extract.api import LoadedDocument
from inspector_ml.extract.normalize import collapse
from inspector_ml.logging import get_logger
from inspector_ml.ocr.base import OcrEngine
from inspector_ml.ocr.render import tiles
from inspector_ml.storage.files import long_path

log = get_logger(__name__)

DISCOVERY_METHOD = "VISUAL_DIFF"
#: Уверенность гипотезы: совмещение надёжное, но различие на чертеже — ещё не нарушение.
CONFIDENCE = 0.35
#: Больше стольких символов разобранного текста — это записка или акт, а не чертёж.
MAX_TEXT_CHARS = 600
#: Сколько листов-чертежей берём со стадии и сколько пар проверяем: время сравнения ограничено.
MAX_SHEETS = 12
MAX_PAIR_CHECKS = 60
#: Разрешение для чтения подписей в областях различий: мелкие подписи сетей читаются с 200 dpi.
OCR_DPI = 250
#: Сколько секунд за проверку отдаём OCR подписей. Кончилось — гипотеза без подписей.
OCR_BUDGET_S = 25.0
#: Полоса заголовка — верхняя часть растра, где пишут «Ситуационный план, М 1:2000».
TITLE_BAND = 0.2
#: Сколько областей показываем в доказательствах с каждой стороны.
EVIDENCE_REGIONS = 2
STAGES = ("RD", "ID")
STAGE_NAME = {"PD": "ПД", "RD": "РД", "ID": "ИД"}

TITLE = re.compile(
    r"((?:ситуационн\w*|генеральн\w*|сводн\w*|схем\w*)?\s*(?:план|разрез|фасад|схем[аы]|генплан)\w*[^|\n]{0,50}?"
    r"М\s*1\s*:\s*\d+)",
    re.IGNORECASE,
)
SCALE = re.compile(r"М\s*1\s*:\s*\d+", re.IGNORECASE)
#: Подписи, которые что-то говорят о сети: диаметры, системы, номера колодцев.
LABELS = (
    re.compile(r"\b[dD]\s*=\s*\d{2,4}(?:\s*[-–]\s*\d{2,4})?"),
    re.compile(r"[ØøФ⌀∅]\s*\d{2,4}"),
    re.compile(r"\bДу\s*\d{2,4}\b"),
    re.compile(r"(?<![\wА-Яа-яЁё])[КKВBТT][1-4](?:[.-]\d{1,2})?(?![\w])"),
    re.compile(r"(?<!\d)\d{5}(?!\d)"),
)


@dataclass
class Sheet:
    doc: LoadedDocument
    stage: str
    page: int
    raster: sheetdiff.Raster
    title: str | None
    features: sheetdiff.Features = field(repr=False)


def run(
    docs: Sequence[LoadedDocument],
    storage_dir: Path,
    object_id: object,
    engine: OcrEngine | None = None,
) -> tuple[list[SuspicionResult], list[PagePairResult]]:
    """Гипотезы о различиях листов-чертежей и пары листов с совмещением."""
    opened: dict[str, pymupdf.Document] = {}
    try:
        sheets = _sheets(docs, storage_dir, opened)
        reference = sheets.get("PD", [])
        if not reference:
            return [], []
        budget = _Budget(OCR_BUDGET_S)
        suspicions: list[SuspicionResult] = []
        pairs: list[PagePairResult] = []
        for left, right, diff in _matches(reference, [s for stage in STAGES for s in sheets.get(stage, [])]):
            if not diff.regions:
                continue
            hypothesis, pair = _hypothesis(left, right, diff, object_id, engine, budget, opened)
            suspicions.append(hypothesis)
            pairs.append(pair)
        return suspicions, pairs
    finally:
        for document in opened.values():
            document.close()


def labels(texts: Sequence[str]) -> list[str]:
    """Подписи сетей из распознанного текста в порядке появления: d=300, К1, колодец 70278."""
    found: list[str] = []
    for text in texts:
        for pattern in LABELS:
            for match in pattern.finditer(text):
                label = re.sub(r"\s+", "", match.group(0)).replace("K", "К").replace("B", "В").replace("T", "Т")
                if label.isdigit() and len(set(label)) == 1:
                    continue  # «00000» — мусор распознавания
                if label not in found:
                    found.append(label)
    return found


def title_of(texts: Sequence[str]) -> str | None:
    """Заголовок листа с масштабом: «Ситуационный план, М 1:2000»."""
    for pattern, group in ((TITLE, 1), (SCALE, 0)):
        for text in texts:
            match = pattern.search(collapse(text))
            if match:
                title = collapse(match.group(group))
                # «М1:2000» → «М 1:2000»; «Ситуационныйплан» (OCR скана склеивает слова) → «Ситуационный план»
                title = re.sub(r"М\s*1\s*:\s*(\d+)", r"М 1:\1", title, flags=re.I)
                title = re.sub(r"((?:ситуационн|генеральн|сводн)\w*?)(план)", r"\1 \2", title, flags=re.I)
                return title.strip(" ,.")
    return None


class _Budget:
    def __init__(self, seconds: float) -> None:
        self.deadline = time.monotonic() + seconds

    @property
    def left(self) -> bool:
        return time.monotonic() < self.deadline


def _sheets(
    docs: Sequence[LoadedDocument], storage_dir: Path, opened: dict[str, pymupdf.Document]
) -> dict[str, list[Sheet]]:
    """Листы-чертежи по стадиям: растр на заметной доле листа и мало разобранного текста.

    Два прохода, потому что комплект — это сотни документов и тысячи страниц. Сначала — размер самой
    крупной картинки по ресурсам страницы, без её загрузки. Потом по убыванию размера — место картинки
    на листе (дорого: текстовый слой страницы), растр и особые точки, пока в стадии не наберётся
    `MAX_SHEETS` листов. Без ПД сравнивать не с чем, поэтому другие стадии без неё не смотрим.
    """
    pending: dict[str, list[tuple[int, LoadedDocument, int, str | None]]] = {}
    ordered = sorted(docs, key=lambda d: str(d.stage) != "PD")
    for doc in ordered:
        stage = str(doc.stage)
        if stage != "PD" and not pending.get("PD"):
            break
        candidates = [p for p in doc.pages if len(_page_text(p)) <= MAX_TEXT_CHARS]
        document = _open(doc, storage_dir, opened) if candidates else None
        if document is None:
            continue
        for parsed in candidates:
            number = int(parsed.get("page") or 0)
            if not 1 <= number <= document.page_count:
                continue
            pixels = sheetdiff.image_pixels(document, number - 1)
            if pixels:
                pending.setdefault(stage, []).append((pixels, doc, number, title_of([_page_text(parsed)])))

    by_stage: dict[str, list[Sheet]] = {}
    keep: set[str] = set()
    for stage, items in pending.items():
        # крупные растры вперёд: чертёж обычно занимает лист целиком или большую его часть
        items.sort(key=lambda item: -item[0])
        sheets = by_stage.setdefault(stage, [])
        for _pixels, doc, number, title in items:
            if len(sheets) >= MAX_SHEETS:
                break
            page = opened[doc.sha256][number - 1]
            region = sheetdiff.drawing_region(page)
            if region is None:
                continue
            raster = sheetdiff.Raster(sheetdiff.render(page, region), region)
            sheets.append(Sheet(doc, stage, number, raster, title, sheetdiff.features(raster.image)))
            keep.add(doc.sha256)
    for sha in [sha for sha in opened if sha not in keep]:
        opened.pop(sha).close()
    return by_stage


def _open(doc: LoadedDocument, storage_dir: Path, opened: dict[str, pymupdf.Document]) -> pymupdf.Document | None:
    """Исходный PDF из общего хранилища; нет файла или это не PDF — `None`."""
    if doc.sha256 in opened:
        return opened[doc.sha256]
    source = long_path(storage_dir / "raw" / doc.sha256)
    if not source.is_file():
        log.debug("visual_source_missing", sha256=doc.sha256)
        return None
    try:
        document = pymupdf.open(source)
    except Exception as exc:  # DOCX, XML или битый файл — чертежей в нём не ищем
        log.debug("visual_source_unreadable", sha256=doc.sha256, reason=str(exc))
        return None
    if not document.is_pdf:
        document.close()
        return None
    opened[doc.sha256] = document
    return document


def _matches(reference: list[Sheet], others: list[Sheet]) -> list[tuple[Sheet, Sheet, sheetdiff.SheetDiff]]:
    """Пары «лист ПД — лист РД/ИД», которые совмещаются; каждый лист — не больше чем в одной паре на стадию."""
    checks = 0
    candidates: list[tuple[int, Sheet, Sheet, sheetdiff.SheetDiff]] = []
    for left in reference:
        for right in others:
            if left.doc.file_id == right.doc.file_id or checks >= MAX_PAIR_CHECKS:
                continue
            checks += 1
            diff = sheetdiff.compare(left.raster, right.raster, left.features, right.features)
            if diff is not None:
                candidates.append((diff.inliers, left, right, diff))
    candidates.sort(key=lambda c: -c[0])
    used: set[tuple[str, int, str]] = set()
    chosen = []
    for _inliers, left, right, diff in candidates:
        keys = {(str(left.doc.file_id), left.page, right.stage), (str(right.doc.file_id), right.page, "")}
        if keys & used:
            continue
        used |= keys
        chosen.append((left, right, diff))
    return chosen


def _hypothesis(
    left: Sheet,
    right: Sheet,
    diff: sheetdiff.SheetDiff,
    object_id: object,
    engine: OcrEngine | None,
    budget: _Budget,
    opened: dict[str, pymupdf.Document],
) -> tuple[SuspicionResult, PagePairResult]:
    only_left = [r for r in diff.regions if r.side == "left"]
    only_right = [r for r in diff.regions if r.side == "right"]
    left_by_region = _region_labels(left, [r.left_box for r in only_left], engine, budget, opened)
    right_by_region = _region_labels(right, [r.right_box for r in only_right], engine, budget, opened)
    # подпись, которая есть в областях обоих листов, — не различие, а общая часть плана
    common = {label for found in left_by_region for label in found} & {
        label for found in right_by_region for label in found
    }
    left_by_region = [[label for label in found if label not in common] for found in left_by_region]
    right_by_region = [[label for label in found if label not in common] for found in right_by_region]
    left_labels = list(dict.fromkeys(label for found in left_by_region for label in found))
    right_labels = list(dict.fromkeys(label for found in right_by_region for label in found))
    # заголовок из растра надёжнее разобранного текста: OCR при разборе склеивает слова («Ситуационныйплан»)
    title = (
        _band_title(right, engine, budget, opened)
        or _band_title(left, engine, budget, opened)
        or left.title
        or right.title
    )

    right_name = STAGE_NAME.get(right.stage, right.stage)
    head = f"Лист-чертёж «{title}»" if title else "Лист-чертёж (растр)"
    parts = [f"{head}: после совмещения ПД и {right_name} различаются {len(diff.regions)} обл."]
    if left_labels:
        parts.append(f"Только в ПД: {', '.join(left_labels)}.")
    if right_labels:
        parts.append(f"Только в {right_name}: {', '.join(right_labels)}.")
    parts.append("Возможно, на листах разные сети или изменена трасса — проверьте.")
    description = " ".join(parts)

    key = suspicion_key(object_id, "VISUAL_DIFF", f"{left.doc.file_id}|{left.page}|{right.doc.file_id}|{right.page}")
    # рамки на обоих листах: где отличие есть и где его нет; подписи — своей области
    left_side = [(r, found) for r, found in zip(only_left, left_by_region, strict=True)] or [
        (r, []) for r in only_right
    ]
    right_side = [(r, found) for r, found in zip(only_right, right_by_region, strict=True)] or [
        (r, []) for r in only_left
    ]
    evidence = [
        *(_fragment(left, "EXPECTED", r.left_box, found) for r, found in left_side[:EVIDENCE_REGIONS]),
        *(_fragment(right, "ACTUAL", r.right_box, found) for r, found in right_side[:EVIDENCE_REGIONS]),
    ]
    suspicion = SuspicionResult.model_validate(
        {
            "suspicion_key": key,
            "discovery_method": DISCOVERY_METHOD,
            "confidence": CONFIDENCE,
            "description": description,
            "pd_reference": _reference(left),
            "rd_reference": _reference(right) if right.stage == "RD" else None,
            "id_reference": _reference(right) if right.stage == "ID" else None,
            "review_priority": "MEDIUM",
            "rule_id": None,
            "page_pair_key": _pair_key(left, right),
            "evidence": evidence,
        }
    )
    pair = PagePairResult.model_validate(
        {
            "pair_key": _pair_key(left, right),
            "left": {"file_id": left.doc.file_id, "page": left.page},
            "right": {"file_id": right.doc.file_id, "page": right.page},
            "match_score": diff.inlier_ratio,
            "homography": diff.homography,
            "diff_regions": [
                {
                    "left_bbox": list(r.left_box),
                    "right_bbox": list(r.right_box),
                    "score": round(r.share, 4),
                    "label": f"только в {'ПД' if r.side == 'left' else right_name}",
                    "suspicion_key": key,
                }
                for r in diff.regions
            ],
        }
    )
    return suspicion, pair


def _region_labels(
    sheet: Sheet,
    boxes: list[sheetdiff.BoxN],
    engine: OcrEngine | None,
    budget: _Budget,
    opened: dict[str, pymupdf.Document],
) -> list[list[str]]:
    """Подписи каждой области различия: разобранный текст листа и OCR области, пока есть время."""
    blocks = [
        block
        for parsed in sheet.doc.pages
        if int(parsed.get("page") or 0) == sheet.page
        for block in parsed.get("blocks") or []
    ]
    found: list[list[str]] = []
    for index, box in enumerate(boxes):
        texts = [block.get("text") or "" for block in blocks if _inside(block.get("bbox"), box)]
        if engine is not None and index <= EVIDENCE_REGIONS and budget.left:
            texts.extend(_ocr(sheet, _grow(box, 0.02), engine, opened))
        found.append(labels(texts))
    return found


def _band_title(
    sheet: Sheet, engine: OcrEngine | None, budget: _Budget, opened: dict[str, pymupdf.Document]
) -> str | None:
    if engine is None or not budget.left:
        return None
    x0, y0, x1, y1 = sheet.raster.region
    return title_of(_ocr(sheet, (x0, y0, x1, y0 + (y1 - y0) * TITLE_BAND), engine, opened))


def _ocr(sheet: Sheet, box: sheetdiff.BoxN, engine: OcrEngine, opened: dict[str, pymupdf.Document]) -> list[str]:
    document = opened.get(sheet.doc.sha256)
    if document is None:
        return []
    image = sheetdiff.render(document[sheet.page - 1], box, OCR_DPI)
    found: list[str] = []
    for tile in tiles(image, 1600, 160):
        try:
            found.extend(line.text for line in engine.recognize(tile.image) if line.confidence >= 0.5)
        except Exception as exc:  # распознавание — только подписи к гипотезе, ронять сравнение нельзя
            log.warning("visual_ocr_failed", reason=str(exc))
            return found
    return found


def _fragment(sheet: Sheet, role: str, box: sheetdiff.BoxN, found: list[str]) -> EvidenceFragment:
    parsed = next((p for p in sheet.doc.pages if int(p.get("page") or 0) == sheet.page), {})
    metadata = sheet.doc.metadata
    return EvidenceFragment.model_validate(
        {
            "role": role,
            "file_id": sheet.doc.file_id,
            "sha256": sheet.doc.sha256,
            "stage": sheet.stage,
            "document_code": metadata.document_code,
            "revision": metadata.revision,
            "approval_status": getattr(metadata.approval_status, "root", metadata.approval_status) or "UNKNOWN",
            "page": sheet.page,
            "bbox": [round(v, 4) for v in box],
            "text_snippet": ", ".join(found) if found else "область различия на листе-чертеже",
            "source": parsed.get("source") or "OCR",
            "quality": parsed.get("quality") or "OK",
            "confidence": CONFIDENCE,
        }
    )


def _reference(sheet: Sheet) -> str:
    name = sheet.doc.metadata.document_code or str(sheet.doc.file_id)
    return f"{name}, стр. {sheet.page}"


def _pair_key(left: Sheet, right: Sheet) -> str:
    """Тот же вид ключа, что у пар листов (`cv.pairing.pair_key`): одинаковые листы — одна пара."""
    raw = f"{left.doc.file_id}|{left.page}|{right.doc.file_id}|{right.page}"
    return hashlib.sha1(raw.encode()).hexdigest()


def _page_text(parsed: dict[str, Any]) -> str:
    return " ".join(
        block.get("text") or "" for block in parsed.get("blocks") or [] if block.get("type") != "title_block"
    ).strip()


def _grow(box: sheetdiff.BoxN, margin: float) -> sheetdiff.BoxN:
    return (max(0.0, box[0] - margin), max(0.0, box[1] - margin), min(1.0, box[2] + margin), min(1.0, box[3] + margin))


def _inside(bbox: Any, box: sheetdiff.BoxN) -> bool:
    if not bbox or len(bbox) != 4:
        return False
    cx, cy = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
    return box[0] <= cx <= box[2] and box[1] <= cy <= box[3]
