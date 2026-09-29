"""Метрики компьютерного зрения против разметки (`eval cv`) — на маленькой выгрузке в tmp.

Выгрузка устроена как настоящая `РАЗМЕЧЕННЫЙ_TRAIN_PUBLIC_203/…/data`, кеш разбора — как
`STORAGE_DIR/parsed/<sha256>/<версия>.json`. Рамки организаторов — от нижнего края страницы.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from inspector_ml import matrix
from inspector_ml.cli import main
from inspector_ml.corpus.labels import SPLIT_DIRS, Split
from inspector_ml.eval.cv import (
    cache_loader,
    evaluate_cv,
    gold_boxes,
    iou,
    ocr_sample,
    page_metrics,
    stage_metrics,
    top_left,
)
from inspector_ml.eval.tracking import cv_run

VERSION = "0.4.0"


def block(text: str, bbox: list[float]) -> dict[str, Any]:
    return {"id": "b", "type": "text", "text": text, "bbox": bbox}


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")


@pytest.fixture
def dataset(tmp_path: Path) -> tuple[Path, Path]:
    """Корень датасета и STORAGE_DIR: два файла, ПД с отметкой нуля и акт ИД."""
    root, storage = tmp_path / "dataset", tmp_path / "storage"
    data = root / SPLIT_DIRS["TRAIN_PUBLIC"]
    zero = "За относительную отметку 0,000 принята абсолютная отметка 159,95 м."
    docs = {
        "a" * 64: [
            {"page": 1, "source": "TEXT_LAYER", "quality": "OK", "blocks": [block("Стадия П", [0.8, 0.9, 0.95, 0.95])]},
            {"page": 2, "source": "OCR", "quality": "LOW_QUALITY", "blocks": [block(zero, [0.1, 0.1, 0.9, 0.2])]},
        ],
        "b" * 64: [
            {"page": 1, "source": "OCR", "quality": "OK", "blocks": [block("АКТ освидетельствования", [0, 0, 1, 1])]}
        ],
    }
    for sha, pages in docs.items():
        target = storage / "parsed" / sha / f"{VERSION}.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps({"sha256": sha, "pages": pages}, ensure_ascii=False), encoding="utf-8")
    write_jsonl(
        data / "files_index.jsonl",
        [
            {"file_id": "F1", "stage": "PD", "source_sha256": "a" * 64, "source_relative_path": "obj/Стадия П/ПЗ.pdf"},
            {
                "file_id": "F2",
                "stage": "RD_ID_MIXED",
                "source_sha256": "b" * 64,
                "source_relative_path": "obj/АОСР №1.pdf",
            },
        ],
    )
    write_jsonl(
        data / "page_index.jsonl",
        [
            {"file_id": "F1", "source_page_number": 1, "needs_ocr": False, "text_source": "PDF_TEXT_LAYER"},
            {"file_id": "F1", "source_page_number": 2, "needs_ocr": True, "text_source": "NO_TEXT_LAYER"},
            {"file_id": "F2", "source_page_number": 1, "needs_ocr": False, "text_source": "PDF_TEXT_LAYER"},
        ],
    )
    write_jsonl(
        data / "public_gold_checks.jsonl",
        [
            {
                "parameter_code": "PZ-009",
                "location": "Отметка 0.000",
                "evidence": [{"stage": "PD", "file_id": "F1", "pdf_page_number": 2}],
            }
        ],
    )
    # рамка «159,95» в пунктах от нижнего края страницы 600×800: сверху это y ≈ 0.15
    write_jsonl(
        data / "annotations.jsonl",
        [
            {
                "annotation_id": "A1",
                "file_id": "F1",
                "page_number": 2,
                "annotation_type": "SECOND_REVIEW_CHECK",
                "code": "PZ-009",
                "location": "Отметка 0.000",
                "location_precision": "TEXT_EXACT",
                "page_width": 600,
                "page_height": 800,
                "boxes_pdf": [[300, 670, 360, 690]],
                "bbox_normalized": [0.5, 0.8375, 0.6, 0.8625],
            }
        ],
    )
    return root, storage


@pytest.fixture
def params() -> dict:
    return matrix.load_params()


def test_report_on_small_dataset(dataset: tuple[Path, Path], params: dict) -> None:
    root, storage = dataset
    report = evaluate_cv(Split(root, "TRAIN_PUBLIC"), cache_loader(storage, VERSION), params)

    assert report["files_in_cache"] == 2
    pages = report["pages"]
    assert pages["confusion"] == {"tp": 1, "fp": 1, "fn": 0, "tn": 1}  # скан F2 ушёл в OCR, а по разметке не нужен
    assert pages["by_text_source"]["NO_TEXT_LAYER"]["recall"] == 1.0
    assert report["stage"]["accuracy"] == 1.0  # ПД по штампу, акт — ИД, а «RD_ID_MIXED» принимает ИД
    assert report["localization"]["page"] == {"evidence": 1, "hits": 1, "accuracy": 1.0}
    assert report["localization"]["bbox"]["center_inside"] == 1.0


def test_hidden_split_is_refused(dataset: tuple[Path, Path], params: dict) -> None:
    root, storage = dataset
    with pytest.raises(ValueError, match="скрытую TEST не открываем"):
        evaluate_cv(Split(root, "TEST_HIDDEN"), cache_loader(storage, VERSION), params)


class TestGeometry:
    def test_organizer_boxes_are_bottom_up(self) -> None:
        assert top_left([0.1, 0.8, 0.3, 0.9]) == pytest.approx([0.1, 0.1, 0.3, 0.2])

    def test_each_box_of_a_multi_value_annotation(self) -> None:
        note = {"page_width": 100, "page_height": 200, "boxes_pdf": [[10, 180, 20, 190], [50, 20, 60, 40]]}

        assert gold_boxes(note) == [pytest.approx([0.1, 0.05, 0.2, 0.1]), pytest.approx([0.5, 0.8, 0.6, 0.9])]

    def test_iou(self) -> None:
        assert iou([0, 0, 1, 1], [0, 0, 1, 1]) == 1.0
        assert iou([0, 0, 1, 1], [0.5, 0, 1.5, 1]) == pytest.approx(1 / 3)
        assert iou([0, 0, 1, 1], [2, 2, 3, 3]) == 0.0


def test_page_metrics_skip_files_outside_cache() -> None:
    labels = [{"file_id": "нет", "source_page_number": 1, "needs_ocr": True, "text_source": "NO_TEXT_LAYER"}]

    assert page_metrics(labels, {"нет": None})["pages"] == 0


def test_unknown_stage_is_skipped() -> None:
    files = [{"file_id": "F", "stage": "UNKNOWN", "source_relative_path": "x.pdf"}]

    assert stage_metrics(files, {"F": {"pages": []}})["files"] == 0


def test_ocr_sample_is_stable_and_uses_text_layer_only() -> None:
    labels = [
        {"file_id": f"F{i}", "source_page_number": p, "needs_ocr": p == 3, "text_source": "PDF_TEXT_LAYER"}
        for i in range(5)
        for p in range(1, 4)
    ]
    first, second = ocr_sample(labels, 6), ocr_sample(list(reversed(labels)), 6)

    assert first == second  # порядок входа не важен: выборка по хешу
    assert all(page != 3 for _, page in first)  # страницы, которым нужен OCR, эталоном не служат


def test_ocr_sample_skips_broken_text_layer() -> None:
    """Разметка считает слой годным, а наш классификатор отправил страницу в OCR — эталоном она не служит."""
    labels = [
        {"file_id": "F1", "source_page_number": p, "needs_ocr": False, "text_source": "PDF_TEXT_LAYER"} for p in (1, 2)
    ]
    good = [{"text": "Общество с ограниченной ответственностью"}]
    parsed = {
        "F1": {
            "pages": [
                {"source": "TEXT_LAYER", "quality": "OK", "blocks": good},
                {"source": "OCR", "quality": "OK", "blocks": good},
            ]
        }
    }

    assert ocr_sample(labels, 10, parsed) == [("F1", 1)]


@pytest.mark.parametrize(
    ("text", "valid"),
    [
        ("Общество с ограниченной ответственностью «БратКом-групп»", True),
        ("Бетон B40 W6 F150, арматура A500C по ГОСТ 34028-2016", True),  # латинские марки не мешают
        ("D545?L=O5 (<<=<<4?L=O5 < (<?<) <4>E<<4?L=O5) D47<5DO", False),  # мусор вместо кириллицы
        ("Ɉ5M5EF6> E >7D4=<G5==>= >F65FEF65==>EFLN", False),
        ("Заказчик: Заказчик: Заказчик: Заказчик: ООО ООО ООО ООО", False),  # слой напечатан поверх себя
        ("", False),
    ],
)
def test_reference_validity(text: str, valid: bool) -> None:
    from inspector_ml.eval.cv import reference_is_valid

    assert reference_is_valid(text) is valid


def test_mlflow_run() -> None:
    report = {
        "split": "TRAIN_PUBLIC",
        "pages": {"accuracy": 0.95, "precision": 0.85, "recall": 0.99, "f1": 0.92, "pages": 10},
        "stage": {"accuracy": 0.88, "macro_f1": 0.87, "files": 5, "per_stage": {"PD": {"f1": 0.9}}},
        "localization": {"page": {"accuracy": 0.9}, "bbox": {"iou_ge_05": 0.1, "center_inside": 0.8}},
    }
    run = cv_run(report)

    assert run.metrics["pages.f1"] == 0.92
    assert run.metrics["stage.PD.f1"] == 0.9
    assert run.metrics["localization.center_inside"] == 0.8
    assert "accuracy 0.9500" in run.tags["mlflow.note.content"]


def test_command(dataset: tuple[Path, Path], capsys: pytest.CaptureFixture[str]) -> None:
    root, storage = dataset
    code = main(["eval", "cv", str(root), "--storage", str(storage), "--parser-version", VERSION])

    assert code == 0
    report = json.loads(capsys.readouterr().out)
    assert report["stage"]["files"] == 2
