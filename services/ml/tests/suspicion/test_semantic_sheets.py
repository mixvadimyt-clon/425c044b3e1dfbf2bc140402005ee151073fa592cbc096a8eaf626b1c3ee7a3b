"""Свободный поиск по листам-чертежам (27.09): план ПД ↔ план РД по общим номерам помещений.

Случай из публичного эталона (FREE-HEATING-001): на листе отопления ПД у помещений 267–272 есть тёплый пол,
на листе РД — нет. Подписи лежат в текстовом слое чертежа, а текстовые разделы чертежи не берут.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from inspector_ml.config import Settings
from inspector_ml.contracts.events import DocumentMetadata
from inspector_ml.extract.api import LoadedDocument
from inspector_ml.suspicion import semantic

PD_PLAN = "1 этаж 267 Игровая 270 Спальня 271 Туалет 272 Раздевальная Т1 Т2 тёплый пол ТП-1 267 270 271 272"
RD_PLAN = "1 этаж 267 Игровая 270 Спальня 271 Туалет 272 Раздевальная Т1 Т2 радиатор отопления РСВ-1"
OTHER_PLAN = "3 этаж 331 Читальный зал 332 Кабинет 333 Кабинет Т1 Т2 радиатор отопления"


def sheet(stage: str, *texts: str, code: str = "ИОС5.4") -> LoadedDocument:
    pages = [
        {
            "page": n,
            "source": "TEXT_LAYER",
            "quality": "OK",
            "is_drawing": True,
            "blocks": [{"type": "text", "text": text, "bbox": [0.1, 0.1, 0.9, 0.9]}],
        }
        for n, text in enumerate(texts, start=99)
    ]
    return LoadedDocument(
        file_id=uuid4(),
        sha256="b" * 64,
        metadata=DocumentMetadata.model_validate(
            {"doc_stage": stage, "discipline": "ИОС" if stage == "PD" else "ОВ", "document_code": code}
        ),
        parsed={"pages": pages},
    )


class FakeModel:
    def __init__(self, answer: dict[str, Any] | None) -> None:
        self.answer = answer
        self.asked: list[str] = []

    def ask_json(self, system: str, user: str) -> dict[str, Any] | None:
        self.asked.append(user)
        return self.answer


ANSWER = {
    "hypotheses": [
        {
            "subject": "Помещение 267",
            "pd_quote": "Т1 Т2 тёплый пол ТП-1",
            "rd_quote": "радиатор отопления РСВ-1",
            "description": "В ПД у помещения 267 тёплый пол, в РД вместо него радиатор.",
            "priority": "HIGH",
        }
    ]
}


def run(monkeypatch, docs, answer=ANSWER) -> tuple[list, FakeModel]:
    model = FakeModel(answer)
    monkeypatch.setattr(semantic.LlmClient, "from_settings", classmethod(lambda cls, s: model))
    return semantic.run(docs, Settings(_env_file=None, llm_enabled=True), object_id="obj-1"), model


class TestSheetPairs:
    def test_plans_of_the_same_rooms_are_paired_across_disciplines(self) -> None:
        pd, rd = sheet("PD", OTHER_PLAN, PD_PLAN), sheet("RD", RD_PLAN, code="ОВ2.1")

        pairs = semantic.sheet_pairs([pd, rd])

        assert len(pairs) == 1
        (_, pd_page), (_, rd_page) = pairs[0]
        assert pd_page["page"] == 100  # лист с помещениями 267–272, а не читальный зал
        assert rd_page["page"] == 99

    def test_identical_sheets_are_not_compared(self) -> None:
        assert semantic.sheet_pairs([sheet("PD", PD_PLAN), sheet("RD", PD_PLAN)]) == []

    def test_pd_sheet_without_equipment_is_ignored(self) -> None:
        plain = "1 этаж 267 Игровая 270 Спальня 271 Туалет 272 Раздевальная"
        assert semantic.sheet_pairs([sheet("PD", plain), sheet("RD", RD_PLAN)]) == []

    def test_rd_explication_without_equipment_is_enough(self) -> None:
        """Как в эталоне: план отопления РД — линии без текста, помещения есть только в экспликации РД."""
        explication = (
            "Экспликация помещений 1 этажа 267 Игровая 48,2 270 Спальня 50,1 271 Туалет 8,4 272 Раздевальная 18,0"
        )
        pairs = semantic.sheet_pairs([sheet("PD", PD_PLAN), sheet("RD", explication)])
        assert len(pairs) == 1

    def test_rd_sheet_with_equipment_wins(self) -> None:
        explication = "Экспликация помещений 1 этажа 267 Игровая 270 Спальня 271 Туалет 272 Раздевальная"
        pd, rd = sheet("PD", PD_PLAN), sheet("RD", explication, RD_PLAN)
        (_, _), (_, rd_page) = semantic.sheet_pairs([pd, rd])[0]
        assert rd_page["page"] == 100  # план с подписями отопления, а не экспликация

    def test_too_few_shared_rooms(self) -> None:
        rd = "1 этаж 267 Игровая 501 Холл 502 Холл радиатор отопления"
        assert semantic.sheet_pairs([sheet("PD", PD_PLAN), sheet("RD", rd)]) == []


class TestSheetHypothesis:
    def test_grounded_hypothesis_from_the_drawing(self, monkeypatch) -> None:
        found, model = run(monkeypatch, [sheet("PD", PD_PLAN), sheet("RD", RD_PLAN, code="ОВ2.1")])

        assert len(found) == 1
        assert "267" in found[0].description
        pd_evidence = next(e for e in found[0].evidence if e.stage.root == "PD")
        assert pd_evidence.page == 99  # доказательство — на самом листе-чертеже
        assert "тёплый пол" in model.asked[0] and "радиатор" in model.asked[0]

    def test_paraphrased_quote_is_anchored_to_the_room_label(self, monkeypatch) -> None:
        """Подписи на чертеже рваные, модель цитату пересказывает — доказательство берётся с подписи помещения."""
        answer = {"hypotheses": [{**ANSWER["hypotheses"][0], "pd_quote": "в помещении 267 устроен тёплый пол"}]}
        found, _ = run(monkeypatch, [sheet("PD", PD_PLAN), sheet("RD", RD_PLAN)], answer)

        assert len(found) == 1
        pd_evidence = next(e for e in found[0].evidence if e.stage.root == "PD")
        assert "267" in pd_evidence.text_snippet

    def test_room_far_from_any_device_is_not_anchored(self, monkeypatch) -> None:
        """Помещение есть на листе, но прибора рядом нет — привязывать цитату не к чему, гипотеза отсеивается."""
        pd = sheet("PD", PD_PLAN)
        pd.parsed["pages"][0]["blocks"].append(
            {"type": "text", "text": "301 Актовый зал", "bbox": [0.85, 0.9, 0.95, 0.95]}
        )
        pd.parsed["pages"][0]["blocks"][0]["bbox"] = [0.05, 0.05, 0.3, 0.3]
        answer = {
            "hypotheses": [{**ANSWER["hypotheses"][0], "subject": "Помещение 301", "pd_quote": "в зале 301 прибор"}]
        }
        found, _ = run(monkeypatch, [pd, sheet("RD", RD_PLAN + " 301 Актовый зал")], answer)

        assert found == []

    def test_invented_room_drops_the_hypothesis(self, monkeypatch) -> None:
        answer = {"hypotheses": [{**ANSWER["hypotheses"][0], "subject": "Помещение 999"}]}
        found, _ = run(monkeypatch, [sheet("PD", PD_PLAN), sheet("RD", RD_PLAN)], answer)
        assert found == []
