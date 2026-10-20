"""Листы-чертежи ПД ↔ РД: совмещение растров и гипотеза VISUAL_DIFF.

Синтетическая пара повторяет пару-пример: одна подложка вставлена на листы в разном месте и в
разном масштабе, в ПД поверх неё коричневая линия (канализация), в РД — синяя (водопровод).
OCR в тестах не нужен: подписи — дополнение к гипотезе, а не её условие.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from pathlib import Path

import cv2
import numpy as np
import pymupdf
import pytest

from inspector_ml.config import Settings
from inspector_ml.contracts.events import CompareRequest, CompareResult, DocumentMetadata, PagePairResult
from inspector_ml.cv import sheetdiff
from inspector_ml.extract.api import LoadedDocument
from inspector_ml.jobs.handlers import _with_hypotheses
from inspector_ml.suspicion import visual

TITLE = "Ситуационный план, М 1:2000"
BROWN, BLUE = (40, 60, 120), (200, 80, 20)  # BGR


def base_map(seed: int, size: tuple[int, int] = (1200, 800)) -> np.ndarray:
    """Подложка-«план»: кварталы, улицы и мелкие значки — есть за что зацепиться ORB."""
    rng = np.random.default_rng(seed)
    width, height = size
    image = np.full((height, width, 3), 255, np.uint8)
    for _ in range(60):
        x, y = int(rng.integers(0, width - 120)), int(rng.integers(0, height - 80))
        w, h = int(rng.integers(30, 120)), int(rng.integers(20, 80))
        cv2.rectangle(image, (x, y), (x + w, y + h), (150, 150, 150), -1)
        cv2.rectangle(image, (x, y), (x + w, y + h), (40, 40, 40), 2)
    for _ in range(25):
        points = rng.integers(0, [width, height], size=(3, 2)).astype(np.int32)
        cv2.polylines(image, [points], False, (60, 60, 60), 2)
    for _ in range(80):
        x, y = int(rng.integers(0, width)), int(rng.integers(0, height))
        cv2.putText(image, str(int(rng.integers(0, 99))), (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (30, 30, 30), 1)
    return image


def sheet_pdf(path: Path, image: np.ndarray, rect: tuple[float, float, float, float], text: str = "") -> None:
    ok, png = cv2.imencode(".png", image)
    assert ok
    document = pymupdf.open()
    page = document.new_page(width=595, height=842)
    page.insert_image(pymupdf.Rect(*rect), stream=png.tobytes())
    if text:
        page.insert_text((40, 40), text[:80], fontsize=8)
    document.save(path)
    document.close()


def loaded(storage: Path, pdf: Path, stage: str, n: int, text: str = TITLE) -> LoadedDocument:
    sha = hashlib.sha256(pdf.read_bytes()).hexdigest()
    raw = storage / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    (raw / sha).write_bytes(pdf.read_bytes())
    block = {"id": "b0", "type": "text", "text": text, "bbox": [0.1, 0.02, 0.9, 0.05]}
    parsed = {"pages": [{"page": 1, "source": "TEXT_LAYER", "quality": "OK", "blocks": [block]}]}
    return LoadedDocument(uuid.UUID(int=n), sha, DocumentMetadata(doc_stage=stage, document_code=f"{stage}-1"), parsed)


@pytest.fixture
def pair(tmp_path: Path) -> list[LoadedDocument]:
    """ПД: подложка + коричневая линия; РД: та же подложка мельче и в другом месте + синяя линия."""
    base = base_map(7)
    pd_image, rd_image = base.copy(), base.copy()
    cv2.line(pd_image, (700, 100), (900, 700), BROWN, 8)
    cv2.line(rd_image, (100, 600), (500, 200), BLUE, 8)
    sheet_pdf(tmp_path / "pd.pdf", pd_image, (40, 120, 555, 463))
    sheet_pdf(tmp_path / "rd.pdf", rd_image, (80, 200, 440, 440))
    storage = tmp_path / "storage"
    return [loaded(storage, tmp_path / "pd.pdf", "PD", 1), loaded(storage, tmp_path / "rd.pdf", "RD", 2)]


class TestSheetDiff:
    def test_description_names_the_fragment_and_the_confidence_level(self, pair, tmp_path) -> None:
        """Где различие (на плане), фраза про сети — по цветным линиям сетей, уверенность — не вероятность."""
        [hypothesis], _pairs = visual.run(pair, tmp_path / "storage", "obj")

        assert re.search(r"различаются (\d+) обл\. \(на плане — \1\)", hypothesis.description)
        assert "разные сети или изменена трасса" in hypothesis.description
        assert "Уверенность 0,35 — технический уровень гипотезы" in hypothesis.description
        assert "не вероятность нарушения" in hypothesis.description

    def test_differences_found_on_both_sheets(self, pair, tmp_path) -> None:
        found, pairs = visual.run(pair, tmp_path / "storage", "obj")

        [hypothesis] = found
        assert str(hypothesis.discovery_method.root) == "VISUAL_DIFF"
        assert hypothesis.confidence <= visual.CONFIDENCE
        assert TITLE in hypothesis.description
        roles = {(str(e.role.root), str(e.stage.root)) for e in hypothesis.evidence}
        assert roles == {("EXPECTED", "PD"), ("ACTUAL", "RD")}

        [sheet_pair] = pairs
        assert sheet_pair.pair_key == hypothesis.page_pair_key
        assert len(sheet_pair.homography) == 9
        assert {r.suspicion_key for r in sheet_pair.diff_regions} == {hypothesis.suspicion_key}
        assert {r.label for r in sheet_pair.diff_regions} == {"только в ПД · план", "только в РД · план"}

    def test_brown_line_is_located_where_it_was_drawn(self, pair, tmp_path) -> None:
        """Коричневая линия ПД стоит в правой части растра — рамка «только в ПД» там же."""
        _found, [sheet_pair] = visual.run(pair, tmp_path / "storage", "obj")
        only_pd = [r for r in sheet_pair.diff_regions if r.label.startswith("только в ПД")]
        x0, _y0, x1, _y1 = (v.root for v in only_pd[0].left_bbox.root)
        # линия 700→900 px из 1200 на растре шириной 40…555 pt листа 595 pt
        assert x0 > 0.55 and x1 < 0.9

    def test_homography_maps_right_page_to_left(self, pair, tmp_path) -> None:
        """Угол растра РД (80, 200 pt) переходит в угол растра ПД (40, 120 pt)."""
        _found, [sheet_pair] = visual.run(pair, tmp_path / "storage", "obj")
        matrix = np.array(sheet_pair.homography).reshape(3, 3)
        x, y, w = matrix @ np.array([80 / 595, 200 / 842, 1.0])
        assert (x / w, y / w) == pytest.approx((40 / 595, 120 / 842), abs=0.01)

    def test_compliance_drops_with_more_differences(self, pair, tmp_path) -> None:
        """«Соответствие» пары — доля линий, нашедших пару; три лишние линии РД снижают его, 100 % не бывает."""
        _found, [sheet_pair] = visual.run(pair, tmp_path / "storage", "obj")
        base = base_map(7)
        pd_image, rd_image = base.copy(), base.copy()
        cv2.line(pd_image, (700, 100), (900, 700), BROWN, 8)
        cv2.line(rd_image, (100, 600), (500, 200), BLUE, 8)
        for i in range(3):
            cv2.line(rd_image, (100 + 300 * i, 50), (300 + 300 * i, 750), BLUE, 8)
        sheet_pdf(tmp_path / "pd3.pdf", pd_image, (40, 120, 555, 463))
        sheet_pdf(tmp_path / "rd3.pdf", rd_image, (80, 200, 440, 440))
        storage = tmp_path / "storage3"
        docs = [loaded(storage, tmp_path / "pd3.pdf", "PD", 1), loaded(storage, tmp_path / "rd3.pdf", "RD", 2)]

        _found, [more_lines] = visual.run(docs, storage, "obj")

        assert 90 <= more_lines.compliance_percent < sheet_pair.compliance_percent < 100

    def test_identical_sheets_give_nothing(self, tmp_path) -> None:
        image = base_map(7)
        sheet_pdf(tmp_path / "a.pdf", image, (40, 120, 555, 463))
        sheet_pdf(tmp_path / "b.pdf", image, (80, 200, 440, 440))
        storage = tmp_path / "storage"
        docs = [loaded(storage, tmp_path / "a.pdf", "PD", 1), loaded(storage, tmp_path / "b.pdf", "RD", 2)]

        assert visual.run(docs, storage, "obj") == ([], [])

    def test_different_drawings_are_not_compared(self, tmp_path) -> None:
        sheet_pdf(tmp_path / "a.pdf", base_map(7), (40, 120, 555, 463))
        sheet_pdf(tmp_path / "b.pdf", base_map(99), (40, 120, 555, 463))
        storage = tmp_path / "storage"
        docs = [loaded(storage, tmp_path / "a.pdf", "PD", 1), loaded(storage, tmp_path / "b.pdf", "RD", 2)]

        assert visual.run(docs, storage, "obj") == ([], [])

    def test_text_page_is_not_a_drawing(self, tmp_path) -> None:
        """Скан записки: растр во весь лист, но распознанного текста много — это не чертёж."""
        base = base_map(7)
        sheet_pdf(tmp_path / "a.pdf", base, (40, 120, 555, 463))
        sheet_pdf(tmp_path / "b.pdf", base, (80, 200, 440, 440))
        storage = tmp_path / "storage"
        long_text = "Пояснительная записка. " * 40
        docs = [
            loaded(storage, tmp_path / "a.pdf", "PD", 1, text=long_text),
            loaded(storage, tmp_path / "b.pdf", "RD", 2, text=long_text),
        ]

        assert visual.run(docs, storage, "obj") == ([], [])

    def test_missing_source_is_skipped(self, pair, tmp_path) -> None:
        assert visual.run(pair, tmp_path / "elsewhere", "obj") == ([], [])


class TestLabels:
    def test_network_labels_from_ocr(self) -> None:
        texts = ["d=200-225", "K1", "70280", "d = 300", "00000", "gem.n", "Ярославское шоссе", "Ø110"]

        assert visual.labels(texts) == ["d=200-225", "К1", "70280", "d=300", "Ø110"]

    def test_title_with_scale(self) -> None:
        assert visual.title_of(["Ситуационный план, М1:2000"]) == TITLE
        assert visual.title_of(["Ситуационныйплан, М 1:2000"]) == TITLE  # так склеивает OCR скана
        assert visual.title_of(["вид сверху М 1:500"]) == "М 1:500"
        assert visual.title_of(["Пояснительная записка"]) is None


def test_matched_share_counts_both_sheets() -> None:
    """10 пикселей чернил на каждом листе, без пары 2 слева и 3 справа: соответствие (20 − 5) / 20."""
    left, right = np.zeros(100, bool), np.zeros(100, bool)
    left[:10] = right[:10] = True
    only_left, only_right = np.zeros(100, bool), np.zeros(100, bool)
    only_left[:2], only_right[:3] = True, True

    assert sheetdiff._matched_share(left, right, only_left, only_right) == pytest.approx(0.75)
    assert sheetdiff._matched_share(np.zeros(4, bool), np.zeros(4, bool), only_left[:4], only_right[:4]) == 1.0


def test_region_needs_visible_raster_share() -> None:
    """Картинка меньше `MIN_SHARE` листа (штамп, логотип) — не чертёж, даже если в ней много пикселей."""
    document = pymupdf.open()
    page = document.new_page(width=595, height=842)
    _ok, png = cv2.imencode(".png", base_map(3, (600, 400)))
    page.insert_image(pymupdf.Rect(40, 40, 140, 90), stream=png.tobytes())

    assert sheetdiff.image_pixels(document, 0) == 600 * 400
    assert sheetdiff.drawing_region(page) is None


def test_mosaic_page_is_skipped_before_the_expensive_lookup() -> None:
    """Лист из сотен плиток — векторный чертёж с заливками, а не растр: его отсекает дешёвый отсев."""
    document = pymupdf.open()
    page = document.new_page(width=595, height=842)
    _ok, png = cv2.imencode(".png", base_map(4, (600, 400)))
    page.insert_image(pymupdf.Rect(40, 40, 555, 400), stream=png.tobytes())
    assert sheetdiff.drawing_region(page) is not None
    for n in range(sheetdiff.MAX_PAGE_IMAGES):
        _ok, tile = cv2.imencode(".png", np.full((4, 4, 3), n % 250, np.uint8))
        page.insert_image(
            pymupdf.Rect(40 + n % 50 * 10, 420 + n // 50 * 10, 48 + n % 50 * 10, 428 + n // 50 * 10),
            stream=tile.tobytes(),
        )

    assert sheetdiff.image_pixels(document, 0) == 0
    assert sheetdiff.drawing_region(document[0]) is None


def test_hypothesis_and_sheet_pair_reach_the_compare_result(pair, tmp_path) -> None:
    settings = Settings(
        _env_file=None,
        storage_dir=tmp_path / "storage",
        number_diff_enabled=False,
        llm_enabled=False,
        ocr_engine="none",
    )
    request = CompareRequest.model_validate(
        {
            "process_id": str(uuid.uuid4()),
            "object_id": str(uuid.uuid4()),
            "protocol_version": 1,
            "mode": "FULL",
            "matrix": {"version": "m-test", "params": []},
            "files": [],
            "versions": {"dataset_version": "none"},
        }
    )
    result = CompareResult.model_validate(
        {"process_id": request.process_id, "protocol_version": 1, "status": "OK", "checks": [], "page_pairs": []}
    )

    after = _with_hypotheses(result, pair, settings, request, [])

    assert [str(s.discovery_method.root) for s in after.suspicions] == ["VISUAL_DIFF"]
    assert [p.pair_key for p in after.page_pairs] == [after.suspicions[0].page_pair_key]


def _pd_and_two_rd(tmp_path: Path) -> list[LoadedDocument]:
    """ПД и два листа РД: крупный чужой чертёж и мельче — пара к ПД (растр меньше, по размеру он второй)."""
    base = base_map(7)
    pd_image, rd_image = base.copy(), base.copy()
    cv2.line(pd_image, (700, 100), (900, 700), BROWN, 8)
    cv2.line(rd_image, (100, 600), (500, 200), BLUE, 8)
    sheet_pdf(tmp_path / "pd.pdf", pd_image, (40, 120, 555, 463))
    sheet_pdf(tmp_path / "other.pdf", base_map(99, (1600, 1000)), (40, 120, 555, 463))
    sheet_pdf(tmp_path / "rd.pdf", rd_image, (80, 200, 440, 440))
    storage = tmp_path / "storage"
    return [
        loaded(storage, tmp_path / "pd.pdf", "PD", 1),
        loaded(storage, tmp_path / "other.pdf", "RD", 2),
        loaded(storage, tmp_path / "rd.pdf", "RD", 3),
    ]


def _hint(left: LoadedDocument, right: LoadedDocument) -> PagePairResult:
    return PagePairResult.model_validate(
        {
            "pair_key": "hint",
            "left": {"file_id": str(left.file_id), "page": 1},
            "right": {"file_id": str(right.file_id), "page": 1},
            "match_score": 0.8,
            "diff_regions": [],
        }
    )


def _with_codes(docs: list[LoadedDocument], *codes: str) -> list[LoadedDocument]:
    """Те же документы с шифрами: по шифру `semantic.system` узнаёт инженерную систему (ИОС5.4 и ОВ1 — «ОВ»)."""
    return [
        LoadedDocument(d.file_id, d.sha256, d.metadata.model_copy(update={"document_code": code}), d.parsed)
        for d, code in zip(docs, codes, strict=True)
    ]


class TestCoverage:
    """Лимиты не теряют пары молча, вероятные пары проверяются первыми (консультация 16.10)."""

    def test_full_run_reports_everything_checked(self, pair, tmp_path) -> None:
        found = visual.scan(pair, tmp_path / "storage", "obj")

        coverage = found.coverage
        assert coverage is not None and not coverage.limited
        assert (coverage.pairs_possible, coverage.pairs_checked, coverage.pairs_matched) == (1, 1, 1)
        assert {(str(s.stage.root), s.matched) for s in coverage.sheets} == {("PD", True), ("RD", True)}
        assert coverage.skipped == [] and coverage.skipped_total == 0
        assert {str(s.stage.root): (s.candidates, s.taken) for s in coverage.stages} == {"PD": (1, 1), "RD": (1, 1)}

    def test_sheet_limit_skips_the_pair_and_says_so(self, tmp_path) -> None:
        docs = _pd_and_two_rd(tmp_path)
        found = visual.scan(docs, tmp_path / "storage", "obj", limits=visual.Limits(max_sheets=1))

        assert found.suspicions == []
        assert found.coverage.limited
        assert [(item.file_id, str(item.reason)) for item in found.coverage.skipped] == [(docs[2].file_id, "LIMIT")]

    def test_likely_pair_goes_first_within_the_limit(self, tmp_path) -> None:
        docs = _pd_and_two_rd(tmp_path)
        found = visual.scan(
            docs, tmp_path / "storage", "obj", limits=visual.Limits(max_sheets=1), hints=[_hint(docs[0], docs[2])]
        )

        [hypothesis] = found.suspicions
        assert hypothesis.rd_reference == "RD-1, стр. 1"
        assert [item.file_id for item in found.coverage.skipped] == [docs[1].file_id]

    def test_same_system_goes_first_within_the_sheet_limit(self, tmp_path) -> None:
        """Подсказок пар нет, но шифры говорят: ПД — том ИОС5.4 (ОВ), крупный чужой лист — ВК, пара к ПД — ОВ1."""
        docs = _with_codes(_pd_and_two_rd(tmp_path), "1-П-ИОС5.4.2", "1-РД-ВК1", "1-РД-ОВ1")
        found = visual.scan(docs, tmp_path / "storage", "obj", limits=visual.Limits(max_sheets=1))

        assert len(found.suspicions) == 1
        assert [(item.file_id, str(item.reason)) for item in found.coverage.skipped] == [(docs[1].file_id, "LIMIT")]

    def test_same_system_pair_goes_first_within_the_pair_limit(self, tmp_path, monkeypatch) -> None:
        """Порядок пар сам по себе: листы РД идут по размеру (чужой первым), а первой проверяется пара ОВ ↔ ОВ."""
        docs = _with_codes(_pd_and_two_rd(tmp_path), "1-П-ИОС5.4.2", "1-РД-ВК1", "1-РД-ОВ1")
        monkeypatch.setattr(visual, "_shared_systems", lambda docs: set())
        found = visual.scan(docs, tmp_path / "storage", "obj", limits=visual.Limits(max_pair_checks=1))

        assert len(found.suspicions) == 1
        assert [(item.file_id, str(item.reason)) for item in found.coverage.skipped] == [
            (docs[1].file_id, "PAIRS_LIMIT")
        ]

    def test_pair_limit_marks_unchecked_sheets(self, tmp_path) -> None:
        docs = _pd_and_two_rd(tmp_path)
        found = visual.scan(docs, tmp_path / "storage", "obj", limits=visual.Limits(max_pair_checks=1))

        coverage = found.coverage
        assert coverage.limited and (coverage.pairs_possible, coverage.pairs_checked) == (2, 1)
        assert [(item.file_id, str(item.reason)) for item in coverage.skipped] == [(docs[2].file_id, "PAIRS_LIMIT")]

    def test_no_reference_drawings_means_no_report(self, tmp_path) -> None:
        sheet_pdf(tmp_path / "rd.pdf", base_map(7), (40, 120, 555, 463))
        storage = tmp_path / "storage"
        found = visual.scan([loaded(storage, tmp_path / "rd.pdf", "RD", 2)], storage, "obj")

        assert found.coverage is None

    def test_settings_zero_means_no_limit(self) -> None:
        assert visual.Limits.of(0, 0, 0) == visual.Limits(None, None, None)
        assert visual.Limits.of(12, 60, 30.0) == visual.Limits(12, 60, 30.0)


def sheet_with_labels(path: Path, image: np.ndarray, rect: tuple[float, float, float, float], changed: str) -> None:
    """Лист с растром и подписями в текстовом слое поверх него: 12 общих размеров и один на месте (0,5; 0,5) растра."""
    ok, png = cv2.imencode(".png", image)
    assert ok
    document = pymupdf.open()
    page = document.new_page(width=595, height=842)
    page.insert_image(pymupdf.Rect(*rect), stream=png.tobytes())
    x0, y0, x1, y1 = rect
    labels = [(0.05 + 0.075 * i, 0.9, str(1000 + 100 * i)) for i in range(12)] + [(0.5, 0.5, changed)]
    for u, v, text in labels:
        page.insert_text((x0 + u * (x1 - x0), y0 + v * (y1 - y0)), text, fontsize=5)
    document.save(path)
    document.close()


def cad_cache(storage: Path, doc: LoadedDocument, changed: str) -> None:
    """Кеш OCR листа целиком (`cad_labels.cached`): 12 общих сечений и одно на месте (0,5; 0,5) растра."""
    x0, y0, x1, y1 = 40 / 595, 120 / 842, 555 / 595, 463 / 842  # где растр на странице (`sheet_pdf` ниже)
    lines = [
        {"text": f"{400 + 50 * i}x300", "conf": 0.9, "bbox": [x0 + u * (x1 - x0), y0 + 0.9 * (y1 - y0), 0, 0]}
        for i, u in enumerate(0.05 + 0.075 * k for k in range(12))
    ] + [{"text": changed, "conf": 0.9, "bbox": [x0 + 0.5 * (x1 - x0), y0 + 0.5 * (y1 - y0), 0, 0]}]
    for line in lines:
        bx, by = line["bbox"][:2]
        line["bbox"] = [bx, by, bx + 0.03, by + 0.008]
    path = storage / "cad" / doc.sha256 / "1-200.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(lines), encoding="utf-8")


class TestChangedLabels:
    """Другая подпись на том же месте совмещённых листов — «280 → 300» в гипотезе."""

    def test_cad_font_labels_come_from_the_ocr_cache(self, tmp_path) -> None:
        """Подписи нарисованы линиями, текстового слоя нет: изменение видно по кешу OCR, если распознаны оба листа."""
        base = base_map(7)
        sheet_pdf(tmp_path / "pd.pdf", base, (40, 120, 555, 463), "PD")
        sheet_pdf(tmp_path / "rd.pdf", base, (40, 120, 555, 463), "RD")
        storage = tmp_path / "storage"
        docs = [loaded(storage, tmp_path / "pd.pdf", "PD", 1), loaded(storage, tmp_path / "rd.pdf", "RD", 2)]
        cad_cache(storage, docs[0], "500x300")

        assert visual.scan(docs, storage, "obj").suspicions == []  # распознан только лист ПД — не сравниваем

        cad_cache(storage, docs[1], "400x250")
        [hypothesis] = visual.scan(docs, storage, "obj").suspicions

        assert "Изменены подписи (ПД → РД): 500х300 → 400х250." in hypothesis.description

    def test_changed_label_is_named(self, tmp_path) -> None:
        base = base_map(7)
        sheet_with_labels(tmp_path / "pd.pdf", base, (40, 120, 555, 463), "280")
        sheet_with_labels(tmp_path / "rd.pdf", base, (80, 200, 440, 440), "300")
        storage = tmp_path / "storage"
        docs = [loaded(storage, tmp_path / "pd.pdf", "PD", 1), loaded(storage, tmp_path / "rd.pdf", "RD", 2)]

        found = visual.scan(docs, storage, "obj")

        [hypothesis] = found.suspicions
        assert "Изменены подписи (ПД → РД): 280 → 300." in hypothesis.description
        assert hypothesis.confidence == visual.CONFIDENCE_CHANGED
        assert {"280", "300"} <= {e.text_snippet for e in hypothesis.evidence}
        [sheet_pair] = found.pairs
        assert "изменено: 280 → 300" in {r.label for r in sheet_pair.diff_regions}

    def test_same_labels_give_nothing(self, tmp_path) -> None:
        base = base_map(7)
        sheet_with_labels(tmp_path / "pd.pdf", base, (40, 120, 555, 463), "280")
        sheet_with_labels(tmp_path / "rd.pdf", base, (80, 200, 440, 440), "280")
        storage = tmp_path / "storage"
        docs = [loaded(storage, tmp_path / "pd.pdf", "PD", 1), loaded(storage, tmp_path / "rd.pdf", "RD", 2)]

        assert visual.scan(docs, storage, "obj").suspicions == []


RED = (30, 30, 200)  # BGR
PLAN = "План вентиляции 1 этажа М 1:100 пом. 101 102 103 104 П1 В1 В2"


def _rd_and_built(tmp_path: Path, *, foreign: bool = False) -> list[LoadedDocument]:
    """РД: подложка + синяя линия; ИД — тот же лист с тем же текстом и лишней красной линией (отступление).

    `foreign` — ещё крупный чужой лист ИД с другим текстом: по размеру он первый в очереди пар.
    """
    rd_image = base_map(7)
    cv2.line(rd_image, (100, 600), (500, 200), BLUE, 8)
    built_image = rd_image.copy()
    cv2.line(built_image, (700, 100), (900, 700), RED, 8)
    sheet_pdf(tmp_path / "rd.pdf", rd_image, (40, 120, 555, 463))
    sheet_pdf(tmp_path / "id.pdf", built_image, (40, 120, 555, 463))
    storage = tmp_path / "storage"
    docs = [loaded(storage, tmp_path / "rd.pdf", "RD", 1, PLAN), loaded(storage, tmp_path / "id.pdf", "ID", 2, PLAN)]
    if foreign:
        sheet_pdf(tmp_path / "other.pdf", base_map(99, (1600, 1000)), (40, 120, 555, 463))
        docs.insert(1, loaded(storage, tmp_path / "other.pdf", "ID", 3, "Схема водоснабжения М 1:200 К1 В1 Т3"))
    return docs


class TestAsBuilt:
    """Исполнительный лист сверяется со своим листом РД — различие в такой паре есть отступление."""

    def test_rd_and_id_without_pd(self, tmp_path) -> None:
        found = visual.scan(_rd_and_built(tmp_path), tmp_path / "storage", "obj")

        [hypothesis] = found.suspicions
        assert "совмещения РД и ИД" in hypothesis.description
        assert "отличается от рабочего" in hypothesis.description
        assert (hypothesis.pd_reference, hypothesis.rd_reference, hypothesis.id_reference) == (
            None,
            "RD-1, стр. 1",
            "ID-1, стр. 1",
        )
        roles = {(str(e.role.root), str(e.stage.root)) for e in hypothesis.evidence}
        assert roles == {("EXPECTED", "RD"), ("ACTUAL", "ID")}
        [sheet_pair] = found.pairs
        assert {r.label for r in sheet_pair.diff_regions} == {"только в ИД · план"}

    def test_id_alone_has_nothing_to_compare_with(self, tmp_path) -> None:
        docs = [d for d in _rd_and_built(tmp_path) if str(d.stage) == "ID"]

        assert visual.scan(docs, tmp_path / "storage", "obj").coverage is None

    def test_copy_of_the_rd_sheet_goes_first_within_the_pair_limit(self, tmp_path) -> None:
        """Чужой крупный лист ИД первый по размеру, но первой проверяется копия листа РД — по тексту."""
        docs = _rd_and_built(tmp_path, foreign=True)
        found = visual.scan(docs, tmp_path / "storage", "obj", limits=visual.Limits(max_pair_checks=1))

        [hypothesis] = found.suspicions
        assert hypothesis.id_reference == "ID-1, стр. 1"
        assert [(item.file_id, str(item.reason)) for item in found.coverage.skipped] == [
            (docs[1].file_id, "PAIRS_LIMIT")
        ]

    def test_id_sheet_pairs_with_its_rd_sheet_not_with_pd(self, tmp_path) -> None:
        """ПД, РД и ИД: разница ПД ↔ РД — одна гипотеза, отступление ИД от РД — вторая; ПД ↔ ИД не повторяет первую."""
        pd_image = base_map(7)
        cv2.line(pd_image, (700, 100), (900, 700), BROWN, 8)
        sheet_pdf(tmp_path / "pd.pdf", pd_image, (80, 200, 440, 440))
        docs = [loaded(tmp_path / "storage", tmp_path / "pd.pdf", "PD", 9), *_rd_and_built(tmp_path)]

        found = visual.scan(docs, tmp_path / "storage", "obj")

        pairs = {(h.pd_reference, h.rd_reference, h.id_reference) for h in found.suspicions}
        assert pairs == {("PD-1, стр. 1", "RD-1, стр. 1", None), (None, "RD-1, стр. 1", "ID-1, стр. 1")}


def test_coverage_reaches_the_compare_result(pair, tmp_path) -> None:
    settings = Settings(
        _env_file=None,
        storage_dir=tmp_path / "storage",
        number_diff_enabled=False,
        llm_enabled=False,
        ocr_engine="none",
    )
    request = CompareRequest.model_validate(
        {
            "process_id": str(uuid.uuid4()),
            "object_id": str(uuid.uuid4()),
            "protocol_version": 1,
            "mode": "FULL",
            "matrix": {"version": "m-test", "params": []},
            "files": [],
            "versions": {"dataset_version": "none"},
        }
    )
    result = CompareResult.model_validate(
        {"process_id": request.process_id, "protocol_version": 1, "status": "OK", "checks": [], "page_pairs": []}
    )

    after = _with_hypotheses(result, pair, settings, request, [])

    assert after.visual_coverage is not None and after.visual_coverage.pairs_checked == 1
    assert after.visual_coverage.limits.max_sheets_per_stage == settings.visual_max_sheets


# --- векторные листы, мозаики, штамп и насыщенность текстом по площади ---------------------------------

STAMP = (0.55, 0.88, 0.97, 0.98)  # штамп в правом нижнем углу листа, доли страницы


def vector_pdf(
    path: Path,
    seed: int,
    line: tuple[tuple[int, int], tuple[int, int], tuple[float, float, float]] | None,
    stamp: str,
    tiles: int = 0,
    signed: bool = False,
    width: float = 4,
) -> None:
    """Векторный чертёж САПР: кварталы, улицы и подписи нарисованы, а не вставлены картинкой.

    `line` — своя линия листа (сеть ПД или РД) толщиной `width` пунктов, `stamp` — строки основной надписи через
    «|», `tiles` — плитки-картинки мозаики, `signed` — росчерк подписи в штампе (у РД с изменениями он есть).
    """
    rng = np.random.default_rng(seed)
    document = pymupdf.open()
    page = document.new_page(width=595, height=842)
    for _ in range(60):
        x, y = float(rng.integers(30, 480)), float(rng.integers(60, 640))
        w, h = float(rng.integers(15, 80)), float(rng.integers(10, 50))
        page.draw_rect(pymupdf.Rect(x, y, x + w, y + h), color=(0.15, 0.15, 0.15), fill=(0.6, 0.6, 0.6), width=1)
    for _ in range(25):
        points = [pymupdf.Point(float(a), float(b)) for a, b in rng.integers([30, 60], [560, 700], size=(3, 2))]
        page.draw_polyline(points, color=(0.25, 0.25, 0.25), width=1.2)
    for _ in range(80):
        x, y = float(rng.integers(30, 560)), float(rng.integers(60, 700))
        page.insert_text((x, y), str(int(rng.integers(0, 99))), fontsize=6)
    if line is not None:
        start, end, color = line
        page.draw_line(pymupdf.Point(*start), pymupdf.Point(*end), color=color, width=width)
    x0, y0, x1, y1 = STAMP
    page.draw_rect(pymupdf.Rect(x0 * 595, y0 * 842, x1 * 595, y1 * 842), color=(0, 0, 0), width=1)
    for i, text in enumerate(stamp.split("|")):
        page.insert_text((x0 * 595 + 6, y0 * 842 + 20 + i * 24), text, fontsize=13)
    if signed:
        zigzag = [pymupdf.Point(x0 * 595 + 120 + k * 12, y0 * 842 + (30 if k % 2 else 70)) for k in range(12)]
        page.draw_polyline(zigzag, color=(0.1, 0.2, 0.7), width=3)
    for n in range(tiles):
        _ok, tile = cv2.imencode(".png", np.full((4, 4, 3), 200, np.uint8))
        page.insert_image(
            pymupdf.Rect(30 + n % 50 * 4, 705 + n // 50 * 4, 33 + n % 50 * 4, 708 + n // 50 * 4), stream=tile.tobytes()
        )
    document.save(path)
    document.close()


def table_pdf(path: Path, rows: list[int], first: int = 0) -> None:
    """Спецификация САПР на общем шаблоне: шапка и сетка одни и те же, строки — свой текст (`rows` — зёрна строк).

    `first` — с какой строки сетки начинается текст: у листа-продолжения строки стоят на других местах.
    """
    document = pymupdf.open()
    page = document.new_page(width=842, height=595)
    columns = [30, 70, 330, 450, 560, 640, 700, 810]
    for x in columns:
        page.draw_line(pymupdf.Point(x, 30), pymupdf.Point(x, 560), color=(0, 0, 0), width=0.7)
    for k in range(23):
        y = 30 + k * 23 if k else 30
        page.draw_line(pymupdf.Point(30, y), pymupdf.Point(810, y), color=(0, 0, 0), width=1.2 if k < 2 else 0.5)
    for x, title in zip(columns, ("Поз.", "Наименование", "Тип, марка", "Код", "Ед.", "Кол.", "Масса"), strict=False):
        page.insert_text((x + 4, 44), title, fontsize=8)
    for row, seed in enumerate(rows):
        rng = np.random.default_rng(seed)
        y = 30 + (first + row + 2) * 23 - 7
        page.insert_text((34, y), f"B{seed}", fontsize=8)
        # латиница: встроенный шрифт PDF кириллицу не рисует, а нам нужны чернила строки
        words = [str(rng.choice(["Exhaust", "unit", "damper", "grille", "duct", "see", "KP"])) for _ in range(5)]
        page.insert_text((74, y), " ".join(words), fontsize=8)
        page.insert_text((334, y), f"WNK {int(rng.integers(100, 400))}/{int(rng.integers(1, 9))}", fontsize=8)
        page.insert_text((644, y), str(int(rng.integers(1, 9))), fontsize=8)
    document.save(path)
    document.close()


def drawing(storage: Path, pdf: Path, stage: str, n: int, blocks: list[dict] | None = None) -> LoadedDocument:
    """Документ, чей лист разбор пометил чертежом; штамп — блок `title_block`."""
    doc = loaded(storage, pdf, stage, n)
    stamp = {"id": "s0", "type": "title_block", "text": "штамп", "bbox": list(STAMP)}
    doc.parsed["pages"][0].update(is_drawing=True, width_pt=595, height_pt=842, blocks=[*(blocks or []), stamp])
    return doc


class TestVectorSheets:
    """Векторный чертёж САПР и лист-мозаика сравниваются, а не отсеиваются (консультация 16.10)."""

    def test_vector_drawings_are_compared(self, tmp_path) -> None:
        vector_pdf(tmp_path / "pd.pdf", 7, ((400, 120), (500, 600), (0.47, 0.24, 0.16)), "ПД-1")
        vector_pdf(tmp_path / "rd.pdf", 7, ((80, 560), (300, 160), (0.08, 0.31, 0.78)), "РД-1")
        storage = tmp_path / "storage"
        docs = [drawing(storage, tmp_path / "pd.pdf", "PD", 1), drawing(storage, tmp_path / "rd.pdf", "RD", 2)]

        found = visual.scan(docs, storage, "obj")

        [hypothesis] = found.suspicions
        [sheet_pair] = found.pairs
        assert {r.label for r in sheet_pair.diff_regions} == {"только в ПД · чертёж", "только в РД · чертёж"}
        assert hypothesis.page_pair_key == sheet_pair.pair_key
        assert {str(s.stage.root): (s.candidates, s.taken) for s in found.coverage.stages} == {
            "PD": (1, 1),
            "RD": (1, 1),
        }

    def test_vector_page_without_drawing_mark_is_not_taken(self, tmp_path) -> None:
        """Без метки разбора векторная страница — не чертёж: записку без картинок в графику не берём."""
        vector_pdf(tmp_path / "pd.pdf", 7, ((400, 120), (500, 600), (0.47, 0.24, 0.16)), "ПД-1")
        vector_pdf(tmp_path / "rd.pdf", 7, ((80, 560), (300, 160), (0.08, 0.31, 0.78)), "РД-1")
        storage = tmp_path / "storage"
        docs = [loaded(storage, tmp_path / "pd.pdf", "PD", 1), loaded(storage, tmp_path / "rd.pdf", "RD", 2)]

        assert visual.run(docs, storage, "obj") == ([], [])

    def test_stamp_is_not_a_difference(self, tmp_path) -> None:
        """Чертёж один и тот же, разные только шифр и стадия в штампе — гипотезы нет: штамп закрашен."""
        vector_pdf(tmp_path / "pd.pdf", 7, None, "ПД-1")
        vector_pdf(tmp_path / "rd.pdf", 7, None, "РД-1|изм. 4 стадия Р 17.11.2025 Иванов", signed=True)
        storage = tmp_path / "storage"
        docs = [drawing(storage, tmp_path / "pd.pdf", "PD", 1), drawing(storage, tmp_path / "rd.pdf", "RD", 2)]

        found = visual.scan(docs, storage, "obj")

        assert found.suspicions == []
        assert found.coverage.pairs_matched == 1  # совместились — это тот же чертёж

    def test_thin_line_missing_from_rd_is_found(self, tmp_path) -> None:
        """Линия САПР 0,25 мм (0,7 пт) есть в ПД и пропала в РД — это различие, а не шум сжатия.

        Раньше такую линию стирали сглаживание и раскрытие маски. Находится её свободный отрезок: где линия идёт
        по залитым кварталам, рядом есть чернила РД, и это место различием не считается.
        """
        vector_pdf(tmp_path / "pd.pdf", 7, ((420, 110), (520, 620), (0.0, 0.0, 0.0)), "ПД-1", width=0.7)
        vector_pdf(tmp_path / "rd.pdf", 7, None, "РД-1")
        storage = tmp_path / "storage"
        docs = [drawing(storage, tmp_path / "pd.pdf", "PD", 1), drawing(storage, tmp_path / "rd.pdf", "RD", 2)]

        found = visual.scan(docs, storage, "obj")

        assert len(found.suspicions) == 1
        [sheet_pair] = found.pairs
        assert [r.label for r in sheet_pair.diff_regions] == ["только в ПД · чертёж"]
        x0, y0, x1, y1 = (v.root for v in sheet_pair.diff_regions[0].left_bbox.root)
        assert x0 < 440 / 595 < x1 and y0 < 212 / 842 < y1  # точка линии на пятой части её длины

    def test_different_tables_on_one_template_are_not_a_pair(self, tmp_path, monkeypatch) -> None:
        """Сетка и шапка совмещаются, но строки на других местах — это разные спецификации, а не правка одной."""
        table_pdf(tmp_path / "pd.pdf", list(range(1, 13)))
        table_pdf(tmp_path / "rd.pdf", list(range(101, 108)), first=13)
        storage = tmp_path / "storage"
        docs = [drawing(storage, tmp_path / "pd.pdf", "PD", 1), drawing(storage, tmp_path / "rd.pdf", "RD", 2)]

        found = visual.scan(docs, storage, "obj")

        assert found.suspicions == [] and found.coverage.pairs_matched == 0
        monkeypatch.setattr(sheetdiff, "MAX_UNMATCHED_SHARE", 1.0)
        assert visual.scan(docs, storage, "obj").coverage.pairs_matched == 1  # совмещение само по себе проходит

    def test_table_extended_in_rd_is_a_pair(self, tmp_path) -> None:
        """Та же спецификация, в РД добавлены строки: ПД целиком есть в РД — пара, различие «только в РД»."""
        table_pdf(tmp_path / "pd.pdf", list(range(1, 13)))
        table_pdf(tmp_path / "rd.pdf", list(range(1, 19)))
        storage = tmp_path / "storage"
        # название листа в основной надписи, как у настоящей спецификации: по нему текст строки — содержимое таблицы
        name = [
            {"id": "n0", "type": "title_block", "text": "Спецификация оборудования", "bbox": [0.8, 0.95, 0.95, 0.97]}
        ]
        docs = [
            drawing(storage, tmp_path / "pd.pdf", "PD", 1, blocks=name),
            drawing(storage, tmp_path / "rd.pdf", "RD", 2, blocks=name),
        ]

        found = visual.scan(docs, storage, "obj")

        assert len(found.suspicions) == 1
        assert {r.label for r in found.pairs[0].diff_regions} == {"только в РД · таблица"}
        # про таблицу — сверить значения, а не «сети и трасса» (рецензия экспертов 17.10, п. 5)
        description = found.suspicions[0].description
        assert "в таблице —" in description and "Сверьте значения в таблице" in description
        assert "трасс" not in description

    def test_black_line_with_a_dimension_is_not_a_network(self, tmp_path) -> None:
        """Лист КР — чёрные линии и размер «39600» в области: это не колодец и не сеть, про трассу молчим."""
        vector_pdf(tmp_path / "pd.pdf", 7, ((420, 110), (520, 620), (0.0, 0.0, 0.0)), "ПД-1", width=0.7)
        vector_pdf(tmp_path / "rd.pdf", 7, None, "РД-1")
        storage = tmp_path / "storage"
        size = [{"id": "d0", "type": "text", "text": "39600", "bbox": [0.735, 0.249, 0.745, 0.255]}]
        docs = [
            drawing(storage, tmp_path / "pd.pdf", "PD", 1, blocks=size),
            drawing(storage, tmp_path / "rd.pdf", "RD", 2, blocks=size),
        ]

        [hypothesis] = visual.scan(docs, storage, "obj").suspicions

        assert "Проверьте, что изменилось на чертеже." in hypothesis.description
        assert "трасс" not in hypothesis.description and "39600" not in hypothesis.description

    def test_colored_network_lines_keep_the_route_advice(self, tmp_path) -> None:
        vector_pdf(tmp_path / "pd.pdf", 7, ((400, 120), (500, 600), (0.47, 0.24, 0.16)), "ПД-1")
        vector_pdf(tmp_path / "rd.pdf", 7, ((80, 560), (300, 160), (0.08, 0.31, 0.78)), "РД-1")
        storage = tmp_path / "storage"
        docs = [drawing(storage, tmp_path / "pd.pdf", "PD", 1), drawing(storage, tmp_path / "rd.pdf", "RD", 2)]

        [hypothesis] = visual.scan(docs, storage, "obj").suspicions

        assert "разные сети или изменена трасса" in hypothesis.description

    def test_difference_in_the_stamp_zone_is_not_shown(self, tmp_path) -> None:
        """Линия только в РД — в зоне основной надписи над закрашенным штампом: шифр и подписи не показываем."""
        vector_pdf(tmp_path / "pd.pdf", 7, None, "ПД-1")
        vector_pdf(tmp_path / "rd.pdf", 7, ((80, 690), (280, 720), (0.08, 0.31, 0.78)), "РД-1")
        storage = tmp_path / "storage"
        docs = [drawing(storage, tmp_path / "pd.pdf", "PD", 1), drawing(storage, tmp_path / "rd.pdf", "RD", 2)]

        found = visual.scan(docs, storage, "obj")

        assert found.coverage.pairs_matched == 1
        assert found.suspicions == [] and found.pairs == []

    def test_render_sheet_restores_antialiasing(self, tmp_path) -> None:
        vector_pdf(tmp_path / "pd.pdf", 7, None, "ПД-1")
        before = pymupdf.TOOLS.show_aa_level()
        with pymupdf.open(tmp_path / "pd.pdf") as document:
            sheet = sheetdiff.render_sheet(document[0])

        assert sheet.clean
        assert pymupdf.TOOLS.show_aa_level() == before  # сглаживание общее для процесса: OCR рисует со сглаживанием

    def test_mosaic_drawing_is_rendered_without_the_expensive_lookup(self, tmp_path, monkeypatch) -> None:
        vector_pdf(
            tmp_path / "pd.pdf",
            7,
            ((400, 120), (500, 600), (0.47, 0.24, 0.16)),
            "ПД-1",
            tiles=sheetdiff.MAX_PAGE_IMAGES + 5,
        )
        vector_pdf(
            tmp_path / "rd.pdf",
            7,
            ((80, 560), (300, 160), (0.08, 0.31, 0.78)),
            "РД-1",
            tiles=sheetdiff.MAX_PAGE_IMAGES + 5,
        )
        storage = tmp_path / "storage"
        docs = [drawing(storage, tmp_path / "pd.pdf", "PD", 1), drawing(storage, tmp_path / "rd.pdf", "RD", 2)]

        def no_lookup(page):  # get_image_info на мозаике идёт до 13 с
            raise AssertionError("drawing_region на мозаике")

        monkeypatch.setattr(sheetdiff, "drawing_region", no_lookup)
        found = visual.scan(docs, storage, "obj")

        assert len(found.suspicions) == 1
        assert found.coverage.skipped == []
        assert {str(s.stage.root): s.mosaic for s in found.coverage.stages} == {"PD": 1, "RD": 1}

    def test_text_heavy_drawing_is_listed_and_notes_are_only_counted(self, tmp_path) -> None:
        """Контракт 0.26.0: лист-чертёж со спецификацией — в отчёт поимённо (TEXT_HEAVY), записка — только числом."""
        vector_pdf(tmp_path / "pd.pdf", 7, ((400, 120), (500, 600), (0.47, 0.24, 0.16)), "ПД-1")
        vector_pdf(tmp_path / "rd.pdf", 7, ((80, 560), (300, 160), (0.08, 0.31, 0.78)), "РД-1")
        sheet_pdf(tmp_path / "note.pdf", base_map(3), (40, 120, 555, 463))
        storage = tmp_path / "storage"
        spec = {"type": "text", "text": "Спецификация оборудования", "bbox": [0.05, 0.05, 0.95, 0.6]}
        docs = [
            drawing(storage, tmp_path / "pd.pdf", "PD", 1),
            drawing(storage, tmp_path / "rd.pdf", "RD", 2, blocks=[spec]),
            loaded(storage, tmp_path / "note.pdf", "RD", 3, text="Пояснительная записка " * 40),
        ]

        coverage = visual.scan(docs, storage, "obj").coverage

        assert [(item.file_id, str(item.reason)) for item in coverage.skipped] == [(docs[1].file_id, "TEXT_HEAVY")]
        assert {str(s.stage.root): s.text_heavy for s in coverage.stages}["RD"] == 2

    def test_limits_are_listed_before_text_heavy(self, tmp_path) -> None:
        vector_pdf(tmp_path / "a.pdf", 7, ((400, 120), (500, 600), (0.47, 0.24, 0.16)), "ПД-1")
        vector_pdf(tmp_path / "b.pdf", 9, ((80, 560), (300, 160), (0.08, 0.31, 0.78)), "ПД-2")
        vector_pdf(tmp_path / "c.pdf", 11, None, "ПД-3")
        storage = tmp_path / "storage"
        spec = {"type": "text", "text": "Спецификация", "bbox": [0.05, 0.05, 0.95, 0.6]}
        docs = [
            drawing(storage, tmp_path / "c.pdf", "PD", 3, blocks=[spec]),
            drawing(storage, tmp_path / "a.pdf", "PD", 1),
            drawing(storage, tmp_path / "b.pdf", "PD", 2),
        ]

        coverage = visual.scan(docs, storage, "obj", limits=visual.Limits(max_sheets=1)).coverage

        assert [str(item.reason) for item in coverage.skipped] == ["LIMIT", "TEXT_HEAVY"]

    def test_raster_memory_budget_skips_sheets_as_limit(self, tmp_path) -> None:
        """Растры держатся в памяти всю проверку пар; сверх бюджета лист не рисуется и уходит в LIMIT."""
        vector_pdf(tmp_path / "a.pdf", 7, ((400, 120), (500, 600), (0.47, 0.24, 0.16)), "ПД-1")
        vector_pdf(tmp_path / "b.pdf", 9, ((80, 560), (300, 160), (0.08, 0.31, 0.78)), "ПД-2")
        vector_pdf(tmp_path / "rd.pdf", 7, ((80, 560), (300, 160), (0.08, 0.31, 0.78)), "РД-1")
        storage = tmp_path / "storage"
        docs = [
            drawing(storage, tmp_path / "a.pdf", "PD", 1),
            drawing(storage, tmp_path / "b.pdf", "PD", 2),
            drawing(storage, tmp_path / "rd.pdf", "RD", 3),
        ]
        sheet_mb = 3 * sheetdiff.sheet_pixels(595, 842) / 2**20  # лист A4 при 150 dpi — около 6 МБ

        coverage = visual.scan(docs, storage, "obj", limits=visual.Limits(None, None, None, 2.5 * sheet_mb)).coverage

        assert {str(s.stage.root): s.taken for s in coverage.stages} == {"PD": 1, "RD": 1}
        assert [str(item.reason) for item in coverage.skipped] == ["LIMIT"]
        assert coverage.limited

    def test_raster_region_is_capped_like_a_whole_sheet(self) -> None:
        document = pymupdf.open()
        page = document.new_page(width=3370, height=2384)  # A0

        image = sheetdiff.render(page, (0.0, 0.0, 1.0, 1.0))

        assert max(image.shape[:2]) <= sheetdiff.SHEET_MAX_PX

    def test_text_heaviness_of_a_drawing_is_by_area(self) -> None:
        """Подписей на чертеже много, но они мелкие; спецификация на листе — сплошной текст по площади."""
        labels = [
            {
                "type": "text",
                "text": "Помещение 101 " * 4,
                "bbox": [0.1 + i % 10 * 0.08, 0.1 + i // 10 * 0.05, 0.15 + i % 10 * 0.08, 0.12 + i // 10 * 0.05],
            }
            for i in range(60)
        ]
        plan = {"page": 1, "is_drawing": True, "blocks": labels}
        spec = {
            "page": 1,
            "is_drawing": True,
            "blocks": [{"type": "text", "text": "Спецификация", "bbox": [0.05, 0.05, 0.95, 0.6]}],
        }
        note = {"page": 1, "blocks": labels}

        assert len(visual._page_text(plan)) > visual.MAX_TEXT_CHARS
        assert not visual._text_heavy(plan)
        assert visual._text_heavy(spec)
        assert visual._text_heavy(note)  # без метки чертежа — прежнее правило по символам

    def test_large_scan_is_measured_by_area(self) -> None:
        """Скан листа A1: разбор не пометил его чертежом, а распознанных подписей много — его всё равно берём."""
        labels = [
            {"type": "text", "text": "Помещение 101 " * 4, "bbox": [0.1 + i * 0.012, 0.1, 0.11 + i * 0.012, 0.12]}
            for i in range(60)
        ]
        scan_a1 = {"page": 1, "source": "OCR", "width_pt": 2384, "height_pt": 1684, "blocks": labels}
        scan_a4 = {**scan_a1, "width_pt": 595, "height_pt": 842}
        layer_a1 = {**scan_a1, "source": "TEXT_LAYER"}

        assert not visual._text_heavy(scan_a1)
        assert visual._text_heavy(scan_a4)  # мелкий скан — обычно акт: правило по символам
        assert visual._text_heavy(layer_a1)  # крупный лист с текстовым слоем без метки чертежа — не скан
