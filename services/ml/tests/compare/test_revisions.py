"""Актуальная редакция внутри документа — те же правила, что у api (stages.ts::ambiguousRevisions)."""

from __future__ import annotations

from typing import Any

import pytest

from inspector_ml import contracts

if not contracts.is_generated():  # pragma: no cover — CI всегда выполняет uv run gen
    pytest.skip("сначала выполните uv run gen", allow_module_level=True)

from test_engine import PD, cfile, compare, ex, make_request, status

from inspector_ml.compare.revisions import resolve


def kj(n: int, name: str, approval: str, **extra: Any) -> dict[str, Any]:
    """Файл РД КЖ01 одного шифра — разные редакции одного документа."""
    code = extra.pop("document_code", "П-2025-04-266-КЖ01")
    return cfile(n, "RD", name, discipline="КЖ", document_code=code, approval_status=approval, **extra)


def roles(result: Any) -> dict[str, tuple[str, str]]:
    return {str(r.file_id): (r.role, r.reason) for r in result.file_resolution}


def test_predecessor_chain_leaves_only_the_newest_revision() -> None:
    old = kj(20, "КЖ01 изм. 0.pdf", "APPROVED")
    new = kj(21, "КЖ01 изм. 1.pdf", "APPROVED")
    new["predecessor_id"] = old["file_id"]
    values = [ex("M-055", PD, "B30", "B30"), ex("M-055", new, "B25", "B25")]
    result, extractor = compare(make_request([PD, old, new]), values)
    assert extractor.calls == [("M-055", [PD["file_id"], new["file_id"]])]
    assert roles(result)[old["file_id"]] == ("SUPERSEDED", "Заменена редакцией «КЖ01 изм. 1.pdf»")
    assert status(result.checks[0]) == ("CANDIDATE", "COMPLETE")


def test_successor_link_on_the_old_file_works_the_same() -> None:
    old = kj(22, "КЖ01 старый.pdf", "UNKNOWN")
    new = kj(23, "КЖ01 новый.pdf", "UNKNOWN")
    old["successor_id"] = new["file_id"]
    values = [ex("M-055", PD, "B30", "B30"), ex("M-055", new, "B30", "B30")]
    result, extractor = compare(make_request([PD, old, new]), values)
    assert extractor.calls == [("M-055", [PD["file_id"], new["file_id"]])]
    assert roles(result)[old["file_id"]][0] == "SUPERSEDED"


def test_single_approved_revision_wins_over_drafts() -> None:
    draft = kj(24, "КЖ01 черновик.pdf", "DRAFT")
    approved = kj(25, "КЖ01 в производство.pdf", "FOR_CONSTRUCTION", document_code="П-2025-04-266 КЖ01")
    values = [ex("M-055", PD, "B30", "B30"), ex("M-055", draft, "B20", "B20"), ex("M-055", approved, "B30", "B30")]
    result, _ = compare(make_request([PD, draft, approved]), values)
    # шифры «…-КЖ01» и «… КЖ01» — один документ (нормализация как в api)
    assert roles(result)[draft["file_id"]] == (
        "SUPERSEDED",
        "Утверждена редакция «КЖ01 в производство.pdf» (FOR_CONSTRUCTION), у этой статус DRAFT",
    )
    assert status(result.checks[0]) == ("NEGATIVE_VERIFIED", "COMPLETE")


def test_ambiguous_revisions_block_the_verdict_until_inspector_chooses() -> None:
    a = kj(26, "КЖ01 от 11.11.pdf", "APPROVED")
    b = kj(27, "КЖ01 от 02.12.pdf", "APPROVED")
    values = [ex("M-055", PD, "B30", "B30"), ex("M-055", a, "B25", "B25"), ex("M-055", b, "B30", "B30")]
    result, extractor = compare(make_request([PD, a, b]), values)
    # извлечение идёт по обеим — доказательства видны инспектору
    assert extractor.calls == [("M-055", [PD["file_id"], a["file_id"], b["file_id"]])]
    [check] = result.checks
    assert status(check) == ("CLARIFICATION_REQUIRED", "CLARIFICATION_REQUIRED")
    assert check.rationale == (
        "Вывод о нарушении заблокирован: несколько редакций «П-2025-04-266-КЖ01» (РД) без однозначного выбора "
        "(КЖ01 от 11.11.pdf, КЖ01 от 02.12.pdf), выберите авторитетную редакцию"
    )
    assert [f.stage.root for f in check.fragments] == ["PD", "RD", "RD"]
    assert roles(result)[a["file_id"]][0] == "CONFLICT"


def test_inspector_choice_resolves_the_conflict() -> None:
    a = kj(28, "КЖ01 от 11.11.pdf", "APPROVED", is_authoritative=True)
    b = kj(29, "КЖ01 от 02.12.pdf", "APPROVED")
    values = [ex("M-055", PD, "B30", "B30"), ex("M-055", a, "B25", "B25"), ex("M-055", b, "B30", "B30")]
    result, _ = compare(make_request([PD, a, b]), values)
    assert roles(result)[b["file_id"]] == (
        "SUPERSEDED",
        "Инспектор выбрал редакцию «КЖ01 от 11.11.pdf», у этой статус APPROVED",
    )
    assert roles(result)[a["file_id"]] == ("ACTUAL", "Актуальная редакция: выбрана инспектором")
    assert status(result.checks[0]) == ("CANDIDATE", "COMPLETE")


def test_conflict_in_another_document_does_not_block_this_parameter() -> None:
    a = kj(30, "АР изм. 0.pdf", "APPROVED", document_code="П-2025-04-266-АР")
    b = kj(31, "АР изм. 1.pdf", "APPROVED", document_code="П-2025-04-266-АР")
    rd = kj(32, "КЖ01.pdf", "APPROVED")
    result, _ = compare(make_request([PD, a, b, rd]), [ex("M-055", PD, "B30", "B30"), ex("M-055", rd, "B25", "B25")])
    assert status(result.checks[0]) == ("CANDIDATE", "COMPLETE")
    assert {roles(result)[a["file_id"]][0], roles(result)[b["file_id"]][0]} == {"CONFLICT"}


def test_files_without_code_or_of_different_stages_are_not_grouped() -> None:
    no_code = cfile(33, "RD", "без шифра 1.pdf", approval_status="APPROVED")
    no_code2 = cfile(34, "RD", "без шифра 2.pdf", approval_status="APPROVED")
    pd_same = cfile(35, "PD", "КЖ01 в ПД.pdf", document_code="П-2025-04-266-КЖ01", approval_status="APPROVED")
    rd_same = kj(36, "КЖ01.pdf", "APPROVED")
    request = make_request([no_code, no_code2, pd_same, rd_same])
    revisions = resolve(request.files, request.files)
    assert revisions.superseded == {}
    assert revisions.conflicts == {}
