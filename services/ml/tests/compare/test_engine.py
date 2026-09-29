"""Движок сравнения на фейковых извлечениях: дерево статусов, эталон — ПД, выбор файлов, сценарий."""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import pytest

from inspector_ml import contracts

if not contracts.is_generated():  # pragma: no cover — CI всегда выполняет uv run gen
    pytest.skip("сначала выполните uv run gen", allow_module_level=True)

from inspector_ml.compare.engine import run
from inspector_ml.compare.keys import finding_key
from inspector_ml.contracts.events import CompareRequest, EvidenceFragment, PagePairResult

OBJECT_ID = "6f1c1c9e-6c38-4d7e-9c1a-2f0f4b0b7a01"
PROCESS_ID = "0b6e7f52-1d8e-4a8b-9d55-3a2f1f0c9e10"

M055 = {
    "code": "M-055",
    "section": "КР",
    "parameter_name": "Класс прочности бетона монолитных конструкций",
    "unit": "Марка (B)",
    "source_pd": "Общие данные; Спецификация материалов (КР)",
    "source_rd": "Общие указания; Спецификация элементов (КЖ)",
    "source_id": "Журнал бетонных работ",
    "trigger_logic": "Понижение класса бетона несущих элементов",
    "review_priority": "HIGH",
    "data_type": "enum",
    "enum_values": ["B20", "B25", "B30", "B35"],
}
M002 = {
    "code": "M-002",
    "section": "ПЗ",
    "parameter_name": "Общая площадь здания",
    "unit": "м²",
    "source_pd": "Раздел ПЗ: Таблица ТЭП",
    "source_rd": "Раздел АР: Сводная экспликация",
    "source_id": None,
    "trigger_logic": "Дельта общей площади между ПД и РД (или ИД) > 1%.",
    "review_priority": "HIGH",
    "data_type": "number",
}


def _param(base: dict[str, Any], i: int) -> dict[str, Any]:
    return {"id": i, "created_at": "2026-09-18T10:00:00Z", "updated_at": "2026-09-18T10:00:00Z", **base}


def cfile(n: int, stage: str | None, name: str, **metadata: Any) -> dict[str, Any]:
    authoritative = metadata.pop("is_authoritative", None)
    return {
        "file_id": f"00000000-0000-4000-8000-{n:012d}",
        "sha256": hashlib.sha256(name.encode()).hexdigest(),
        "original_name": name,
        "parsed_ref": {"bucket": "inspector", "key": f"parsed/{n}.json"},
        "metadata": {"doc_stage": stage, "approval_status": metadata.pop("approval_status", "APPROVED"), **metadata},
        "is_authoritative": authoritative,
        "uploaded_at": "2026-09-18T10:00:00Z",
    }


def make_request(
    files: list[dict[str, Any]], params: Sequence[dict[str, Any]] = (M055,), **extra: Any
) -> CompareRequest:
    return CompareRequest.model_validate(
        {
            "process_id": PROCESS_ID,
            "object_id": OBJECT_ID,
            "protocol_version": 1,
            "mode": "FULL",
            "matrix": {"version": "m-0.1", "params": [_param(p, i) for i, p in enumerate(params, 1)]},
            "files": files,
            "versions": {"dataset_version": "none"},
            **extra,
        }
    )


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


def ex(
    param_code: str, file: dict[str, Any], raw: str, value: Any, *, rule_key: str | None = None, quality: str = "OK"
) -> FakeExtraction:
    fragment = EvidenceFragment.model_validate(
        {
            "role": "CONTEXT",
            "file_id": file["file_id"],
            "sha256": file["sha256"],
            "stage": file["metadata"]["doc_stage"],
            "page": 4,
            "bbox": [0.1, 0.2, 0.3, 0.25],
            "extracted_value": raw,
            "normalized_value": str(value),
            "quality": quality,
            "confidence": 0.9,
        }
    )
    stage = file["metadata"]["doc_stage"]
    return FakeExtraction(param_code, stage, file["file_id"], rule_key, raw, value, None, fragment)


class Extractor:
    """Фейковое извлечение: возвращает заранее заданные значения только для переданных документов."""

    def __init__(self, values: list[FakeExtraction]) -> None:
        self.values = values
        self.calls: list[tuple[str, list[str]]] = []

    def __call__(self, param: Any, docs: Sequence[Any]) -> list[FakeExtraction]:
        ids = [str(d.file_id) for d in docs]
        self.calls.append((param.code, ids))
        return [v for v in self.values if v.param_code == param.code and v.file_id in ids]


def compare(request: CompareRequest, values: list[FakeExtraction]):
    extractor = Extractor(values)
    result = run(request, request.files, extractor)
    return result, extractor


def status(check: Any) -> tuple[str, str]:
    return check.finding_status, check.completeness_status.root


PD = cfile(1, "PD", "4. П-2025-04-266-КР.pdf", discipline="КР", document_code="П-2025-04-266-КР")
RD = cfile(2, "RD", "П-2025-04-266-КЖ01.pdf", discipline="КЖ", document_code="П-2025-04-266-КЖ01")


def test_candidate_when_rd_lowers_concrete_class() -> None:
    result, _ = compare(make_request([PD, RD]), [ex("M-055", PD, "В30", "B30"), ex("M-055", RD, "В25", "B25")])
    [check] = result.checks
    assert status(check) == ("CANDIDATE", "COMPLETE")
    assert (check.expected_value, check.actual_value, check.delta) == ("B30", "B25", "понижение на 1 ступ.")
    assert [s.root for s in check.stages_compared] == ["PD", "RD"]
    assert [(f.role.root, f.stage.root) for f in check.fragments] == [("EXPECTED", "PD"), ("ACTUAL", "RD")]
    # тот же ключ, что строит api (stub.ts): sha1(object_id|param_code|rule_key)
    assert check.finding_key == hashlib.sha1(f"{OBJECT_ID}|M-055|".encode()).hexdigest()
    assert check.finding_key == finding_key(OBJECT_ID, "M-055", None)
    assert result.status.root == "OK"
    assert result.scenario.root == "PD_RD_ONLY"
    # в CheckResult не бывает решений инспектора и гипотез — это гарантирует схема контракта
    assert check.finding_status not in {"CONFIRMED_VIOLATION", "SUSPICION"}


def test_negative_verified_when_values_match() -> None:
    result, _ = compare(make_request([PD, RD]), [ex("M-055", PD, "B30", "B30"), ex("M-055", RD, "В30", "B30")])
    [check] = result.checks
    assert status(check) == ("NEGATIVE_VERIFIED", "COMPLETE")
    assert check.delta is None


def test_missing_evidence_without_rd_documents() -> None:
    result, extractor = compare(make_request([PD]), [ex("M-055", PD, "B30", "B30")])
    [check] = result.checks
    assert status(check) == ("MISSING_EVIDENCE", "MISSING_EVIDENCE")
    assert any(s.startswith("РД: нет документов") for s in check.missing_sources)
    # без реестра состав не подтверждён — стадия не «загружена полностью»
    assert [s.root for s in result.upload_status] == ["PD_PARTIAL", "RD_MISSING", "ID_MISSING"]
    assert result.scenario.root == "SINGLE_ONLY"
    assert extractor.calls == [("M-055", [PD["file_id"]])]


def test_low_quality_page_is_never_a_candidate() -> None:
    values = [ex("M-055", PD, "B30", "B30"), ex("M-055", RD, "B25", "B25", quality="LOW_QUALITY")]
    [check] = compare(make_request([PD, RD]), values)[0].checks
    assert status(check) == ("NOT_COMPARABLE", "NOT_COMPARABLE")
    assert "качество" in check.rationale


def test_value_not_found_is_not_comparable_and_stage_partial() -> None:
    result, _ = compare(make_request([PD, RD]), [ex("M-055", PD, "B30", "B30")])
    [check] = result.checks
    assert status(check) == ("NOT_COMPARABLE", "NOT_COMPARABLE")
    assert [s.root for s in result.upload_status] == ["PD_PARTIAL", "RD_PARTIAL", "ID_MISSING"]


def test_conflicting_reference_values_require_clarification() -> None:
    pd2 = cfile(3, "PD", "4. П-2025-04-266-КР изм.pdf", discipline="КР")
    values = [ex("M-055", PD, "B30", "B30"), ex("M-055", pd2, "B35", "B35"), ex("M-055", RD, "B30", "B30")]
    [check] = compare(make_request([PD, pd2, RD]), values)[0].checks
    assert status(check) == ("CLARIFICATION_REQUIRED", "CLARIFICATION_REQUIRED")
    assert "B30, B35" in check.rationale


def test_rule_keys_are_separate_checkpoints() -> None:
    pz = cfile(4, "PD", "1. П-2025-04.266-ПЗ.pdf")
    ar = cfile(5, "RD", "РД-2025-04-266-АР2.pdf")
    values = [
        ex("M-002", pz, "3 009,4", 3009.4, rule_key="Общая площадь здания"),
        ex("M-002", ar, "3 009,4", 3009.4, rule_key="Общая площадь здания"),
        ex("M-002", pz, "18,6", 18.6, rule_key="пом. 1.09"),
        ex("M-002", ar, "24,1", 24.1, rule_key="пом. 1.09"),
        ex("M-002", pz, "Кладовая", "Кладовая", rule_key="пом. 1.09 (назначение)"),
        ex("M-002", ar, "Офис", "Офис", rule_key="пом. 1.09 (назначение)"),
    ]
    registry = [
        {"doc_stage": "PD", "file_name": pz["original_name"]},
        {"doc_stage": "RD", "file_name": ar["original_name"]},
    ]
    request = make_request([pz, ar], params=[M002], expected_documents=registry, registry_status="PRESENT")
    result, _ = compare(request, values)
    by_key = {c.rule_key: c for c in result.checks}
    assert status(by_key["Общая площадь здания"]) == ("NEGATIVE_VERIFIED", "COMPLETE")
    assert status(by_key["пом. 1.09"]) == ("CANDIDATE", "COMPLETE")
    assert by_key["пом. 1.09"].delta == "+5.5 (+29.57 %)"
    assert status(by_key["пом. 1.09 (назначение)"]) == ("CANDIDATE", "COMPLETE")
    assert len({c.finding_key for c in result.checks}) == 3
    # состав по реестру подтверждён; у M-002 нет источника в ИД — отсутствие ИД не делает комплект неполным
    assert [s.root for s in result.upload_status] == ["PD_UPLOADED", "RD_UPLOADED", "ID_MISSING"]


def test_superseded_and_excluded_files_do_not_reach_extraction() -> None:
    old = cfile(6, "RD", "КЖ01 старый.pdf", approval_status="SUPERSEDED")
    excluded = cfile(7, "RD", "КЖ01 копия.pdf")
    chosen = cfile(8, "RD", "КЖ01 выбранный.pdf", approval_status="SUPERSEDED", is_authoritative=True)
    request = make_request(
        [PD, old, excluded, chosen], excluded_files=[{"file_id": excluded["file_id"], "reason": "Заменена редакцией"}]
    )
    result, extractor = compare(request, [ex("M-055", PD, "B30", "B30"), ex("M-055", chosen, "B30", "B30")])
    assert extractor.calls == [("M-055", [PD["file_id"], chosen["file_id"]])]
    roles = {str(r.file_id): (r.role, r.reason) for r in result.file_resolution}
    assert roles[old["file_id"]] == ("SUPERSEDED", "Редакция заменена (SUPERSEDED)")
    assert roles[excluded["file_id"]] == ("SUPERSEDED", "Заменена редакцией")
    assert roles[chosen["file_id"]] == ("ACTUAL", "Актуальная редакция: выбрана инспектором")
    assert roles[PD["file_id"]] == (
        "ACTUAL",
        "Актуальная редакция: статус утверждения APPROVED (источник метаданных неизвестен)",
    )
    assert status(result.checks[0]) == ("NEGATIVE_VERIFIED", "COMPLETE")


def test_expected_document_gap_gives_partially_loaded() -> None:
    expected = [{"doc_stage": "RD", "document_code": "П-2025-04-266-КЖ02"}, {"doc_stage": "PD", "discipline": "КР"}]
    request = make_request([PD, RD], expected_documents=expected)
    result, _ = compare(request, [ex("M-055", PD, "B30", "B30"), ex("M-055", RD, "B30", "B30")])
    assert result.scenario.root == "PARTIALLY_LOADED"
    assert [s.root for s in result.upload_status] == ["PD_UPLOADED", "RD_PARTIAL", "ID_MISSING"]


def test_param_without_sources_is_not_applicable_and_inactive_params_are_skipped() -> None:
    no_sources = {**M055, "code": "M-099", "source_pd": None, "source_rd": "", "source_id": None}
    inactive = {**M055, "code": "M-100", "is_active": False}
    result, extractor = compare(make_request([PD, RD], params=[no_sources, inactive]), [])
    assert [(c.param_code, *status(c)) for c in result.checks] == [("M-099", "NOT_APPLICABLE", "NOT_APPLICABLE")]
    assert extractor.calls == []
    assert result.stats.params_evaluated == 1


def test_result_round_trips_through_contract_json() -> None:
    request = make_request([PD, RD, cfile(9, None, "без стадии.pdf")], mode="INCREMENTAL")
    result, _ = compare(request, [ex("M-055", PD, "B30", "B30"), ex("M-055", RD, "B25", "B25")])
    payload = result.model_dump(mode="json")
    again = type(result).model_validate(payload)
    assert again == result
    assert payload["affected_param_codes"] == ["M-055"]
    assert payload["versions"]["matrix_version"] == "m-0.1"
    assert (
        payload["versions"]["input_manifest_hash"]
        == hashlib.sha256(
            "\n".join(sorted(f["sha256"] for f in request.model_dump(mode="json")["files"])).encode()
        ).hexdigest()
    )
    unresolved = payload["file_resolution"][-1]
    assert (unresolved["file_id"], unresolved["role"]) == (cfile(9, None, "x")["file_id"], "UNRESOLVED")


def test_m002_small_delta_is_negative_and_rooms_match_across_labels() -> None:
    pz = cfile(4, "PD", "1. П-2025-04.266-ПЗ.pdf")
    ar = cfile(5, "RD", "РД-2025-04-266-АР2.pdf")
    values = [
        ex("M-002", pz, "3 009,4", 3009.4, rule_key="Общая площадь здания"),
        ex("M-002", ar, "3 030,0", 3030.0, rule_key="Общая площадь здания"),
        ex("M-002", pz, "18,6", 18.6, rule_key="пом. 1.09"),
        ex("M-002", ar, "24,1", 24.1, rule_key="Помещение 1-09"),
    ]
    result, _ = compare(make_request([pz, ar], params=[M002]), values)
    by_key = {c.rule_key: c for c in result.checks}
    assert set(by_key) == {"Общая площадь здания", "пом. 1.09"}  # подпись точки — как в ПД
    total = by_key["Общая площадь здания"]
    assert status(total) == ("NEGATIVE_VERIFIED", "COMPLETE")
    assert total.delta == "+20.6 (+0.68 %)"
    assert "не больше порога 1 %" in total.rationale
    room = by_key["пом. 1.09"]
    assert status(room) == ("CANDIDATE", "COMPLETE")
    assert room.rationale == (
        "ПД: 18,6; РД: 24,1. Отклонение 29.57 % больше порога 1 %. "
        "Триггер матрицы: «Дельта общей площади между ПД и РД (или ИД) > 1%.»"
    )
    assert room.finding_key == finding_key(OBJECT_ID, "M-002", "пом. 1.09")


def test_m055_raised_class_is_not_a_candidate() -> None:
    result, _ = compare(make_request([PD, RD]), [ex("M-055", PD, "В25", "В25"), ex("M-055", RD, "B30", "B30")])
    [check] = result.checks
    assert status(check) == ("NEGATIVE_VERIFIED", "COMPLETE")
    assert check.delta == "повышение на 1 ступ."
    assert check.rationale.endswith("триггер срабатывает только на понижение")


def test_limit_param_is_checked_without_reference_value() -> None:
    door = {
        **M002,
        "code": "M-041",
        "parameter_name": "Ширина эвакуационных выходов (дверей)",
        "unit": "м",
        "trigger_logic": "Ширина дверного полотна на путях эвакуации в РД/ИД < 0.9 м.",
        "sp_reference": "СП 1.13130.2020",
    }
    ar_pd = cfile(10, "PD", "АР ПД.pdf")
    ar_rd = cfile(11, "RD", "АР РД.pdf")
    values = [ex("M-041", ar_rd, "0,8", 0.8, rule_key="Д-1"), ex("M-041", ar_rd, "1,0", 1.0, rule_key="Д-2")]
    result, _ = compare(make_request([ar_pd, ar_rd], params=[door]), values)
    by_key = {c.rule_key: c for c in result.checks}
    assert status(by_key["Д-1"]) == ("CANDIDATE", "COMPLETE")
    assert by_key["Д-1"].rationale.startswith("РД: 0,8. 0.8 м меньше предела 0.9 м из матрицы")
    assert by_key["Д-1"].normative_reference == "СП 1.13130.2020"
    assert any(s.startswith("ПД: значение не найдено") for s in by_key["Д-1"].missing_sources)
    assert status(by_key["Д-2"]) == ("NEGATIVE_VERIFIED", "COMPLETE")


def test_unparsed_numeric_trigger_is_not_comparable() -> None:
    odd = {**M002, "code": "M-065", "trigger_logic": "Самовольная заделка крупных проемов в РД."}
    pz, ar = cfile(4, "PD", "ПЗ.pdf"), cfile(5, "RD", "АР.pdf")
    result, _ = compare(make_request([pz, ar], params=[odd]), [ex("M-065", pz, "4", 4), ex("M-065", ar, "3", 3)])
    [check] = result.checks
    assert status(check) == ("NOT_COMPARABLE", "NOT_COMPARABLE")
    assert check.rationale == (
        "Значения несопоставимы: ПД «4», РД «3». "
        "Причина: триггер матрицы не разобран: «Самовольная заделка крупных проемов в РД.»"
    )


# --- Применимость, сопоставление экземпляров, пара совмещённых листов ---


def pair(key: str, left: dict[str, Any], right: dict[str, Any], page: int, score: float) -> PagePairResult:
    return PagePairResult.model_validate(
        {
            "pair_key": key,
            "left": {"file_id": left["file_id"], "page": page},
            "right": {"file_id": right["file_id"], "page": page},
            "match_score": score,
            "diff_regions": [],
        }
    )


def test_param_of_absent_section_is_not_applicable_when_registry_is_known() -> None:
    pz = cfile(12, "PD", "1. П-2025-04.266-ПЗ.pdf", discipline="ПЗ")
    ar = cfile(13, "RD", "РД-2025-04-266-АР2.pdf", discipline="АР")
    registry = [
        {"doc_stage": "PD", "file_name": pz["original_name"]},
        {"doc_stage": "RD", "file_name": ar["original_name"]},
    ]
    request = make_request([pz, ar], expected_documents=registry, registry_status="PRESENT")
    result, extractor = compare(request, [])
    [check] = result.checks
    assert status(check) == ("NOT_APPLICABLE", "NOT_APPLICABLE")
    assert check.rationale.startswith("Раздел «КР» не представлен в комплекте и не ожидается по реестру")
    # неприменимый параметр не идёт в извлечение и не делает комплект неполным
    assert extractor.calls == []
    assert [s.root for s in result.upload_status] == ["PD_UPLOADED", "RD_UPLOADED", "ID_MISSING"]


def test_absent_section_without_registry_is_missing_evidence() -> None:
    """Без реестра отсутствие раздела КР означает неподтверждённую полноту, а не неприменимость."""
    pz = cfile(12, "PD", "1. П-2025-04.266-ПЗ.pdf", discipline="ПЗ")
    [check] = compare(make_request([pz]), [])[0].checks
    assert status(check) == ("MISSING_EVIDENCE", "MISSING_EVIDENCE")


def test_wording_difference_is_one_checkpoint() -> None:
    values = [
        ex("M-055", PD, "B35", "B35", rule_key="стены в грунте"),
        ex("M-055", RD, "B25", "B25", rule_key="стена в грунте"),
    ]
    [check] = compare(make_request([PD, RD]), values)[0].checks
    assert check.rule_key == "стены в грунте"  # подпись точки — как в эталоне (ПД)
    assert status(check) == ("CANDIDATE", "COMPLETE")
    assert [s.root for s in check.stages_compared] == ["PD", "RD"]


def test_neighbouring_rooms_are_not_merged() -> None:
    values = [
        ex("M-002", PD, "18,6", 18.6, rule_key="пом. 1.09"),
        ex("M-002", RD, "24,1", 24.1, rule_key="пом. 1.10"),
    ]
    result, _ = compare(make_request([PD, RD], params=[M002]), values)
    assert {c.rule_key for c in result.checks} == {"пом. 1.09", "пом. 1.10"}
    # у каждой точки нет пары в другой стадии — сравнивать не с чем
    assert {status(c) for c in result.checks} == {("NOT_COMPARABLE", "NOT_COMPARABLE")}


def test_stage_outside_the_rule_is_marked_not_applicable() -> None:
    """REQ-CMP-06: M-002 не проверяется в ИД, и загруженная ИД получает пометку неприменимости."""
    pz = cfile(14, "PD", "1. П-2025-04.266-ПЗ.pdf")
    ar = cfile(15, "RD", "РД-2025-04-266-АР2.pdf")
    akt = cfile(16, "ID", "АОСР №1.pdf")
    values = [ex("M-002", pz, "3 009,4", 3009.4), ex("M-002", ar, "3 009,4", 3009.4)]
    [check] = compare(make_request([pz, ar, akt], params=[M002]), values)[0].checks
    assert "ИД: параметр в этой стадии не проверяется (NOT_APPLICABLE)" in check.missing_sources
    assert [s.root for s in check.stages_compared] == ["PD", "RD"]


def test_page_pair_key_points_at_the_pair_covering_both_sheets() -> None:
    request = make_request([PD, RD])
    values = [ex("M-055", PD, "B35", "B35"), ex("M-055", RD, "B25", "B25")]
    pairs = [pair("pp-9", PD, RD, page=9, score=0.9), pair("pp-4", PD, RD, page=4, score=0.7)]
    [check] = run(request, request.files, Extractor(values), pairs).checks
    # доказательства лежат на странице 4 обоих документов — пара pp-4 покрывает обе стороны
    assert check.page_pair_key == "pp-4"


def test_page_pair_key_is_empty_when_evidence_is_on_other_sheets() -> None:
    request = make_request([PD, RD])
    values = [ex("M-055", PD, "B35", "B35"), ex("M-055", RD, "B25", "B25")]
    [check] = run(request, request.files, Extractor(values), [pair("pp-9", PD, RD, page=9, score=0.9)]).checks
    assert check.page_pair_key is None


# --- Инкрементальный пересчёт ---


def test_incremental_recalculates_only_the_touched_param() -> None:
    pz = cfile(17, "PD", "1. П-2025-04.266-ПЗ.pdf", discipline="ПЗ")
    ar = cfile(18, "RD", "РД-2025-04-266-АР2.pdf", discipline="АР")
    kr = cfile(19, "PD", "4. П-2025-04-266-КР.pdf", discipline="КР")
    kj = cfile(20, "RD", "П-2025-04-266-КЖ01.pdf", discipline="КЖ")
    values = [
        ex("M-002", pz, "3 009,4", 3009.4),
        ex("M-002", ar, "3 009,4", 3009.4),
        ex("M-055", kr, "B35", "B35"),
        ex("M-055", kj, "B25", "B25"),
    ]
    request = make_request([pz, ar, kr, kj], params=[M002, M055], mode="INCREMENTAL", changed_file_ids=[kj["file_id"]])
    result, extractor = compare(request, values)
    assert result.affected_param_codes == ["M-055"]
    assert [c.param_code for c in result.checks] == ["M-055"]
    assert status(result.checks[0]) == ("CANDIDATE", "COMPLETE")
    # площадь не пересчитывалась — её извлечение даже не вызывали
    assert [call[0] for call in extractor.calls] == ["M-055"]
    assert result.stats.params_evaluated == 1
    # при частичном пересчёте движок не судит о полноте по стадиям — api возьмёт свою оценку
    assert result.upload_status is None
    assert result.scenario.root == "PD_RD_ONLY"


def test_incremental_over_all_params_still_reports_upload_status() -> None:
    """Изменился файл без марки — пересчитаны все параметры, значит и полноту оценить можно."""
    scan = cfile(21, "RD", "скан.pdf")
    request = make_request([PD, RD, scan], mode="INCREMENTAL", changed_file_ids=[scan["file_id"]])
    result, _ = compare(request, [ex("M-055", PD, "B30", "B30"), ex("M-055", RD, "B30", "B30")])
    assert result.affected_param_codes == ["M-055"]
    assert [s.root for s in result.upload_status] == ["PD_PARTIAL", "RD_PARTIAL", "ID_MISSING"]


# --- Логические гипотезы ---

PRESENT_IN_RD = {
    "id": "11111111-1111-4111-8111-111111111111",
    "rule_name": "Класс бетона из ПД есть в РД",
    "condition": "exists(M-055.PD)",
    "expected": "exists(M-055.RD)",
    "review_priority": "HIGH",
}


def test_logical_rule_becomes_a_suspicion_in_the_result() -> None:
    request = make_request([PD, RD], logical_rules=[PRESENT_IN_RD])
    result, _ = compare(request, [ex("M-055", PD, "B30", "B30")])
    [suspicion] = result.suspicions
    assert suspicion.discovery_method.root == "LOGICAL_ANALYSIS"
    assert suspicion.rule_id == PRESENT_IN_RD["id"]
    assert suspicion.pd_reference == "П-2025-04-266-КР, стр. 4"
    assert suspicion.rd_reference is None
    # модель не ставит CONFIRMED_VIOLATION и не выдаёт гипотезу как нарушение
    assert [c.finding_status for c in result.checks] == ["NOT_COMPARABLE"]


def test_broken_rule_does_not_break_the_protocol() -> None:
    broken = {**PRESENT_IN_RD, "condition": "M-055.PD +"}
    result, _ = compare(make_request([PD, RD], logical_rules=[broken]), [ex("M-055", PD, "B30", "B30")])
    assert result.status.root == "OK"
    assert result.suspicions == []


def test_params_of_logical_rules_are_recalculated_even_incrementally() -> None:
    """Гипотезы api из прошлой версии не переносит, поэтому значения для правил нужны всегда."""
    pz = cfile(22, "PD", "1. П-2025-04.266-ПЗ.pdf", discipline="ПЗ")
    ar = cfile(23, "RD", "РД-2025-04-266-АР2.pdf", discipline="АР")
    kr = cfile(24, "PD", "4. П-2025-04-266-КР.pdf", discipline="КР")
    kj = cfile(25, "RD", "П-2025-04-266-КЖ01.pdf", discipline="КЖ")
    area_rule = {
        "id": "22222222-2222-4222-8222-222222222222",
        "rule_name": "Площадь в РД равна площади в ПД",
        "condition": "exists(M-002.PD) and exists(M-002.RD)",
        "expected": "M-002.RD == M-002.PD",
    }
    values = [
        ex("M-002", pz, "3 009,4", 3009.4),
        ex("M-002", ar, "3 030,0", 3030.0),
        ex("M-055", kr, "B35", "B35"),
        ex("M-055", kj, "B25", "B25"),
    ]
    request = make_request(
        [pz, ar, kr, kj],
        params=[M002, M055],
        mode="INCREMENTAL",
        changed_file_ids=[kj["file_id"]],
        logical_rules=[area_rule],
    )
    result, _ = compare(request, values)
    # без правила пересчитался бы только M-055 (см. test_incremental_recalculates_only_the_touched_param)
    assert result.affected_param_codes == ["M-002", "M-055"]
    assert [s.rule_id for s in result.suspicions] == [area_rule["id"]]


def test_conflicting_actual_values_require_clarification() -> None:
    """Несколько разных значений в РД — выбор источника за инспектором, а не за движком.

    Раньше из них бралось первое сработавшее, и параметр без ключа точки (общий разбор по матрице
    находит значения на разных листах) давал кандидата по первому же отличию. Правило эталона
    и правило фактических стадий теперь одинаковые. Нашлось на внешнем ревью 2026-09-20.
    """
    rd2 = cfile(4, "RD", "4. П-2025-04-266-КЖ2.pdf", discipline="КЖ")
    values = [
        ex("M-055", PD, "B30", "B30"),
        ex("M-055", RD, "B30", "B30"),
        ex("M-055", rd2, "B25", "B25"),
    ]
    [check] = compare(make_request([PD, RD, rd2]), values)[0].checks
    assert status(check) == ("CLARIFICATION_REQUIRED", "CLARIFICATION_REQUIRED")
    assert "B25, B30" in check.rationale
    assert "выбор источника" in check.rationale


def test_same_value_twice_in_one_stage_is_not_a_conflict() -> None:
    """Одно и то же значение на двух листах РД — не противоречие, сравнение идёт как обычно."""
    rd2 = cfile(5, "RD", "4. П-2025-04-266-КЖ2.pdf", discipline="КЖ")
    values = [
        ex("M-055", PD, "B30", "B30"),
        ex("M-055", RD, "B25", "B25"),
        ex("M-055", rd2, "B25", "B25"),
    ]
    [check] = compare(make_request([PD, RD, rd2]), values)[0].checks
    assert status(check) == ("CANDIDATE", "COMPLETE")


def test_value_is_taken_from_documents_of_the_param_section() -> None:
    """Одинаково названный показатель в документе другого раздела не мешает сравнению.

    «Класс энергетической эффективности» (ПЗ) и «…здания» (ЗУ): общий разбор по названию находит
    оба в любом документе. Без фильтра в ПД было бы два значения и «нужен выбор источника»; в ИД
    документов с маркой раздела нет — значение берётся из всех документов стадии.
    """
    energy = {
        **M002,
        "code": "M-021",
        "parameter_name": "Класс энергетической эффективности",
        "unit": "Буква",
        "source_rd": "Раздел ПЗ",
        "source_id": "Энергетический паспорт",
        "trigger_logic": "Снижение класса энергоэффективности в РД/ИД относительно ПД.",
        "data_type": "enum",
        "enum_values": ["C", "B", "A"],
    }
    pz_pd = cfile(20, "PD", "2026-КТ-П-ПЗ.pdf", discipline="ПЗ")
    zu_pd = cfile(21, "PD", "2026-КТ-П-ЗУ.pdf", discipline="ЗУ")
    pz_rd = cfile(22, "RD", "2026-КТ-РД-ПЗ.pdf", discipline="ПЗ")
    act = cfile(23, "ID", "Энергетический паспорт.pdf")
    values = [
        ex("M-021", pz_pd, "B", "B"),
        ex("M-021", zu_pd, "A", "A"),
        ex("M-021", pz_rd, "C", "C"),
        ex("M-021", act, "B", "B"),
    ]
    result, extractor = compare(make_request([pz_pd, zu_pd, pz_rd, act], params=[energy]), values)

    [check] = result.checks
    assert status(check) == ("CANDIDATE", "COMPLETE")
    assert check.expected_value == "B"
    [(_, docs)] = extractor.calls
    assert zu_pd["file_id"] not in docs
    assert act["file_id"] in docs


def test_text_values_differ_only_in_format_are_the_same() -> None:
    """Текстовый параметр: регистр, кавычки и пробелы не делают кандидата, другое значение — делает."""
    cable = {
        **M002,
        "code": "M-109",
        "section": "ППМ",
        "parameter_name": "Пожарная маркировка кабелей систем ПЗ (СПЗ)",
        "unit": None,
        "trigger_logic": "Применение кабеля без индекса огнестойкости (например, замена FRLS на LS).",
        "data_type": "string",
    }
    same = [ex("M-109", PD, "Кабель «нг(А)-FRLS»", "Кабель «нг(А)-FRLS»"),
            ex("M-109", RD, 'кабель  "нг(А)-FRLS".', 'кабель  "нг(А)-FRLS".')]  # fmt: skip
    [check] = compare(make_request([PD, RD], params=[cable]), same)[0].checks
    assert status(check) == ("NEGATIVE_VERIFIED", "COMPLETE")

    changed = [same[0], ex("M-109", RD, "Кабель нг(А)-LS", "Кабель нг(А)-LS")]
    [check] = compare(make_request([PD, RD], params=[cable]), changed)[0].checks
    assert status(check) == ("CANDIDATE", "COMPLETE")


def test_each_compared_stage_has_its_own_result() -> None:
    """РД в допуске, ИД за порогом: наружу по строке на стадию, а не одна пара значение/дельта."""
    act = cfile(30, "ID", "Технический план здания.pdf")
    values = [
        ex("M-002", PD, "7 850,0", 7850.0),
        ex("M-002", RD, "7 862,5", 7862.5),
        ex("M-002", act, "8 105,3", 8105.3),
    ]
    area = {**M002, "source_id": "Технический план БТИ"}
    [check] = compare(make_request([PD, RD, act], params=[area]), values)[0].checks
    assert status(check) == ("CANDIDATE", "COMPLETE")
    rows = [c.model_dump(mode="json") for c in check.stage_comparisons or []]
    assert [(r["stage"], r["value"], r["triggered"]) for r in rows] == [("RD", "7862.5", False), ("ID", "8105.3", True)]
    assert rows[0]["delta"] == "+12.5 (+0.16 %)"
    assert rows[1]["verdict"].startswith("Отклонение 3.25 % больше порога 1 %")
    assert check.actual_value == "8105.3"
