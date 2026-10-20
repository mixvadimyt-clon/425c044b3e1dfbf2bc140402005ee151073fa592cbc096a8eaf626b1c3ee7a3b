"""Оборудование отопления есть в ПД и не упомянуто в РД — гипотеза без модели (FREE-HEATING).

Зачем. Четыре из десяти зачётных проверок открытого эталона — FREE-HEATING-001 на «Тюменской 5»: в ПД тёплый пол в
раздевальных и санузлах МГН 267, 270, 271, 272 предусмотрен, в РД его нет. Свободный поиск языковой моделью (semantic)
доказательство находит, но помещения называет соседние: план отопления РД — линии и подписи шрифтом САПР, по тексту
не видно, где тёплого пола нет. А сама модель в сдаче — только если GPU-образ соберётся. Между тем признак простой:

- **ПД:** на схеме отопления подпись «Регулятор для системы "тёплый пол" Multibox C/RTL» стоит у подписей «267, 270» и
  «271, 272» (лист 21, стр. 99), в пояснительной записке — «система подогрева полов (тёплые полы)»;
- **РД:** в документах ОВ — ни в текстовом слое, ни в подписях планов, распознанных для вентиляции (`cad_ocr`), тёплого
  пола нет ни разу.

Гипотеза: «тёплый пол по ПД у помещений …, в РД ОВ не упомянут» с доказательствами на листе ПД и на листах РД, где эти
помещения есть. Нарушение ли это — решает инспектор. На «Новослободской» наоборот — тёплый пол есть в РД и не
упомянут в ПД; это правило там молчит, «в РД есть» — не его вопрос.

**С 17.10 — не только тёплый пол** (`EQUIPMENT`): внутрипольные конвекторы, тепловые завесы, фанкойлы,
тепловентиляторы и воздухонагреватели, электроотопление. Схема та же, отдельно для каждого типа: подпись на чертеже
ПД рядом с помещениями, ни одного упоминания типа в РД ОВ, те же помещения на планах РД. Обычные радиаторы и
конвекторы не берём: они есть почти в любом разделе отопления, и «нет в РД» для них скорее значит, что текст РД
нарисован шрифтом САПР на листе без OCR. На трёх обучающих объектах новые типы гипотез не дали — ни верных, ни
ложных: фанкойлы «Тюменской 5» есть только в легенде схем кондиционирования, внутрипольные конвекторы
«Алтуфьевского» — в записке и легенде, рядом с помещениями их нет. На «Речникове» РД ОВ нет, правило молчит.
"""

from __future__ import annotations

import math
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from inspector_ml.compare import pagepairs
from inspector_ml.compare.keys import suspicion_key
from inspector_ml.contracts.events import EvidenceFragment, PagePairResult, SuspicionResult
from inspector_ml.extract.api import LoadedDocument
from inspector_ml.logging import get_logger
from inspector_ml.suspicion.semantic import system

log = get_logger(__name__)

DISCOVERY_METHOD = "SEMANTIC_DISSONANCE"
#: Уверенность: признак — отсутствие упоминания, а подпись в РД могла быть нарисована шрифтом САПР на листе без OCR.
#: Выше порога выгрузки FREE-* в api (`SUBMISSION_FREE_MIN_CONFIDENCE`, 0,5), ниже гипотез с совпавшим текстом (0,6).
CONFIDENCE = 0.55
#: «Тёплый пол», «тёплые полы», «подогрев полов» — но не «теплоносителя, полученного».
WARM_FLOOR = re.compile(r"(?i)т[её]пл(?:ый|ые|ых|ого|ому|ым|ыми|ом)\W{0,3}пол|подогрев\w*\W{0,3}пол")


@dataclass(frozen=True)
class Equipment:
    key: str
    name: str
    """Как назвать в гипотезе: «Тёплый пол», «Тепловые завесы»."""
    absent: str
    """Окончание фразы об отсутствии в РД: «не упомянут», «не упомянуты»."""
    pattern: re.Pattern[str]


EQUIPMENT = (
    Equipment("warm-floor", "Тёплый пол", "не упомянут", WARM_FLOOR),
    Equipment(
        "floor-convector", "Внутрипольные конвекторы", "не упомянуты", re.compile(r"(?i)внутрипольн\w*\W{0,3}конвектор")
    ),
    Equipment("air-curtain", "Тепловые завесы", "не упомянуты", re.compile(r"(?i)(?:теплов|воздушн)\w*\W{0,3}завес")),
    Equipment("fan-coil", "Фанкойлы", "не упомянуты", re.compile(r"(?i)фанкойл|фэнкойл")),
    Equipment(
        "air-heater",
        "Тепловентиляторы и воздухонагреватели",
        "не упомянуты",
        re.compile(r"(?i)тепловентилятор|воздухонагревател"),
    ),
    Equipment(
        "electric-heating",
        "Электроотопление",
        "не упомянуто",
        re.compile(r"(?i)электроконвектор|электрообогрев|электрическ\w*\W{0,3}(?:отоплени|конвектор|радиатор|обогрев)"),
    ),
)
ROOM = re.compile(r"(?<![\d.,])(\d{3})(?:\.\d)?(?![\d.])")
#: Помещения у подписи тёплого пола на схеме ПД: не дальше стольких пунктов от неё (около 7 см на листе).
NEAR_PT = 200.0
#: Листы РД с помещениями — не больше стольких в доказательствах.
MAX_RD_PAGES = 2


def run(
    docs: Sequence[LoadedDocument], object_id: object, page_pairs: Sequence[PagePairResult] = ()
) -> list[SuspicionResult]:
    heating = [doc for doc in docs if system(doc) == "ОВ"]
    pd_docs = [doc for doc in heating if doc.stage == "PD"]
    rd_docs = [doc for doc in heating if doc.stage == "RD"]
    if not pd_docs or not rd_docs:
        return []
    found = []
    for kind in EQUIPMENT:
        hypothesis = _gap(kind, pd_docs, rd_docs, object_id, page_pairs)
        if hypothesis is not None:
            found.append(hypothesis)
    return found


def _gap(
    kind: Equipment,
    pd_docs: list[LoadedDocument],
    rd_docs: list[LoadedDocument],
    object_id: object,
    page_pairs: Sequence[PagePairResult],
) -> SuspicionResult | None:
    """Одна гипотеза на тип: одна система тёплого пола — одна гипотеза, продолжения схемы её не множат."""
    mentioned = [(doc, page["page"]) for doc in rd_docs for page in doc.pages if _mentions(page, kind.pattern)]
    if mentioned:
        log.debug("heating_gap_rd_mentions", kind=kind.key, pages=len(mentioned))
        return None
    for doc in pd_docs:
        for page in doc.pages:
            if not page.get("is_drawing"):
                continue
            label = next((b for b in page.get("blocks") or [] if kind.pattern.search(b.get("text") or "")), None)
            if label is None or len(label.get("bbox") or []) != 4:
                continue
            rooms = _rooms_near(page, label["bbox"], kind.pattern)
            if not rooms:
                continue
            rd_pages = _rd_pages(rd_docs, rooms)
            if rd_pages:
                return _hypothesis(kind, doc, page, label, rooms, rd_pages, object_id, page_pairs)
    return None


def _mentions(page: dict[str, Any], pattern: re.Pattern[str]) -> bool:
    texts = [b.get("text") or "" for b in page.get("blocks") or []]
    texts += [line.get("text") or "" for line in page.get("cad_ocr") or []]
    return any(pattern.search(text) for text in texts)


def _rooms_near(page: dict[str, Any], label: list[float], pattern: re.Pattern[str]) -> list[str]:
    """Номера помещений в подписях не дальше `NEAR_PT` от подписи оборудования, по порядку на листе."""
    width, height = float(page.get("width_pt") or 0), float(page.get("height_pt") or 0)
    if not width or not height:
        return []
    lx, ly = _center(label)
    rooms: list[str] = []
    for block in page.get("blocks") or []:
        bbox = block.get("bbox") or []
        text = block.get("text") or ""
        if len(bbox) != 4 or block.get("type") == "title_block" or pattern.search(text):
            continue
        bx, by = _center(bbox)
        # схема по этажам: подпись относится к своему ряду и ниже, ряд этажа выше — уже другой этаж
        if by < label[1] or math.hypot((bx - lx) * width, (by - ly) * height) > NEAR_PT:
            continue
        rooms += [room for room in ROOM.findall(text) if room not in rooms]
    return sorted(rooms)


def _rd_pages(rd_docs: list[LoadedDocument], rooms: list[str]) -> list[tuple[LoadedDocument, dict[str, Any], dict]]:
    """Листы-чертежи РД ОВ с этими помещениями (не меньше половины) — лучший лист каждого документа и блок помещения.

    По листу на документ, а не просто лучшие: план вентиляции ОВ1 перечисляет помещения той же экспликацией, что и
    план отопления ОВ2.1, а заголовки листов нарисованы шрифтом САПР — по тексту их не различить.
    """
    best: dict[str, tuple[int, LoadedDocument, dict[str, Any], dict]] = {}
    for doc in rd_docs:
        for page in doc.pages:
            if not page.get("is_drawing"):
                continue
            blocks = [b for b in page.get("blocks") or [] if len(b.get("bbox") or []) == 4]
            present = {room for b in blocks for room in ROOM.findall(b.get("text") or "") if room in rooms}
            if 2 * len(present) < len(rooms) or len(present) <= best.get(str(doc.file_id), (0,))[0]:
                continue
            block = next(b for b in blocks if set(ROOM.findall(b.get("text") or "")) & present)
            best[str(doc.file_id)] = (len(present), doc, page, block)
    ranked = sorted(best.values(), key=lambda item: -item[0])
    return [(doc, page, block) for _n, doc, page, block in ranked[:MAX_RD_PAGES]]


def _hypothesis(
    kind: Equipment,
    pd: LoadedDocument,
    pd_page: dict[str, Any],
    label: dict[str, Any],
    rooms: list[str],
    rd_pages: list[tuple[LoadedDocument, dict[str, Any], dict]],
    object_id: object,
    page_pairs: Sequence[PagePairResult],
) -> SuspicionResult:
    quote = " ".join((label.get("text") or "").split())
    evidence = [_fragment(pd, pd_page, label, "EXPECTED")]
    evidence += [_fragment(doc, page, block, "ACTUAL") for doc, page, block in rd_pages]
    rd_refs = ", ".join(
        f"{doc.metadata.document_code or doc.file_id}, стр. {page['page']}" for doc, page, _b in rd_pages
    )
    description = (
        f"{kind.name}: в ПД на чертеже «{quote}» у помещений {', '.join(rooms)}; в РД ОВ {kind.absent} ни в тексте, "
        f"ни в распознанных подписях планов. Проверьте планы РД ({rd_refs}): предусмотрено ли это оборудование в этих "
        "помещениях."
    )
    return SuspicionResult.model_validate(
        {
            "suspicion_key": suspicion_key(object_id, "HEATING_GAP", f"{kind.key}|{','.join(rooms)}"),
            "discovery_method": DISCOVERY_METHOD,
            "confidence": CONFIDENCE,
            "description": description,
            "pd_reference": f"{pd.metadata.document_code or pd.file_id}, стр. {pd_page['page']}",
            "rd_reference": rd_refs,
            "id_reference": None,
            "review_priority": "MEDIUM",
            "rule_id": None,
            "page_pair_key": pagepairs.key_for(evidence, page_pairs),
            "evidence": evidence,
        }
    )


def _fragment(doc: LoadedDocument, page: dict[str, Any], block: dict, role: str) -> EvidenceFragment:
    text = " ".join((block.get("text") or "").split())
    return EvidenceFragment.model_validate(
        {
            "role": role,
            "file_id": str(doc.file_id),
            "sha256": doc.sha256,
            "stage": doc.stage,
            "document_code": doc.metadata.document_code,
            "revision": doc.metadata.revision,
            "approval_status": getattr(doc.metadata.approval_status, "root", doc.metadata.approval_status) or "UNKNOWN",
            "page": int(page["page"]),
            "bbox": [round(v, 5) for v in block["bbox"]],
            "extracted_value": text[:200],
            "normalized_value": None,
            "text_snippet": text[:300],
            "source": page.get("source") or "TEXT_LAYER",
            "quality": page.get("quality") or "OK",
            "confidence": page.get("ocr_confidence"),
        }
    )


def _center(bbox: list[float]) -> tuple[float, float]:
    return (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
