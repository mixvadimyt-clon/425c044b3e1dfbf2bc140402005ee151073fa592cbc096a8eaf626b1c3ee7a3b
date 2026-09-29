"""Свободный поиск ПД ↔ РД моделью: что доходит до протокола, а что отсеивается.

Модель здесь поддельная — она отвечает заранее заданным словарём. Проверяем не качество
формулировок, а то, ради чего языковую модель вообще брали под контроль: **гипотеза с выдуманным числом
или несуществующей цитатой в протокол не попадает**, а прогон не падает ни при какой ошибке.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from inspector_ml.config import Settings
from inspector_ml.contracts.events import DocumentMetadata
from inspector_ml.extract.api import LoadedDocument
from inspector_ml.suspicion import semantic

PD_TEXT = "В помещении 1.09 предусмотрен отопительный прибор — радиатор стальной, 45,2 м2"
RD_TEXT = "Помещение 1.09 — отопительные приборы не предусмотрены"


def settings() -> Settings:
    return Settings(_env_file=None, llm_enabled=True)


def document(stage: str, text: str, *, discipline: str = "ОВ", code: str = "ИОС4") -> LoadedDocument:
    return LoadedDocument(
        file_id=uuid4(),
        sha256="a" * 64,
        metadata=DocumentMetadata.model_validate(
            {"doc_stage": stage, "discipline": discipline, "document_code": code, "approval_status": "APPROVED"}
        ),
        parsed={
            "pages": [
                {
                    "page": 2,
                    "source": "TEXT_LAYER",
                    "quality": "OK",
                    "is_drawing": False,
                    "blocks": [{"type": "text", "text": text, "bbox": [0.1, 0.2, 0.9, 0.26]}],
                }
            ]
        },
    )


class FakeModel:
    """Подделка `LlmClient`: отвечает тем, что ей положили, и считает вызовы."""

    def __init__(self, answer: dict[str, Any] | None) -> None:
        self.answer = answer
        self.calls = 0
        self.asked = ""

    def ask_json(self, system: str, user: str) -> dict[str, Any] | None:
        self.calls += 1
        self.asked = user
        return self.answer


def run(monkeypatch, answer: dict[str, Any] | None, docs=None) -> list:
    model = FakeModel(answer)
    monkeypatch.setattr(semantic.LlmClient, "from_settings", classmethod(lambda cls, s: model))
    pair = docs if docs is not None else [document("PD", PD_TEXT), document("RD", RD_TEXT)]
    return semantic.run(pair, settings(), object_id="obj-1")


GOOD = {
    "hypotheses": [
        {
            "subject": "Помещение 1.09",
            "pd_quote": "предусмотрен отопительный прибор",
            "rd_quote": "отопительные приборы не предусмотрены",
            "description": "В ПД для помещения 1.09 предусмотрен прибор отопления, в РД он снят.",
            "priority": "HIGH",
        }
    ]
}


class TestHypothesisReachesTheProtocol:
    def test_grounded_hypothesis_survives(self, monkeypatch) -> None:
        found = run(monkeypatch, GOOD)

        assert len(found) == 1
        assert found[0].discovery_method.root == "SEMANTIC_DISSONANCE"
        assert found[0].review_priority.root == "HIGH"
        assert "1.09" in found[0].description

    def test_both_stages_become_evidence(self, monkeypatch) -> None:
        found = run(monkeypatch, GOOD)
        roles = [f.role.root for f in found[0].evidence or []]

        assert roles == ["EXPECTED", "ACTUAL"]

    def test_evidence_carries_page_and_box(self, monkeypatch) -> None:
        """Без рамки инспектору не на что нажать — гипотеза была бы бесполезной."""
        fragment = (run(monkeypatch, GOOD)[0].evidence or [])[0]

        assert fragment.page == 2
        assert [round(v.root, 2) for v in fragment.bbox.root] == [0.1, 0.2, 0.9, 0.26]

    def test_confidence_stays_under_the_ceiling(self, monkeypatch) -> None:
        """Модель не калибрована: выдавать её уверенность за вероятность нельзя."""
        assert run(monkeypatch, GOOD)[0].confidence <= semantic.CEILING

    def test_key_is_stable_between_runs(self, monkeypatch) -> None:
        first = run(monkeypatch, GOOD)[0].suspicion_key
        second = run(monkeypatch, GOOD)[0].suspicion_key

        assert first == second

    def test_model_never_sets_a_rule(self, monkeypatch) -> None:
        assert run(monkeypatch, GOOD)[0].rule_id is None


class TestFabricationIsRejected:
    """Главное требование приёмки: выдумка не доходит до протокола (ADR-0008)."""

    def test_invented_number_drops_the_hypothesis(self, monkeypatch) -> None:
        answer = {
            "hypotheses": [
                {
                    **GOOD["hypotheses"][0],
                    "description": "В ПД площадь помещения 51,7 м2, в РД прибора нет.",
                }
            ]
        }

        assert run(monkeypatch, answer) == []

    def test_invented_room_number_drops_the_hypothesis(self, monkeypatch) -> None:
        answer = {"hypotheses": [{**GOOD["hypotheses"][0], "subject": "Помещение 2.14"}]}

        assert run(monkeypatch, answer) == []

    def test_quote_that_is_not_in_the_document(self, monkeypatch) -> None:
        answer = {"hypotheses": [{**GOOD["hypotheses"][0], "pd_quote": "предусмотрен кондиционер настенный"}]}

        assert run(monkeypatch, answer) == []

    def test_wrong_rd_quote_drops_it_too(self, monkeypatch) -> None:
        """Если модель сослалась на РД, ссылка должна быть настоящей."""
        answer = {"hypotheses": [{**GOOD["hypotheses"][0], "rd_quote": "демонтаж радиаторов по проекту"}]}

        assert run(monkeypatch, answer) == []

    def test_hypothesis_without_rd_quote_is_allowed(self, monkeypatch) -> None:
        """Отсутствие текста в РД — это и есть находка: доказывать нечем именно потому, что нет."""
        answer = {"hypotheses": [{k: v for k, v in GOOD["hypotheses"][0].items() if k != "rd_quote"}]}
        found = run(monkeypatch, answer)

        assert len(found) == 1
        assert len(found[0].evidence or []) == 1

    def test_empty_subject_or_description(self, monkeypatch) -> None:
        answer = {"hypotheses": [{**GOOD["hypotheses"][0], "description": ""}]}

        assert run(monkeypatch, answer) == []

    def test_unknown_priority_falls_back(self, monkeypatch) -> None:
        answer = {"hypotheses": [{**GOOD["hypotheses"][0], "priority": "КРИТИЧЕСКИЙ"}]}

        assert run(monkeypatch, answer)[0].review_priority.root == semantic.DEFAULT_PRIORITY


class TestModelCannotBreakTheRun:
    """Ни одна проверка не падает из-за языковой модели (ADR-0008, «деградация обязательна»)."""

    def test_model_is_off_by_default(self) -> None:
        docs = [document("PD", PD_TEXT), document("RD", RD_TEXT)]

        assert semantic.run(docs, Settings(_env_file=None), object_id="obj-1") == []

    def test_no_answer_gives_no_hypotheses(self, monkeypatch) -> None:
        assert run(monkeypatch, None) == []

    def test_garbage_shape_is_survived(self, monkeypatch) -> None:
        assert run(monkeypatch, {"result": "ничего не нашёл"}) == []

    def test_items_that_are_not_objects_are_skipped(self, monkeypatch) -> None:
        assert run(monkeypatch, {"hypotheses": ["помещение 1.09", None, 42]}) == []

    def test_too_many_hypotheses_are_cut(self, monkeypatch) -> None:
        """Модель охотно продолжает список, а инспектору его разбирать."""
        letters = "АБВГДЕЖЗИКЛМНОПРСТУФ"
        answer = {"hypotheses": [dict(GOOD["hypotheses"][0], subject=f"Помещение 1.09, прибор {c}") for c in letters]}
        found = run(monkeypatch, answer)

        assert len(found) == semantic.MAX_HYPOTHESES


class TestWhatGoesToTheModel:
    def test_only_matching_disciplines_are_compared(self, monkeypatch) -> None:
        """Сверять отопление с конструкциями бессмысленно."""
        docs = [document("PD", PD_TEXT, discipline="ОВ"), document("RD", RD_TEXT, discipline="КЖ")]

        assert run(monkeypatch, GOOD, docs) == []

    def test_documents_without_a_discipline_are_skipped(self, monkeypatch) -> None:
        docs = [document("PD", PD_TEXT, discipline=""), document("RD", RD_TEXT, discipline="")]

        assert run(monkeypatch, GOOD, docs) == []

    def test_both_stages_land_in_the_prompt(self, monkeypatch) -> None:
        model = FakeModel(GOOD)
        monkeypatch.setattr(semantic.LlmClient, "from_settings", classmethod(lambda cls, s: model))
        semantic.run([document("PD", PD_TEXT), document("RD", RD_TEXT)], settings(), object_id="obj-1")

        assert "### ПД" in model.asked
        assert "### РД" in model.asked
        assert "1.09" in model.asked

    def test_drawings_are_not_sent(self) -> None:
        doc = document("PD", PD_TEXT)
        doc.pages[0]["is_drawing"] = True

        assert semantic.excerpt(doc, 1000) == ""

    def test_excerpt_respects_the_budget(self) -> None:
        doc = document("PD", "длинная строка " * 500)

        assert len(semantic.excerpt(doc, 300)) <= 300
