"""Гипотезы модели прикладываются к результату сравнения, не мешая правилам.

Подключение живёт в `jobs/handlers.py`, а не в движке сравнения.
Отсюда и проверки: правила считаются всегда, гипотезы добавляются сверху, а при выключенной
или упавшей модели протокол остаётся ровно таким же, каким был бы без неё.
"""

from __future__ import annotations

import pytest
from test_semantic import GOOD, PD_TEXT, RD_TEXT, FakeModel, document

from inspector_ml.config import Settings
from inspector_ml.contracts.events import CompareRequest, CompareResult
from inspector_ml.jobs.handlers import _with_hypotheses
from inspector_ml.suspicion import semantic

PROCESS_ID = "0b6e7f52-1d8e-4a8b-9d55-3a2f1f0c9e10"
OBJECT_ID = "6f1c1c9e-6c38-4d7e-9c1a-2f0f4b0b7a01"

RULE_HYPOTHESIS = {
    "suspicion_key": "b" * 40,
    "discovery_method": "LOGICAL_ANALYSIS",
    "confidence": 1.0,
    "description": "Правило сработало",
    "review_priority": "HIGH",
}


def result(*suspicions: dict, status: str = "OK") -> CompareResult:
    return CompareResult.model_validate(
        {
            "process_id": PROCESS_ID,
            "protocol_version": 1,
            "status": status,
            "checks": [],
            "suspicions": list(suspicions),
        }
    )


@pytest.fixture
def docs():
    return [document("PD", PD_TEXT), document("RD", RD_TEXT)]


@pytest.fixture
def request_() -> CompareRequest:
    return CompareRequest.model_validate(
        {
            "process_id": PROCESS_ID,
            "object_id": OBJECT_ID,
            "protocol_version": 1,
            "mode": "FULL",
            "matrix": {"version": "m-0.1", "params": []},
            "files": [],
            "versions": {"dataset_version": "none"},
        }
    )


def on(enabled: bool = True) -> Settings:
    return Settings(_env_file=None, llm_enabled=enabled)


class TestHypothesesAreAddedNotSubstituted:
    def test_rule_hypotheses_stay(self, monkeypatch, docs, request_) -> None:
        monkeypatch.setattr(semantic, "run", lambda *a, **k: [])

        after = _with_hypotheses(result(RULE_HYPOTHESIS), docs, on(), request_, [])

        assert [s.discovery_method.root for s in after.suspicions or []] == ["LOGICAL_ANALYSIS"]

    def test_model_hypotheses_come_after_the_rules(self, monkeypatch, docs, request_) -> None:
        monkeypatch.setattr(semantic.LlmClient, "from_settings", classmethod(lambda cls, s: FakeModel(GOOD)))

        after = _with_hypotheses(result(RULE_HYPOTHESIS), docs, on(), request_, [])

        assert [s.discovery_method.root for s in after.suspicions or []] == [
            "LOGICAL_ANALYSIS",
            "SEMANTIC_DISSONANCE",
        ]


class TestModelCannotSpoilTheProtocol:
    def test_disabled_model_changes_nothing(self, docs, request_) -> None:
        before = result(RULE_HYPOTHESIS)

        assert _with_hypotheses(before, docs, on(False), request_, []) is before

    def test_failed_compare_is_left_alone(self, monkeypatch, docs, request_) -> None:
        """У проваленного сравнения гипотез быть не может — искать не в чем."""
        monkeypatch.setattr(semantic, "run", lambda *a, **k: [])
        before = result(status="FAILED")

        assert _with_hypotheses(before, docs, on(), request_, []) is before

    def test_exception_inside_the_model_does_not_escape(self, monkeypatch, docs, request_) -> None:
        def boom(*args, **kwargs):
            raise MemoryError("видеопамять кончилась")

        monkeypatch.setattr(semantic, "run", boom)
        before = result(RULE_HYPOTHESIS)

        assert _with_hypotheses(before, docs, on(), request_, []) is before
