"""Пары листов идут в протокол только по актуальным редакциям.

Пары строит вызывающий по всем загруженным документам: отбор редакций живёт в движке
и случается позже. Значит без фильтра лист заменённой редакции попал бы в протокол, и инспектор
сверял бы неактуальный чертёж, ничего об этом не зная. Фильтруем в движке, а не надеемся
на дисциплину вызывающего.
"""

from __future__ import annotations

from typing import Any

import pytest

from inspector_ml import contracts

if not contracts.is_generated():  # pragma: no cover — CI всегда выполняет uv run gen
    pytest.skip("сначала выполните uv run gen", allow_module_level=True)

from test_engine import PD, cfile, make_request

from inspector_ml.compare.engine import run
from inspector_ml.compare.ports import Extractor
from inspector_ml.contracts.events import PagePairResult


def pair(key: str, left: dict[str, Any], right: dict[str, Any]) -> PagePairResult:
    return PagePairResult.model_validate(
        {
            "pair_key": key,
            "left": {"file_id": left["file_id"], "page": 1},
            "right": {"file_id": right["file_id"], "page": 1},
            "match_score": 0.9,
            "diff_regions": [],
        }
    )


class NoValues(Extractor):
    """Извлечение здесь не при чём: проверяем только отбор пар."""

    def __call__(self, *args: Any, **kwargs: Any) -> list[Any]:
        return []


def test_pair_with_superseded_revision_does_not_reach_the_protocol() -> None:
    new = cfile(21, "RD", "КЖ01 изм. 1.pdf", discipline="КЖ", document_code="П-2025-04-266-КЖ01")
    old = cfile(20, "RD", "КЖ01 изм. 0.pdf", discipline="КЖ", document_code="П-2025-04-266-КЖ01")
    old["successor_id"] = new["file_id"]  # связь редакций — на самом файле, не в метаданных
    request = make_request([PD, old, new])

    result = run(
        request,
        request.files,
        NoValues(),
        page_pairs=[pair("pd-new", PD, new), pair("pd-old", PD, old)],
    )

    assert [p.pair_key for p in result.page_pairs] == ["pd-new"]


def test_pairs_of_actual_revisions_are_kept_as_is() -> None:
    rd = cfile(22, "RD", "П-2025-04-266-КЖ01.pdf", discipline="КЖ", document_code="П-2025-04-266-КЖ01")
    request = make_request([PD, rd])

    result = run(request, request.files, NoValues(), page_pairs=[pair("pd-rd", PD, rd)])

    assert [p.pair_key for p in result.page_pairs] == ["pd-rd"]
