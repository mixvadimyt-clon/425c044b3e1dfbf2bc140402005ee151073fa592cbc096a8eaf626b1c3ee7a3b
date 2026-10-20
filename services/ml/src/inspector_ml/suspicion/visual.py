"""Листы-чертежи ПД ↔ РД ↔ ИД: совмещение растров и гипотеза о различиях.

Зачем. Куратор загрузил пару «Ситуационный план, М 1:2000»: в ПД на подложке канализация
(`d=200-225`, выпуски К1), в РД — водопровод (`d=300`, `d=250`, колодцы 70278…65265). Сам план в
обоих листах — растр, и система ответила «Нет доказательств» по всем 132 параметрам. Числа с чертежа
не станут параметрами матрицы, но показать инспектору, *где* листы расходятся, можно и нужно.

Как:

1. **Листы-чертежи.** Два вида:
   - лист, который разбор пометил чертежом (`is_drawing`), если текст вне штампа занимает не больше
     `MAX_TEXT_SHARE` площади листа. С растром на заметной доле листа берётся растр, иначе — весь лист,
     отрисованный со штампом, закрашенным белым: векторный чертёж САПР и лист-мозаика. Раньше такие
     листы в графику не попадали, а на «Тюменской 5» это 950 из 1025 листов-чертежей (916 векторных, 34 мозаики);
   - любая другая страница с растром не меньше `sheetdiff.MIN_SHARE` листа и мало текста — план,
     вставленный в пояснительную записку, как у куратора, и скан листа. Скан крупнее A3 — почти всегда
     чертёж: у него текст тоже меряется площадью, у остальных страниц — числом символов (`MAX_TEXT_CHARS`).
   Сканы записок и актов отсекаются по количеству текста. Исходный файл — `STORAGE_DIR/raw/{sha256}`,
   общий для api и ml; разбор и его кеш не меняются.
2. **Пары.** Каждый лист ПД сравнивается с листами РД и ИД, а лист РД — ещё и с листами ИД:
   исполнительный лист — это копия листа РД со штампом «Исполнительный», и различие в такой паре —
   отступление при строительстве. Комплект без ПД, но с РД и ИД теперь тоже сверяется. Парой считается
   лист, с которым растры совмещаются (`sheetdiff.align`). Разные чертежи не совмещаются — гипотезы нет.
   Лист ИД попадает в одну пару — с тем листом, с которым совместился лучше всего: копия листа РД
   совмещается почти без остатка, и та же разница ПД ↔ РД второй гипотезой через ИД не повторяется.
   Порядок обхода: сначала вероятные пары по шифру и наименованию листа и копии листов РД в ИД
   (почти тот же текст вне штампа, `_twin`), потом остальные — от крупных растров к мелким, равномерно
   по листам. Лимиты листов, пар и времени — `Limits`; что они отрезали, видно в отчёте покрытия
   `VisualCoverage`: эксперты 16.10 просили не терять пары молча.
3. **Различия и подписи.** Области, где на одном листе есть линии и подписи, которых нет рядом на
   другом. Если есть OCR, подписи читаются только в этих областях и в полосе заголовка — весь лист
   на процессоре распознаётся дольше 30 секунд, а области — за секунды.
   Изменённые подписи на тех же местах («280 → 300», «−0.365 → −0.385») — объекты листа, `sheet_objects`:
   в чернилах буквы для графики общие, а по объектам видно, что именно изменилось.
4. **Результат** — гипотеза `VISUAL_DIFF` с низкой уверенностью и рамками на обоих листах, плюс пара
   листов с гомографией и областями различий: экран сравнения показывает наложение.
   `CONFIRMED_VIOLATION` ставит только инспектор.
"""

from __future__ import annotations

import hashlib
import math
import re
import time
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import numpy as np
import pymupdf

from inspector_ml.compare.keys import suspicion_key
from inspector_ml.contracts.events import EvidenceFragment, PagePairResult, SuspicionResult, VisualCoverage
from inspector_ml.cv import sheetdiff
from inspector_ml.extract import cad_labels
from inspector_ml.extract.api import LoadedDocument
from inspector_ml.extract.normalize import collapse
from inspector_ml.logging import get_logger
from inspector_ml.ocr.base import OcrEngine
from inspector_ml.ocr.render import tiles
from inspector_ml.quality.page_classifier import LARGE_SHEET_PT
from inspector_ml.storage.files import long_path
from inspector_ml.suspicion import fragments, sheet_objects
from inspector_ml.suspicion.semantic import system

log = get_logger(__name__)

DISCOVERY_METHOD = "VISUAL_DIFF"
#: Уверенность гипотезы: совмещение надёжное, но различие на чертеже — ещё не нарушение.
CONFIDENCE = 0.35
#: Уверенность, когда на тех же местах совмещённых листов изменились подписи (шаг 2): «280 → 300» — уже
#: конкретный факт, а не пятно. Ниже 0,5 — в выгрузку FREE-* сама не попадает, решает инспектор.
CONFIDENCE_CHANGED = 0.45
#: Сколько изменённых подписей перечисляем в описании; рамками в доказательствах — `EVIDENCE_REGIONS`.
CHANGES_LISTED = 8
#: Системы сетей по шифру (`semantic.system`): только у их планов и схем различие может быть другой сетью или трассой
#: (рецензия экспертов 17.10, п. 5).
NETWORK_SYSTEMS = frozenset({"ЭЛ", "ВК", "ОВ", "СС", "ГС"})
#: Цветных чернил в области чертежа не меньше этой доли — на листе цветом нарисованы сети (план куратора).
NETWORK_COLOR_SHARE = 0.3
#: Область больше этой доли страницы — почти весь лист: тип по изображению не определяем, берём вид листа.
WHOLE_SHEET = 0.25
#: Столько символов текста таблицы или примечания приводим в описании.
QUOTE_CHARS = 90
#: Запас вокруг области для определения её типа, мм: строка таблицы, добавленная в РД, — это текст между линиями
#: сетки, и без запаса границы строки остаются за краем области.
KIND_MARGIN_MM = 3.0
#: Больше стольких символов разобранного текста — это записка или акт, а не чертёж. Только для страниц, которые
#: разбор не пометил чертежом: у чертежа подписей, размеров и спецификаций больше — порог в 600 символов срезал
#: 2402 из 2875 листов-чертежей обучающих объектов.
MAX_TEXT_CHARS = 600
#: Для листа-чертежа насыщенность текстом — доля площади листа под текстовыми блоками вне штампа. На
#: обучающих объектах («Пример нарушений», «Новослободская», «Алтуфьевское») медиана у листов-чертежей 0,09,
#: у остальных страниц 0,26; порог 0,25 оставляет 2516 из 2875 листов-чертежей и отсекает листы-спецификации.
#: Так же меряется распознанный скан крупнее A3 (`LARGE_SHEET_PT`): это почти всегда лист-чертёж, хотя разбор
#: помечает его сканом. Из 541 такого скана порог в `MAX_TEXT_CHARS` символов отсекал 463, порог по площади — 2.
MAX_TEXT_SHARE = 0.25
#: Лимиты по умолчанию, когда настройки не переданы (тесты, `inspector-ml` без api). В работе лимиты
#: приходят из `Settings` (`VISUAL_MAX_SHEETS`, `VISUAL_MAX_PAIR_CHECKS`, `VISUAL_BUDGET_S`).
MAX_SHEETS = 40
MAX_PAIR_CHECKS = 400
#: Сколько пропущенных листов перечисляем в отчёте покрытия; остальные — только числом.
MAX_SKIPPED_LISTED = 500
#: Порядок причин в перечне: сначала то, что не проверено из-за лимитов и времени, потом отсеянное по виду листа.
SKIP_ORDER = ("LIMIT", "PAIRS_LIMIT", "TIMEOUT", "NO_DRAWING_REGION", "MOSAIC", "TEXT_HEAVY")
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
    pairs_checked: int = 0
    pairs_possible: int = 0
    matched: bool = False


@dataclass(frozen=True)
class Limits:
    """Лимиты графического поиска; `None` — без ограничения."""

    max_sheets: int | None = MAX_SHEETS
    max_pair_checks: int | None = MAX_PAIR_CHECKS
    budget_s: float | None = None
    max_raster_mb: float | None = None
    """Память под растры взятых листов, МБ, на все стадии: лист держит растр, пока проверяются его пары."""

    @classmethod
    def of(cls, max_sheets: int, max_pair_checks: int, budget_s: float, max_raster_mb: float = 0) -> Limits:
        """Из настроек, где 0 значит «без ограничения»."""
        return cls(max_sheets or None, max_pair_checks or None, budget_s or None, max_raster_mb or None)


@dataclass(frozen=True)
class _Pending:
    """Лист-кандидат первого прохода: ещё без растра и особых точек."""

    pixels: int
    doc: LoadedDocument
    page: int
    title: str | None
    parsed: dict[str, Any] = field(repr=False)
    kind: str
    """`raster` — только растр (страница не чертёж по разбору); `raster_or_sheet` — растр, а если он мал, весь
    лист; `sheet` — весь лист (векторный чертёж, мозаика)."""


#: Ключ пары листов для подсказок пар: (файл ПД, страница, файл РД/ИД, страница).
PairHint = tuple[str, int, str, int]


@dataclass
class VisualRun:
    suspicions: list[SuspicionResult]
    pairs: list[PagePairResult]
    coverage: VisualCoverage | None
    """`None` — сравнивать не с чем: в комплекте нет листов-чертежей ПД и нет пары «РД и ИД»."""


def run(
    docs: Sequence[LoadedDocument],
    storage_dir: Path,
    object_id: object,
    engine: OcrEngine | None = None,
) -> tuple[list[SuspicionResult], list[PagePairResult]]:
    """Гипотезы о различиях листов-чертежей и пары листов с совмещением."""
    found = scan(docs, storage_dir, object_id, engine)
    return found.suspicions, found.pairs


def scan(
    docs: Sequence[LoadedDocument],
    storage_dir: Path,
    object_id: object,
    engine: OcrEngine | None = None,
    limits: Limits | None = None,
    hints: Iterable[PagePairResult] = (),
) -> VisualRun:
    """Гипотезы, пары листов и отчёт покрытия: что проверено и какие листы пропущены.

    `hints` — пары листов (`cv/pairing.py`) по шифру и наименованию: их проверяем первыми.
    """
    limits = limits or Limits()
    started = time.monotonic()
    deadline = _Budget(limits.budget_s) if limits.budget_s else None
    priority = _hint_scores(hints)
    coverage = _Coverage(limits)
    opened: dict[str, pymupdf.Document] = {}
    try:
        sheets = _sheets(docs, storage_dir, opened, limits, priority, coverage, deadline)
        pd, rd, built = (sheets.get(stage, []) for stage in ("PD", "RD", "ID"))
        # ПД — эталон для РД и ИД; исполнительный лист к тому же сверяется со своим листом РД: это копия листа
        # РД со штампом «Исполнительный», и различие в такой паре — отступление при строительстве
        groups = [(pd, [*rd, *built])] if pd else []
        if rd and built:
            groups.append((rd, built))
        if not groups:
            return VisualRun([], [], None)
        matches = _matches(groups, limits, priority, coverage, deadline)
        budget = _Budget(OCR_BUDGET_S)
        suspicions: list[SuspicionResult] = []
        pairs: list[PagePairResult] = []
        for left, right, diff in matches:
            # другая подпись на том же месте ловится только объектами листа: в чернилах буквы для графики общие
            changed = _changes(left, right, diff, opened, storage_dir)
            # тип фрагмента под каждой областью; различия в основной надписи (шифр, даты, подписи) не показываем
            kept = [
                (region, kind)
                for region, kind in zip(diff.regions, _region_kinds(left, right, diff, opened), strict=True)
                if kind[0] != fragments.STAMP
            ]
            if not kept and not changed:
                continue
            diff = replace(diff, regions=[region for region, _kind in kept])
            kinds = [kind for _region, kind in kept]
            hypothesis, pair = _hypothesis(left, right, diff, kinds, changed, object_id, engine, budget, opened)
            suspicions.append(hypothesis)
            pairs.append(pair)
        report = coverage.report([*pd, *rd, *built], int((time.monotonic() - started) * 1000))
        log.info(
            "visual_coverage",
            limited=report.limited,
            pairs_checked=report.pairs_checked,
            pairs_possible=report.pairs_possible,
            skipped=report.skipped_total,
        )
        return VisualRun(suspicions, pairs, report)
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


class _Coverage:
    """Счёт для отчёта покрытия: что посмотрели, что взяли, что и почему пропустили."""

    def __init__(self, limits: Limits) -> None:
        self.limits = limits
        self.stages: dict[str, dict[str, int]] = {}
        self.skipped: list[dict[str, Any]] = []
        self.pairs_possible = 0
        self.pairs_checked = 0
        self.pairs_matched = 0
        self.stopped: str | None = None
        """Почему обход пар остановился: `PAIRS_LIMIT` или `TIMEOUT`; `None` — проверены все."""

    def stage(self, stage: str) -> dict[str, int]:
        return self.stages.setdefault(stage, {"pages": 0, "candidates": 0, "taken": 0, "text_heavy": 0, "mosaic": 0})

    def skip(self, doc: LoadedDocument, page: int, reason: str) -> None:
        self.skipped.append({"file_id": str(doc.file_id), "page": page, "stage": str(doc.stage), "reason": reason})

    def report(self, taken: Sequence[Sheet], duration_ms: int) -> VisualCoverage:
        for sheet in taken:
            if sheet.pairs_possible and not sheet.pairs_checked:
                self.skip(sheet.doc, sheet.page, self.stopped or "PAIRS_LIMIT")
        limited = self.pairs_checked < self.pairs_possible or any(
            item["reason"] in ("LIMIT", "PAIRS_LIMIT", "TIMEOUT") for item in self.skipped
        )
        return VisualCoverage.model_validate(
            {
                "limited": limited,
                "limits": {
                    "max_sheets_per_stage": self.limits.max_sheets,
                    "max_pair_checks": self.limits.max_pair_checks,
                    "budget_s": self.limits.budget_s,
                },
                "duration_ms": duration_ms,
                "stages": [{"stage": stage, **counts} for stage, counts in self.stages.items()],
                "pairs_possible": self.pairs_possible,
                "pairs_checked": self.pairs_checked,
                "pairs_matched": self.pairs_matched,
                "sheets": [
                    {
                        "file_id": str(s.doc.file_id),
                        "page": s.page,
                        "stage": s.stage,
                        "pairs_checked": s.pairs_checked,
                        "pairs_possible": s.pairs_possible,
                        "matched": s.matched,
                    }
                    for s in taken
                    if s.pairs_checked
                ],
                # первыми — пропущенные по лимитам и времени: их инспектор досматривает сам
                "skipped": sorted(self.skipped, key=lambda item: SKIP_ORDER.index(item["reason"]))[:MAX_SKIPPED_LISTED],
                "skipped_total": len(self.skipped),
            }
        )


def _hint_scores(hints: Iterable[PagePairResult]) -> dict[PairHint, float]:
    scores: dict[PairHint, float] = {}
    for pair in hints:
        key = (str(pair.left.file_id), int(pair.left.page), str(pair.right.file_id), int(pair.right.page))
        scores[key] = max(scores.get(key, 0.0), float(pair.match_score))
    return scores


def _sheets(
    docs: Sequence[LoadedDocument],
    storage_dir: Path,
    opened: dict[str, pymupdf.Document],
    limits: Limits,
    priority: dict[PairHint, float],
    coverage: _Coverage,
    deadline: _Budget | None,
) -> dict[str, list[Sheet]]:
    """Листы-чертежи по стадиям: чертёж по разбору или растр на заметной доле листа, мало текста.

    Два прохода, потому что комплект — это сотни документов и тысячи страниц. Сначала — количество текста
    по разбору и размер самой крупной картинки по ресурсам страницы, без её загрузки. Потом — место картинки
    на листе (дорого: текстовый слой страницы) или весь лист, растр и особые точки, пока в стадии не
    наберётся `limits.max_sheets` листов: первыми листы из вероятных пар, дальше по убыванию размера
    растра. Без ПД листу РД сравниваться не с чем, кроме листов ИД: если в комплекте нет ни ПД, ни пары
    «РД и ИД», другие стадии не смотрим.
    """
    built = {"RD", "ID"} <= {str(doc.stage) for doc in docs}
    hinted = {(f, p) for key in priority for f, p in (key[:2], key[2:])}
    shared = _shared_systems(docs)
    pending: dict[str, list[_Pending]] = {}
    ordered = sorted(docs, key=lambda d: str(d.stage) != "PD")
    for doc in ordered:
        stage = str(doc.stage)
        if stage != "PD" and not pending.get("PD") and not built:
            break
        counts = coverage.stage(stage)
        candidates = [p for p in doc.pages if not _text_heavy(p)]
        counts["pages"] += len(doc.pages)
        counts["text_heavy"] += len(doc.pages) - len(candidates)
        # лист-чертёж, отсеянный из-за текста (спецификация, таблица), — в отчёт поимённо (контракт 0.26.0); записки
        # и акты только считаются, иначе список из 500 забьют они
        for parsed in doc.pages:
            if parsed.get("is_drawing") and _text_heavy(parsed):
                coverage.skip(doc, int(parsed.get("page") or 0), "TEXT_HEAVY")
        document = _open(doc, storage_dir, opened) if candidates else None
        if document is None:
            continue
        for parsed in candidates:
            number = int(parsed.get("page") or 0)
            if not 1 <= number <= document.page_count:
                continue
            drawing = bool(parsed.get("is_drawing"))
            count, pixels = sheetdiff.page_images(document, number - 1)
            whole = sheetdiff.sheet_pixels(*_page_size(parsed, document, number - 1))
            title = title_of([_page_text(parsed)])
            if sheetdiff.is_mosaic(count):
                counts["mosaic"] += 1
                # мозаику рисуем целиком и дорогой `drawing_region` на ней не зовём: на листе из сотен
                # плиток `get_image_info` идёт до 13 с
                if drawing:
                    pending.setdefault(stage, []).append(_Pending(whole, doc, number, title, parsed, "sheet"))
                else:
                    coverage.skip(doc, number, "MOSAIC")
            elif count and pixels >= sheetdiff.MIN_IMAGE_PIXELS:
                kind = "raster_or_sheet" if drawing else "raster"
                pending.setdefault(stage, []).append(_Pending(pixels, doc, number, title, parsed, kind))
            elif drawing:
                # векторный чертёж САПР: растра нет, линии рисуются из описания страницы
                pending.setdefault(stage, []).append(_Pending(whole, doc, number, title, parsed, "sheet"))

    by_stage: dict[str, list[Sheet]] = {}
    keep: set[str] = set()
    # бюджет памяти — поровну на стадии, начиная с малых: ИД с четырьмя листами не забирает треть у ПД и РД
    memory = limits.max_raster_mb * 2**20 if limits.max_raster_mb else None
    stages = sorted(pending, key=lambda stage: len(pending[stage]))
    for left, stage in enumerate(stages):
        items = pending[stage]
        stage_memory = (memory / (len(stages) - left)) if memory is not None else None
        used = 0
        coverage.stage(stage)["candidates"] = len(items)
        # вероятные пары вперёд, потом листы систем, которые есть и в ПД, и в РД/ИД (ОВ ПД ↔ ОВ РД), потом
        # крупные растры: чертёж обычно занимает лист целиком
        items.sort(
            key=lambda item: (
                (str(item.doc.file_id), item.page) not in hinted,
                system(item.doc) not in shared,
                -item.pixels,
            )
        )
        sheets = by_stage.setdefault(stage, [])
        for item in items:
            doc, number = item.doc, item.page
            if limits.max_sheets is not None and len(sheets) >= limits.max_sheets:
                coverage.skip(doc, number, "LIMIT")
                continue
            if deadline is not None and not deadline.left:
                coverage.skip(doc, number, "TIMEOUT")
                continue
            page = opened[doc.sha256][number - 1]
            # оценка сверху до отрисовки: лист целиком при пределе `SHEET_MAX_PX`, три байта на пиксель
            if (
                stage_memory is not None
                and used + 3 * sheetdiff.sheet_pixels(page.rect.width, page.rect.height) > stage_memory
            ):
                coverage.skip(doc, number, "LIMIT")
                continue
            region = sheetdiff.drawing_region(page) if item.kind != "sheet" else None
            if region is not None:
                raster = sheetdiff.Raster(sheetdiff.render(page, region), region)
            elif item.kind != "raster":
                # картинка на листе-чертеже меньше заметной доли — это вставка в векторный чертёж, берём лист целиком
                raster = sheetdiff.render_sheet(page, _stamp_masks(item.parsed))
            else:
                coverage.skip(doc, number, "NO_DRAWING_REGION")
                continue
            sheets.append(Sheet(doc, stage, number, raster, item.title, sheetdiff.features(raster.image)))
            used += raster.image.nbytes
            keep.add(doc.sha256)
        coverage.stage(stage)["taken"] = len(sheets)
        if memory is not None:
            memory -= used
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


def _matches(
    groups: list[tuple[list[Sheet], list[Sheet]]],
    limits: Limits,
    priority: dict[PairHint, float],
    coverage: _Coverage,
    deadline: _Budget | None,
) -> list[tuple[Sheet, Sheet, sheetdiff.SheetDiff]]:
    """Пары «лист ПД — лист РД/ИД» и «лист РД — лист ИД», которые совмещаются; лист — не больше одной пары на стадию.

    Порядок проверки: вероятные пары по их оценке, потом листы одной инженерной системы по шифру
    документа (ОВ ПД ↔ ОВ РД), потом остальные по сумме мест листов в своих стадиях — так при лимите
    каждый крупный лист получает хотя бы несколько попыток, а не первый лист ПД все `max_pair_checks` разом.
    Исполнительный лист, чей текст почти тот же, что у листа РД (`_twin`), — копия этого листа: такая пара идёт
    вместе с подсказками пар. Остальные пары РД ↔ ИД — после пар от ПД того же уровня (одна система или нет): при
    лимите пар сверка с проектом, по которой считается балл, не теряет очередь из-за новых пар.
    """
    sheets = {id(sheet): sheet for reference, others in groups for sheet in (*reference, *others)}.values()
    systems = {sheet.doc.file_id: system(sheet.doc) for sheet in sheets}
    words = {id(sheet): _words(sheet) for sheet in sheets if sheet.stage in ("RD", "ID")}
    queue: list[tuple[tuple[bool, float, bool, int, int], Sheet, Sheet]] = []
    for group, (reference, others) in enumerate(groups):
        for i, left in enumerate(reference):
            for j, right in enumerate(others):
                if left.doc.file_id == right.doc.file_id:
                    continue
                hint = priority.get((str(left.doc.file_id), left.page, str(right.doc.file_id), right.page))
                if hint is None and left.stage == "RD" and _twin(words[id(left)], words[id(right)]):
                    hint = 1.0
                same = systems[left.doc.file_id] is not None and systems[left.doc.file_id] == systems[right.doc.file_id]
                queue.append(((hint is None, -(hint or 0.0), not same, group, i + j), left, right))
                left.pairs_possible += 1
                right.pairs_possible += 1
    queue.sort(key=lambda item: item[0])
    coverage.pairs_possible = len(queue)

    candidates: list[tuple[int, Sheet, Sheet, sheetdiff.SheetDiff]] = []
    for _order, left, right in queue:
        if limits.max_pair_checks is not None and coverage.pairs_checked >= limits.max_pair_checks:
            coverage.stopped = "PAIRS_LIMIT"
            break
        if deadline is not None and not deadline.left:
            coverage.stopped = "TIMEOUT"
            break
        coverage.pairs_checked += 1
        left.pairs_checked += 1
        right.pairs_checked += 1
        diff = sheetdiff.compare(left.raster, right.raster, left.features, right.features)
        if diff is not None:
            coverage.pairs_matched += 1
            left.matched = right.matched = True
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
    kinds: list[tuple[str, float]],
    changed: list[sheet_objects.Change],
    object_id: object,
    engine: OcrEngine | None,
    budget: _Budget,
    opened: dict[str, pymupdf.Document],
) -> tuple[SuspicionResult, PagePairResult]:
    kind_of = {id(region): kind for region, (kind, _colored) in zip(diff.regions, kinds, strict=True)}
    only_left = [r for r in diff.regions if r.side == "left"]
    only_right = [r for r in diff.regions if r.side == "right"]
    left_texts = _region_texts(left, [r.left_box for r in only_left], engine, budget, opened)
    right_texts = _region_texts(right, [r.right_box for r in only_right], engine, budget, opened)
    # сетевой лист: шифр системы сетей или цветные линии на чертеже. Только на нём голое пятизначное число — номер
    # колодца; на листах КР это размеры («39600»), и подписью сети их считать нельзя
    drawn = [colored for kind, colored in kinds if kind not in (fragments.TABLE, fragments.TEXT)]
    sheet_network = bool({system(left.doc), system(right.doc)} & NETWORK_SYSTEMS) or any(
        colored >= NETWORK_COLOR_SHARE for colored in drawn
    )

    def network_labels(texts: list[str]) -> list[str]:
        return [label for label in labels(texts) if sheet_network or not label.isdigit()]

    left_by_region = [network_labels(texts) for texts in left_texts]
    right_by_region = [network_labels(texts) for texts in right_texts]
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

    left_name = STAGE_NAME.get(left.stage, left.stage)
    right_name = STAGE_NAME.get(right.stage, right.stage)
    head = f"Лист-чертёж «{title}»" if title else "Лист-чертёж (растр)"
    if diff.regions:
        where = Counter(fragments.WHERE.get(kind, fragments.WHERE[fragments.DRAWING]) for kind, _colored in kinds)
        breakdown = ", ".join(f"{place} — {count}" for place, count in where.items())
        parts = [
            f"{head}: после совмещения {left_name} и {right_name} различаются {len(diff.regions)} обл. ({breakdown})."
        ]
    else:
        parts = [f"{head}: листы {left_name} и {right_name} совмещаются, но подписи на тех же местах разные."]
    if changed:
        listed = ", ".join(change.text for change in changed[:CHANGES_LISTED])
        more = f" и ещё {len(changed) - CHANGES_LISTED}" if len(changed) > CHANGES_LISTED else ""
        parts.append(f"Изменены подписи ({left_name} → {right_name}): {listed}{more}.")
    if left_labels:
        parts.append(f"Только в {left_name}: {', '.join(left_labels)}.")
    if right_labels:
        parts.append(f"Только в {right_name}: {', '.join(right_labels)}.")
    # текст таблиц и примечаний, который есть только на одном листе, — цитатой: по ней видно, что изменилось
    quotes = {
        fragments.TABLE: "Только в таблице {}: «{}».",
        fragments.TEXT: "Только в тексте {}: «{}».",
    }
    for name, regions, texts in ((left_name, only_left, left_texts), (right_name, only_right, right_texts)):
        for region, found in zip(regions, texts, strict=True):
            quote = _quote(found)
            if kind_of[id(region)] in quotes and quote:
                parts.append(quotes[kind_of[id(region)]].format(name, quote))
    parts.append(_advice(left, kinds, sheet_network or bool(left_labels or right_labels)))
    confidence = CONFIDENCE_CHANGED if changed else CONFIDENCE
    parts.append(
        f"Уверенность {confidence:.2f}".replace(".", ",")
        + " — технический уровень гипотезы (листы совместились, различие найдено), а не вероятность нарушения."
    )
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
        *(
            _fragment(left, "EXPECTED", _grow(c.left.box, CHANGE_MARGIN), [c.left.text])
            for c in changed[:EVIDENCE_REGIONS]
        ),
        *(
            _fragment(right, "ACTUAL", _grow(c.right.box, CHANGE_MARGIN), [c.right.text])
            for c in changed[:EVIDENCE_REGIONS]
        ),
        *(_fragment(left, "EXPECTED", r.left_box, found, kind_of[id(r)]) for r, found in left_side[:EVIDENCE_REGIONS]),
        *(_fragment(right, "ACTUAL", r.right_box, found, kind_of[id(r)]) for r, found in right_side[:EVIDENCE_REGIONS]),
    ]
    suspicion = SuspicionResult.model_validate(
        {
            "suspicion_key": key,
            "discovery_method": DISCOVERY_METHOD,
            "confidence": confidence,
            "description": description,
            "pd_reference": _reference(left) if left.stage == "PD" else None,
            "rd_reference": next((_reference(sheet) for sheet in (left, right) if sheet.stage == "RD"), None),
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
            # вниз: у пары с найденным различием не бывает «100 %»
            "compliance_percent": math.floor(100 * diff.matched_share),
            "diff_regions": [
                {
                    "left_bbox": list(r.left_box),
                    "right_bbox": list(r.right_box),
                    "score": round(r.share, 4),
                    "label": f"только в {left_name if r.side == 'left' else right_name} · "
                    f"{fragments.NAME.get(kind_of[id(r)], fragments.NAME[fragments.DRAWING])}",
                    "suspicion_key": key,
                }
                for r in diff.regions
            ]
            + [
                {
                    "left_bbox": list(_grow(c.left.box, CHANGE_MARGIN)),
                    "right_bbox": list(_grow(c.right.box, CHANGE_MARGIN)),
                    "label": f"изменено: {c.text}",
                    "suspicion_key": key,
                }
                for c in changed
            ],
        }
    )
    return suspicion, pair


def _region_texts(
    sheet: Sheet,
    boxes: list[sheetdiff.BoxN],
    engine: OcrEngine | None,
    budget: _Budget,
    opened: dict[str, pymupdf.Document],
) -> list[list[str]]:
    """Тексты каждой области различия: разобранный текст листа и OCR области, пока есть время."""
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
        found.append(texts)
    return found


def _quote(texts: list[str]) -> str:
    """Текст области одной строкой, не длиннее `QUOTE_CHARS`."""
    text = collapse(" ".join(dict.fromkeys(t.strip() for t in texts if t.strip())))
    return text if len(text) <= QUOTE_CHARS else text[: QUOTE_CHARS - 1].rstrip() + "…"


def _advice(left: Sheet, kinds: list[tuple[str, float]], network: bool) -> str:
    """Что проверить инспектору — по типу фрагментов (рецензия экспертов 17.10, п. 5).

    Про сети и трассу — только если различие на самом чертеже и это сеть (`network`): шифр системы сетей, цветные линии
    или подписи сетей в области (диаметры, К1, колодцы). Для таблиц и текста — сверить значения и текст.
    """
    if left.stage == "RD":
        return "Исполнительный чертёж отличается от рабочего — проверьте, согласовано ли отступление."
    if any(kind not in (fragments.TABLE, fragments.TEXT) for kind, _colored in kinds):
        if network:
            return "Возможно, на листах разные сети или изменена трасса — проверьте."
        return "Проверьте, что изменилось на чертеже."
    if any(kind == fragments.TABLE for kind, _colored in kinds):
        return "Сверьте значения в таблице на обоих листах."
    if kinds:
        return "Сверьте текст на обоих листах."
    return "Проверьте, согласовано ли изменение."


def _region_kinds(
    left: Sheet, right: Sheet, diff: sheetdiff.SheetDiff, opened: dict[str, pymupdf.Document]
) -> list[tuple[str, float]]:
    """Тип фрагмента под каждой областью различия (`fragments`) и доля цветных чернил в ней."""
    return [
        _region_kind(left, region.left_box, opened)
        if region.side == "left"
        else _region_kind(right, region.right_box, opened)
        for region in diff.regions
    ]


def _region_kind(sheet: Sheet, box: sheetdiff.BoxN, opened: dict[str, pymupdf.Document]) -> tuple[str, float]:
    document = opened.get(sheet.doc.sha256)
    if document is None:
        return fragments.DRAWING, 0.0
    page = document[sheet.page - 1]
    cut = fragments.outside_stamp(box, fragments.stamp_zone(page.rect.width, page.rect.height))
    if cut is None:
        return fragments.STAMP, 0.0
    by_name = _sheet_kind(sheet)
    if (cut[2] - cut[0]) * (cut[3] - cut[1]) > WHOLE_SHEET:
        return by_name or fragments.DRAWING, 0.0
    margin = (KIND_MARGIN_MM * 72 / 25.4 / page.rect.width, KIND_MARGIN_MM * 72 / 25.4 / page.rect.height)
    grown = (cut[0] - margin[0], cut[1] - margin[1], cut[2] + margin[0], cut[3] + margin[1])
    image, px_per_mm = _crop(sheet.raster, grown, page.rect.width)
    drawing_sheet = by_name in (fragments.PLAN, fragments.SCHEME, fragments.SECTION)
    found = fragments.classify(image, px_per_mm, drawing_sheet=drawing_sheet)
    # на листе-спецификации текст области — содержимое таблицы: строка, добавленная в РД, — текст между линиями сетки
    if found == fragments.DRAWING or (found == fragments.TEXT and by_name == fragments.TABLE):
        found = by_name or fragments.DRAWING
    return found, fragments.colored_share(image)


def _sheet_kind(sheet: Sheet) -> str | None:
    """Вид листа по названию в основной надписи или заголовку: план, схема, разрез, таблица."""
    parsed = next((p for p in sheet.doc.pages if int(p.get("page") or 0) == sheet.page), {})
    names = [b.get("text") or "" for b in parsed.get("blocks") or [] if b.get("type") == "title_block"]
    return fragments.sheet_kind([*names, sheet.title or ""])


def _crop(raster: sheetdiff.Raster, box: sheetdiff.BoxN, page_width_pt: float) -> tuple[np.ndarray, float]:
    """Часть растра под рамкой страницы и сколько пикселей растра в миллиметре листа."""
    rx0, ry0, rx1, ry1 = raster.region
    height, width = raster.image.shape[:2]

    def to_px(value: float, low: float, high: float, size: int) -> int:
        return round(min(1.0, max(0.0, (value - low) / max(1e-9, high - low))) * size)

    x0, x1 = to_px(box[0], rx0, rx1, width), to_px(box[2], rx0, rx1, width)
    y0, y1 = to_px(box[1], ry0, ry1, height), to_px(box[3], ry0, ry1, height)
    px_per_mm = width / max(1e-9, (rx1 - rx0) * page_width_pt * 25.4 / 72)
    return raster.image[y0:y1, x0:x1], px_per_mm


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


def _fragment(
    sheet: Sheet, role: str, box: sheetdiff.BoxN, found: list[str], kind: str | None = None
) -> EvidenceFragment:
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
            "text_snippet": ", ".join(found)
            if found
            else f"{fragments.NAME.get(kind or fragments.DRAWING, 'чертёж')}: область различия",
            "source": parsed.get("source") or "OCR",
            "quality": parsed.get("quality") or "OK",
            "confidence": CONFIDENCE,
        }
    )


#: Исполнительный лист — копия листа РД, если у них почти тот же текст вне штампа (экспликация, подписи).
TWIN_SIMILARITY = 0.8


def _twin(a: set[str], b: set[str]) -> bool:
    """Лист ИД — копия листа РД: почти тот же набор слов вне штампа (Жаккар не ниже `TWIN_SIMILARITY`)."""
    return bool(a and b) and len(a & b) / len(a | b) >= TWIN_SIMILARITY


def _words(sheet: Sheet) -> set[str]:
    page = next((p for p in sheet.doc.pages if int(p.get("page") or 0) == sheet.page), {})
    return set(_page_text(page).lower().split())


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


def _text_share(parsed: dict[str, Any]) -> float:
    """Доля площади листа под текстовыми блоками вне штампа (рамки блоков — в долях листа)."""
    total = 0.0
    for block in parsed.get("blocks") or []:
        bbox = block.get("bbox") or []
        if block.get("type") == "title_block" or len(bbox) != 4:
            continue
        total += max(0.0, min(1.0, bbox[2]) - max(0.0, bbox[0])) * max(0.0, min(1.0, bbox[3]) - max(0.0, bbox[1]))
    return total


def _text_heavy(parsed: dict[str, Any]) -> bool:
    """Записка, акт или лист-спецификация.

    У чертежа и у распознанного скана крупнее A3 — по площади текста, у остальных страниц — по символам: мелкий
    скан — это обычно акт, и по площади его от схемы не отличить.
    """
    size = max(float(parsed.get("width_pt") or 0), float(parsed.get("height_pt") or 0))
    large_scan = parsed.get("source") == "OCR" and size > LARGE_SHEET_PT
    if parsed.get("is_drawing") or large_scan:
        return _text_share(parsed) > MAX_TEXT_SHARE
    return len(_page_text(parsed)) > MAX_TEXT_CHARS


def _shared_systems(docs: Sequence[LoadedDocument]) -> set[str]:
    """Инженерные системы по шифру (`semantic.system`), у которых есть документы и в ПД, и в РД или ИД, или в РД и ИД.

    На «Тюменской 5» вероятная пара одна, а листов-кандидатов ПД 1290: без этого в лимит 150 листов шли
    самые крупные растры, и ни один лист эталона из тома ОВ ПД (`F0171`) в сравнение не попадал.
    """
    by_stage: dict[str, set[str]] = {}
    for doc in docs:
        name = system(doc)
        if name is not None:
            by_stage.setdefault(str(doc.stage), set()).add(name)
    others = set().union(*(by_stage.get(stage, set()) for stage in STAGES))
    return by_stage.get("PD", set()) & others | by_stage.get("RD", set()) & by_stage.get("ID", set())


def _page_size(parsed: dict[str, Any], document: pymupdf.Document, index: int) -> tuple[float, float]:
    """Размер страницы в пунктах: из разбора, а если его там нет — из самого PDF (загрузка страницы)."""
    width, height = parsed.get("width_pt"), parsed.get("height_pt")
    if width and height:
        return float(width), float(height)
    rect = document[index].rect
    return rect.width, rect.height


#: Запас вокруг изменённой подписи в рамке доказательства — чтобы на экране было видно, к чему она относится.
CHANGE_MARGIN = 0.01


def _changes(
    left: Sheet,
    right: Sheet,
    diff: sheetdiff.SheetDiff,
    opened: dict[str, pymupdf.Document],
    storage_dir: Path,
) -> list[sheet_objects.Change]:
    """Изменённые подписи пары (шаг 2): объекты обоих листов вне штампа.

    Строки OCR листа целиком (кеш `cad_labels.cached`) берутся, только если распознаны оба листа: иначе у одного листа
    объектов станет больше, и «пропажи» означали бы только нераспознанный текст.
    """
    ocr = [cad_labels.cached(storage_dir, sheet.doc.sha256, sheet.page) for sheet in (left, right)]
    if any(lines is None for lines in ocr):
        ocr = [None, None]
    found = []
    for sheet, lines in zip((left, right), ocr, strict=True):
        document = opened.get(sheet.doc.sha256)
        if document is None:
            return []
        parsed = next((p for p in sheet.doc.pages if int(p.get("page") or 0) == sheet.page), {})
        found.append(sheet_objects.read(document[sheet.page - 1], _stamp_masks(parsed), lines))
    return sheet_objects.changes(found[0], found[1], diff.homography, left.raster.region, right.raster.region)


#: Основная надпись по ГОСТ Р 21.101 — 185 × 55 мм в правом нижнем углу, рамка в 5 мм от края; с запасом — эта зона.
STAMP_MM = (195.0, 65.0)
#: Дополнительные графы (инв. № подл., подпись и дата, взам. инв. №) — полоса у левого края листа.
SIDE_GRAPHS_MM = 25.0


def _stamp_masks(parsed: dict[str, Any]) -> list[sheetdiff.BoxN]:
    """Штамп листа для закраски: рамка блоков основной надписи в зоне штампа и рамка дополнительных граф у левого края,
    с запасом `sheetdiff.STAMP_MARGIN`.

    Блок с меткой «основная надпись» вне этих зон — таблица или примечания листа, которые разбор принял за штамп, и они
    не закрашиваются. Если такие блоки есть, а в зоне штампа нет ни одного, штамп разбор не нашёл — закрашивается сама
    зона (52 листа обучающих объектов: широкие строки таблиц через весь лист с меткой штампа).

    До 17.10 закрашивалась общая рамка всех блоков с этой меткой: на обучающих объектах у половины листов-чертежей
    она была больше 200 × 91 мм, у четверти — больше 378 × 140 мм (сам штамп 185 × 55 мм) и закрывала разрезы и
    ведомости в правой нижней четверти листа.
    """
    boxes = [
        b["bbox"]
        for b in parsed.get("blocks") or []
        if b.get("type") == "title_block" and len(b.get("bbox") or []) == 4
    ]
    if not boxes:
        return []
    width_mm = float(parsed.get("width_pt") or 0) * 25.4 / 72
    height_mm = float(parsed.get("height_pt") or 0) * 25.4 / 72
    if width_mm and height_mm:
        corner = [max(0.0, 1 - STAMP_MM[0] / width_mm), max(0.0, 1 - STAMP_MM[1] / height_mm), 1.0, 1.0]
        groups = [
            [b for b in boxes if b[0] >= corner[0] and b[1] >= corner[1]] or [corner],
            [b for b in boxes if b[2] <= SIDE_GRAPHS_MM / width_mm],
        ]
    else:
        groups = [boxes]  # размер листа неизвестен — как раньше, общая рамка
    return [_grow(_hull(group), sheetdiff.STAMP_MARGIN) for group in groups if group]


def _hull(boxes: list[list[float]]) -> sheetdiff.BoxN:
    return (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))


def _grow(box: sheetdiff.BoxN, margin: float) -> sheetdiff.BoxN:
    return (max(0.0, box[0] - margin), max(0.0, box[1] - margin), min(1.0, box[2] + margin), min(1.0, box[3] + margin))


def _inside(bbox: Any, box: sheetdiff.BoxN) -> bool:
    if not bbox or len(bbox) != 4:
        return False
    cx, cy = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
    return box[0] <= cx <= box[2] and box[1] <= cy <= box[3]
