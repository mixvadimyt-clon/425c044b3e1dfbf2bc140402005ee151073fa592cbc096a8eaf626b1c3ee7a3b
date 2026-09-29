"""Логические гипотезы на извлечённых значениях.

Проверяем главное свойство: гипотеза рождается, только когда условие достоверно выполнено,
а ожидание достоверно нарушено. На неполных или противоречивых данных правило молчит.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest

from inspector_ml import contracts

if not contracts.is_generated():  # pragma: no cover — CI всегда выполняет uv run gen
    pytest.skip("сначала выполните uv run gen", allow_module_level=True)

from inspector_ml.compare.keys import suspicion_key
from inspector_ml.contracts.events import EvidenceFragment, LogicalRule, PagePairResult
from inspector_ml.suspicion.rules import logical

OBJECT_ID = "6f1c1c9e-6c38-4d7e-9c1a-2f0f4b0b7a01"
FILE_IDS = {stage: f"00000000-0000-4000-8000-{n:012d}" for n, stage in enumerate(("PD", "RD", "ID"), 1)}
PRESENT_IN_RD = {
    "id": "11111111-1111-4111-8111-111111111111",
    "rule_name": "Элемент из ПД есть в РД",
    "condition": "exists(M-055.PD)",
    "expected": "exists(M-055.RD)",
    "review_priority": "HIGH",
}
SAME_AREA = {
    "id": "22222222-2222-4222-8222-222222222222",
    "rule_name": "Площадь в РД равна площади в ПД",
    "condition": "exists(M-002.PD) and exists(M-002.RD)",
    "expected": "M-002.RD == M-002.PD",
    "review_priority": "MEDIUM",
    "normative_base": "СП 54.13330.2022",
}


@dataclass(frozen=True)
class FakeExtraction:
    param_code: str
    stage: str
    file_id: str
    rule_key: str | None
    raw_value: str
    value: float | str | bool | None
    unit: str | None
    fragment: EvidenceFragment


def ex(code: str, stage: str, raw: str, value: Any, *, rule_key: str | None = None, page: int = 4) -> FakeExtraction:
    file_id = FILE_IDS[stage]
    fragment = EvidenceFragment.model_validate(
        {
            "role": "CONTEXT",
            "file_id": file_id,
            "sha256": "0" * 64,
            "stage": stage,
            "page": page,
            "bbox": [0.1, 0.2, 0.3, 0.25],
            "extracted_value": raw,
            "normalized_value": str(value),
            "quality": "OK",
            "confidence": 0.9,
        }
    )
    return FakeExtraction(code, stage, file_id, rule_key, raw, value, None, fragment)


def rules(*raw: dict[str, Any]) -> list[logical.CompiledRule]:
    compiled, broken = logical.compile_rules([LogicalRule.model_validate(r) for r in raw])
    assert broken == []
    return compiled


def run(compiled: list[logical.CompiledRule], *items: FakeExtraction, pairs: list[PagePairResult] | None = None):
    values: dict[str, list[FakeExtraction]] = {}
    for item in items:
        values.setdefault(item.param_code, []).append(item)
    return logical.run(
        compiled,
        values,
        lambda x: x.stage,
        lambda x: f"документ {x.stage}, стр. {x.fragment.page}",
        OBJECT_ID,
        pairs or [],
    )


def test_element_present_in_pd_but_missing_in_rd() -> None:
    [found] = run(rules(PRESENT_IN_RD), ex("M-055", "PD", "B30", "B30"))
    assert found.discovery_method.root == "LOGICAL_ANALYSIS"
    assert found.rule_id == PRESENT_IN_RD["id"]
    assert found.review_priority.root == "HIGH"
    assert "Элемент из ПД есть в РД" in found.description
    assert found.description.endswith("Значения: ПД M-055: B30.")
    assert (found.pd_reference, found.rd_reference, found.id_reference) == ("документ PD, стр. 4", None, None)
    assert [f.stage.root for f in found.evidence] == ["PD"]
    assert found.confidence == 0.9
    assert found.suspicion_key == suspicion_key(OBJECT_ID, PRESENT_IN_RD["id"], None)


def test_element_present_in_both_stages_gives_no_suspicion() -> None:
    assert run(rules(PRESENT_IN_RD), ex("M-055", "PD", "B30", "B30"), ex("M-055", "RD", "B30", "B30")) == []


def test_value_mismatch_between_stages() -> None:
    [found] = run(rules(SAME_AREA), ex("M-002", "PD", "3 009,4", 3009.4), ex("M-002", "RD", "3 030,0", 3030.0))
    assert found.normative_base == "СП 54.13330.2022"
    assert "условие «exists(M-002.PD) and exists(M-002.RD)» выполнено" in found.description
    assert "Значения: ПД M-002: 3 009,4; РД M-002: 3 030,0." in found.description
    assert (found.pd_reference, found.rd_reference) == ("документ PD, стр. 4", "документ RD, стр. 4")
    assert [f.stage.root for f in found.evidence] == ["PD", "RD"]


def test_matching_values_give_no_suspicion() -> None:
    assert run(rules(SAME_AREA), ex("M-002", "PD", "3 009,4", 3009.4), ex("M-002", "RD", "3 009,40", 3009.4)) == []


def test_rule_is_checked_per_checkpoint() -> None:
    """Совпала одна комната, разошлась другая — гипотеза ровно по второй."""
    found = run(
        rules(SAME_AREA),
        ex("M-002", "PD", "18,6", 18.6, rule_key="пом. 1.09"),
        ex("M-002", "RD", "18,6", 18.6, rule_key="Помещение 1-09"),
        ex("M-002", "PD", "24,1", 24.1, rule_key="пом. 1.10"),
        ex("M-002", "RD", "30,0", 30.0, rule_key="пом. 1.10"),
    )
    assert len(found) == 1
    assert found[0].description.startswith("Точка «пом. 1.10».")
    assert found[0].suspicion_key == suspicion_key(OBJECT_ID, SAME_AREA["id"], "пом. 1.10")


def test_two_different_values_in_one_stage_keep_the_rule_silent() -> None:
    """Расхождение редакций внутри стадии разбирает движок сравнения, а не гипотеза."""
    found = run(
        rules(SAME_AREA),
        ex("M-002", "PD", "3 009,4", 3009.4),
        ex("M-002", "PD", "3 100,0", 3100.0),
        ex("M-002", "RD", "3 030,0", 3030.0),
    )
    assert found == []


def test_broken_rule_is_skipped_and_the_rest_still_work() -> None:
    broken_rule = {**PRESENT_IN_RD, "id": "33333333-3333-4333-8333-333333333333", "condition": "M-055.PD +"}
    compiled, broken = logical.compile_rules([LogicalRule.model_validate(r) for r in (broken_rule, SAME_AREA)])
    assert [name for name, _ in broken] == ["Элемент из ПД есть в РД"]
    assert [r.rule.rule_name for r in compiled] == ["Площадь в РД равна площади в ПД"]


def test_inactive_rule_is_not_compiled() -> None:
    compiled, broken = logical.compile_rules([LogicalRule.model_validate({**SAME_AREA, "is_active": False})])
    assert (compiled, broken) == ([], [])


def test_referenced_params_cover_both_expressions() -> None:
    assert logical.referenced_params(rules(PRESENT_IN_RD, SAME_AREA)) == {"M-055", "M-002"}


def test_page_pair_key_links_matched_sheets() -> None:
    pd, rd = ex("M-002", "PD", "3 009,4", 3009.4), ex("M-002", "RD", "3 030,0", 3030.0)
    pair = PagePairResult.model_validate(
        {
            "pair_key": "pp-4",
            "left": {"file_id": pd.file_id, "page": 4},
            "right": {"file_id": rd.file_id, "page": 4},
            "match_score": 0.9,
            "diff_regions": [],
        }
    )
    [found] = run(rules(SAME_AREA), pd, rd, pairs=[pair])
    assert found.page_pair_key == "pp-4"


def test_rule_without_priority_gets_the_default() -> None:
    """Приоритет у правила необязателен по контракту, а у гипотезы обязателен."""
    plain_rule = {k: v for k, v in SAME_AREA.items() if k != "review_priority"}
    [found] = run(rules(plain_rule), ex("M-002", "PD", "3 009,4", 3009.4), ex("M-002", "RD", "3 030,0", 3030.0))
    assert found.review_priority.root == logical.DEFAULT_PRIORITY
