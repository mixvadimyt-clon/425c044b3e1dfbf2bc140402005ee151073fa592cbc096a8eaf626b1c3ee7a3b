"""Smoke-тесты HTTP-слоя: /health и /metrics."""

from __future__ import annotations

from fastapi.testclient import TestClient

from inspector_ml import __version__
from inspector_ml.api.app import REQUEST_ID_HEADER


def test_health_matches_contract(client: TestClient) -> None:
    """Ответ /health совпадает со схемой из contracts/events/ml-events.v1.yaml."""
    response = client.get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] in {"ok", "degraded"}
    assert body["version"] == __version__
    # Базовый путь конвейера — PyMuPDF и OpenCV, они в основных зависимостях
    assert body["capabilities"]["pdf"] is True
    assert body["capabilities"]["cv"] is True
    assert set(body["capabilities"]) >= {"pdf", "cv", "ocr", "docling", "embeddings", "llm"}
    assert all(isinstance(value, bool) for value in body["capabilities"].values())


def test_health_returns_request_id(client: TestClient) -> None:
    """Свой request_id генерируется, переданный клиентом — сохраняется (для сквозных логов)."""
    given = "11111111-1111-1111-1111-111111111111"

    generated = client.get("/health").headers[REQUEST_ID_HEADER]
    echoed = client.get("/health", headers={REQUEST_ID_HEADER: given}).headers[REQUEST_ID_HEADER]

    assert generated
    assert echoed == given


def test_metrics_exposes_prometheus_format(client: TestClient) -> None:
    """В /metrics есть версия сборки и счётчик запросов."""
    client.get("/health")
    response = client.get("/metrics")

    assert response.status_code == 200
    assert "text/plain" in response.headers["content-type"]
    assert "ml_build_info" in response.text
    assert 'ml_http_requests_total{method="GET",path="/health",status="200"}' in response.text
