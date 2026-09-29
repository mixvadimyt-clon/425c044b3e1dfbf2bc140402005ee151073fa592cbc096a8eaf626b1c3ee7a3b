"""Листы-чертежи ПД ↔ РД: совмещение растров и гипотеза VISUAL_DIFF.

Синтетическая пара повторяет пару-пример: одна подложка вставлена на листы в разном месте и в
разном масштабе, в ПД поверх неё коричневая линия (канализация), в РД — синяя (водопровод).
OCR в тестах не нужен: подписи — дополнение к гипотезе, а не её условие.
"""

from __future__ import annotations

import hashlib
import uuid
from pathlib import Path

import cv2
import numpy as np
import pymupdf
import pytest

from inspector_ml.config import Settings
from inspector_ml.contracts.events import CompareRequest, CompareResult, DocumentMetadata
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
        assert {r.label for r in sheet_pair.diff_regions} == {"только в ПД", "только в РД"}

    def test_brown_line_is_located_where_it_was_drawn(self, pair, tmp_path) -> None:
        """Коричневая линия ПД стоит в правой части растра — рамка «только в ПД» там же."""
        _found, [sheet_pair] = visual.run(pair, tmp_path / "storage", "obj")
        only_pd = [r for r in sheet_pair.diff_regions if r.label == "только в ПД"]
        x0, _y0, x1, _y1 = (v.root for v in only_pd[0].left_bbox.root)
        # линия 700→900 px из 1200 на растре шириной 40…555 pt листа 595 pt
        assert x0 > 0.55 and x1 < 0.9

    def test_homography_maps_right_page_to_left(self, pair, tmp_path) -> None:
        """Угол растра РД (80, 200 pt) переходит в угол растра ПД (40, 120 pt)."""
        _found, [sheet_pair] = visual.run(pair, tmp_path / "storage", "obj")
        matrix = np.array(sheet_pair.homography).reshape(3, 3)
        x, y, w = matrix @ np.array([80 / 595, 200 / 842, 1.0])
        assert (x / w, y / w) == pytest.approx((40 / 595, 120 / 842), abs=0.01)

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
