"""HTTP-контракт приёма задач: `POST /v1/jobs` и `GET /v1/jobs/{message_id}`."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient

from helpers import OBJECT_ID, PROCESS_ID, parse_envelope, store, submit, wait_for_job
from inspector_ml.api.app import create_app
from inspector_ml.config import Settings
from inspector_ml.ingest.pdf import parse_pdf
from inspector_ml.storage.cache import ParsedCache
from inspector_ml.storage.files import sha256_of

MATRIX_PARAM = {
    "id": 2,
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
    "is_active": True,
    "created_at": "2026-09-18T10:00:00Z",
    "updated_at": "2026-09-18T10:00:00Z",
}


def compare_envelope(files: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "message_id": str(uuid4()),
        "type": "ml.compare.request",
        "schema_version": "0.4.0",
        "correlation_id": PROCESS_ID,
        "reply_to": None,
        "attempt": 1,
        "created_at": "2026-09-19T08:00:00Z",
        "payload": {
            "process_id": PROCESS_ID,
            "object_id": OBJECT_ID,
            "protocol_version": 1,
            "mode": "FULL",
            "matrix": {"version": "1.1", "params": [MATRIX_PARAM]},
            "files": files,
            "versions": {"dataset_version": "none", "model_version": None},
        },
    }


def test_rejects_non_json(client: TestClient) -> None:
    response = client.post("/v1/jobs", content="не json".encode(), headers={"content-type": "application/json"})

    assert response.status_code == 400


def test_rejects_envelope_without_required_fields(client: TestClient) -> None:
    response = client.post("/v1/jobs", json={"type": "ml.parse.request"})

    assert response.status_code == 400
    assert "errors" in response.json()


def test_rejects_result_type(client: TestClient) -> None:
    """ml принимает только запросы: результат ему слать незачем."""
    envelope = parse_envelope("0" * 64, "raw/x")
    envelope["type"] = "ml.parse.result"

    response = client.post("/v1/jobs", json=envelope)

    assert response.status_code == 400


def test_unknown_job_is_404(client: TestClient) -> None:
    assert client.get(f"/v1/jobs/{uuid4()}").status_code == 404


def test_accepts_job_and_reports_state(client: TestClient, settings: Settings, make_pdf: Callable[..., Path]) -> None:
    sha, key = store(settings, make_pdf())
    envelope = parse_envelope(sha, key)

    accepted = client.post("/v1/jobs", json=envelope)

    assert accepted.status_code == 202
    body = accepted.json()
    assert body["message_id"] == envelope["message_id"]
    assert body["state"] in {"QUEUED", "RUNNING", "DONE"}
    assert wait_for_job(client, envelope["message_id"])["state"] == "DONE"


def test_internal_token_required_when_configured(tmp_path: Path, make_pdf: Callable[..., Path]) -> None:
    settings = Settings(
        _env_file=None,
        storage_dir=tmp_path / "storage",
        cache_dir=tmp_path / "cache",
        ml_workers=1,
        ml_executor="thread",
        internal_token="secret",
    )
    sha, key = store(settings, make_pdf())
    envelope = parse_envelope(sha, key)

    with TestClient(create_app(settings)) as client:
        assert client.post("/v1/jobs", json=envelope).status_code == 401
        assert (
            client.get(f"/v1/jobs/{envelope['message_id']}", headers={"x-internal-token": "wrong"}).status_code == 401
        )

        accepted = client.post("/v1/jobs", json=envelope, headers={"x-internal-token": "secret"})
        assert accepted.status_code == 202


def test_compare_job_runs_engine(client: TestClient, settings: Settings, make_pdf: Callable[..., Path]) -> None:
    """Сравнение доходит до движка: без извлечения значений параметр честно без доказательств."""
    path = make_pdf("ПЗ.pdf")
    sha = sha256_of(path)
    parsed = parse_pdf(path, sha, settings.parser_version)
    key = ParsedCache(settings.storage_dir, settings.cache_dir).put(sha, settings.parser_version, parsed)

    envelope = compare_envelope(
        [
            {
                "file_id": str(uuid4()),
                "sha256": sha,
                "original_name": "ПЗ.pdf",
                "parsed_ref": {"bucket": "local", "key": key},
                "metadata": {"doc_stage": "PD", "discipline": "ПЗ", "document_code": "П-2025-04.266-ПЗ"},
                "in_registry": True,
                "metadata_source": "MANIFEST",
                "uploaded_at": "2026-09-19T08:00:00Z",
            }
        ]
    )

    submit(client, envelope)
    state = wait_for_job(client, envelope["message_id"])

    assert state["state"] == "DONE"
    result = state["result"]
    assert result["type"] == "ml.compare.result"

    payload = result["payload"]
    assert payload["status"] == "OK"
    assert payload["checks"], "движок должен вернуть хотя бы один результат по активному параметру"
    statuses = {check["finding_status"] for check in payload["checks"]}
    assert "CONFIRMED_VIOLATION" not in statuses  # REQ-CMP-05: этот статус ставит только инспектор
    assert payload["versions"]["input_manifest_hash"]
