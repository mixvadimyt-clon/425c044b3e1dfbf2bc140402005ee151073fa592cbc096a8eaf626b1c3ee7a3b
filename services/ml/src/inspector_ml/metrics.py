"""Метрики Prometheus. Экспортируются в ``GET /metrics``."""

from __future__ import annotations

from prometheus_client import Counter, Gauge, Histogram

HTTP_REQUESTS = Counter(
    "ml_http_requests_total",
    "Количество HTTP-запросов к ML-сервису",
    labelnames=("method", "path", "status"),
)

HTTP_REQUEST_DURATION = Histogram(
    "ml_http_request_duration_seconds",
    "Длительность обработки HTTP-запроса",
    labelnames=("method", "path"),
)

BUILD_INFO = Gauge(
    "ml_build_info",
    "Версия сервиса и парсера (значение всегда 1)",
    labelnames=("version", "parser_version", "model_version"),
)

JOBS = Counter(
    "ml_jobs_total",
    "Задачи парсинга и сравнения по итогу выполнения",
    labelnames=("type", "outcome"),
)

JOB_DURATION = Histogram(
    "ml_job_duration_seconds",
    "Длительность выполнения задачи",
    labelnames=("type",),
    buckets=(0.5, 1, 5, 15, 60, 180, 600, 1800),
)

JOBS_QUEUED = Gauge(
    "ml_jobs_queued",
    "Задачи, ожидающие выполнения",
)

CALLBACKS = Counter(
    "ml_callbacks_total",
    "Отправка результата на reply_to",
    labelnames=("outcome",),
)
