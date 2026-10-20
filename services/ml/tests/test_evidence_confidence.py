"""Уверенность в доказательстве: не средняя по странице, а того текста, откуда взято значение."""

from __future__ import annotations

from typing import Any

from inspector_ml.contracts.events import DocumentMetadata
from inspector_ml.extract.api import LoadedDocument, _confidence, _covers, _fragment
from inspector_ml.extract.base import Found


def block(text: str, bbox: list[float], confidence: float | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"id": text, "type": "text", "text": text, "bbox": bbox}
    if confidence is not None:
        payload["confidence"] = confidence
    return payload


def scan(*blocks: dict[str, Any], mean: float = 0.88) -> dict[str, Any]:
    return {"page": 1, "source": "OCR", "quality": "OK", "ocr_confidence": mean, "blocks": list(blocks)}


class TestConfidence:
    def test_takes_the_block_under_the_evidence(self) -> None:
        """Страница распознана чисто, а нужное число — на 0.45. Показывать 0.88 нельзя."""
        page = scan(
            block("Наименование", [0.05, 0.10, 0.40, 0.14], 0.97),
            block("0,45", [0.55, 0.10, 0.70, 0.14], 0.45),
        )

        assert _confidence(page, [0.55, 0.10, 0.70, 0.14]) == 0.45

    def test_cell_is_no_better_than_its_worst_line(self) -> None:
        """Ячейка склеивается из нескольких строк OCR — берём минимум."""
        page = scan(
            block("Стена в", [0.05, 0.10, 0.20, 0.14], 0.91),
            block("грунте", [0.21, 0.10, 0.35, 0.14], 0.52),
        )

        assert _confidence(page, [0.05, 0.10, 0.35, 0.14]) == 0.52

    def test_falls_back_to_the_page_when_nothing_covers(self) -> None:
        page = scan(block("далеко", [0.80, 0.80, 0.90, 0.85], 0.99))

        assert _confidence(page, [0.05, 0.10, 0.20, 0.14]) == 0.88

    def test_text_layer_has_no_confidence(self) -> None:
        """У текстового слоя её нет и быть не должно — поведение не меняем."""
        page = {"page": 1, "source": "TEXT_LAYER", "quality": "OK", "blocks": [block("ТЭП", [0.1, 0.1, 0.3, 0.2])]}

        assert _confidence(page, [0.1, 0.1, 0.3, 0.2]) is None


class TestCovers:
    def test_touching_corner_is_not_enough(self) -> None:
        assert _covers([0.0, 0.0, 0.10, 0.10], [0.09, 0.09, 0.50, 0.50]) is False

    def test_block_inside_the_evidence_counts(self) -> None:
        assert _covers([0.10, 0.10, 0.40, 0.20], [0.10, 0.10, 0.45, 0.20]) is True

    def test_broken_bbox_is_ignored(self) -> None:
        assert _covers(None, [0.1, 0.1, 0.2, 0.2]) is False
        assert _covers([0.1, 0.1], [0.1, 0.1, 0.2, 0.2]) is False


class TestFragment:
    def test_evidence_carries_the_cell_confidence(self) -> None:
        """Сквозная проверка: значение со скана приносит уверенность своей строки."""
        page = scan(block("B25", [0.55, 0.10, 0.70, 0.14], 0.61))
        doc = LoadedDocument(
            file_id="11111111-1111-4111-8111-111111111111",
            sha256="a" * 64,
            metadata=DocumentMetadata.model_validate({"doc_stage": "ID", "approval_status": "APPROVED"}),
            parsed={"pages": [page]},
        )
        found = Found(
            rule_key="Стена в грунте",
            raw_value="В25",
            value="B25",
            page=1,
            bbox=[0.55, 0.10, 0.70, 0.14],
            snippet="В25",
        )

        fragment = _fragment(doc, found)

        assert fragment.confidence == 0.61
        assert fragment.source.root == "OCR"
