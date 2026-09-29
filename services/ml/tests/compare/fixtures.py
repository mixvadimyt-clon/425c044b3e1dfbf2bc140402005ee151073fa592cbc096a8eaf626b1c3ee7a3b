"""Сборщики ``CompareRequest`` для тестов движка, которым не нужно извлечение значений.

Тесты с фейковыми ``Extraction`` живут в ``test_engine.py`` и собирают запрос своими помощниками:
там нужен ещё и фрагмент доказательства. Здесь — минимум для модулей, которые смотрят только на
состав комплекта и матрицу (``applicability``, ``incremental``).
"""

from __future__ import annotations

import hashlib
from typing import Any

from inspector_ml.contracts.events import CompareRequest, MatrixParam

PROCESS_ID = "0b6e7f52-1d8e-4a8b-9d55-3a2f1f0c9e10"
OBJECT_ID = "6f1c1c9e-6c38-4d7e-9c1a-2f0f4b0b7a01"


def file(n: int, doc_stage: str | None, name: str, **metadata: Any) -> dict[str, Any]:
    return {
        "file_id": f"00000000-0000-4000-8000-{n:012d}",
        "sha256": hashlib.sha256(name.encode()).hexdigest(),
        "original_name": name,
        "parsed_ref": {"bucket": "inspector", "key": f"parsed/{n}.json"},
        "metadata": {"doc_stage": doc_stage, "approval_status": "APPROVED", **metadata},
        "uploaded_at": "2026-09-18T10:00:00Z",
    }


def param(code: str, section: str, **fields: Any) -> MatrixParam:
    return MatrixParam.model_validate(
        {
            "id": 1,
            "created_at": "2026-09-18T10:00:00Z",
            "updated_at": "2026-09-18T10:00:00Z",
            "code": code,
            "section": section,
            "parameter_name": "Проверяемый параметр",
            "data_type": "number",
            "review_priority": "HIGH",
            **fields,
        }
    )


def request(
    files: list[dict[str, Any]],
    expected: list[dict[str, Any]] | None = None,
    params: list[MatrixParam] | None = None,
    **extra: Any,
) -> CompareRequest:
    return CompareRequest.model_validate(
        {
            "process_id": PROCESS_ID,
            "object_id": OBJECT_ID,
            "protocol_version": 1,
            "mode": "FULL",
            "matrix": {"version": "m-0.1", "params": [p.model_dump(mode="json") for p in params or []]},
            "files": files,
            "expected_documents": expected or [],
            "versions": {"dataset_version": "none"},
            **extra,
        }
    )
