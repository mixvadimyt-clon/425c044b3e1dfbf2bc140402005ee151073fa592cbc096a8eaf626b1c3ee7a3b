"""FastAPI-приложение ML-сервиса.

Эндпоинты по контракту ``contracts/events/ml-events.v1.yaml``: ``GET /health``,
``POST /v1/jobs`` (приём задачи, ответ ``202``), ``GET /v1/jobs/{message_id}`` (состояние)
и ``GET /metrics`` для Prometheus. Сама работа идёт в очереди (``jobs/runner.py``),
результат уходит на ``reply_to``.
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from pydantic import BaseModel, Field, ValidationError

from inspector_ml import __version__
from inspector_ml.capabilities import detect_capabilities, service_status
from inspector_ml.config import Settings, get_settings
from inspector_ml.contracts.events import Envelope
from inspector_ml.jobs.runner import JobRunner
from inspector_ml.logging import configure_logging, get_logger, request_context
from inspector_ml.metrics import BUILD_INFO, HTTP_REQUEST_DURATION, HTTP_REQUESTS

REQUEST_ID_HEADER = "x-request-id"
INTERNAL_TOKEN_HEADER = "x-internal-token"

log = get_logger(__name__)


class HealthResponse(BaseModel):
    """Ответ ``GET /health`` по контракту ``contracts/events/ml-events.v1.yaml``."""

    status: str = Field(description="ok — базовый конвейер доступен, degraded — нет")
    version: str
    capabilities: dict[str, bool] = Field(description="Доступные компоненты: pdf, cv, ocr, docling, embeddings, llm")


def _route_path(request: Request) -> str:
    """Шаблон маршрута для метки метрики (чтобы не плодить лишние значения)."""
    route = request.scope.get("route")
    return getattr(route, "path", None) or "unmatched"


def create_app(settings: Settings | None = None, *, runner: JobRunner | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)
    BUILD_INFO.labels(
        version=__version__,
        parser_version=settings.parser_version,
        model_version=settings.model_version,
    ).set(1)

    job_runner = runner if runner is not None else JobRunner(settings)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        await job_runner.start()
        try:
            yield
        finally:
            await job_runner.stop()

    app = FastAPI(
        title="Инспектор ИИ — ML-сервис",
        version=__version__,
        description="Парсинг документов, извлечение параметров матрицы и доказательства с bbox",
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.runner = job_runner

    @app.middleware("http")
    async def observability(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        request_id = request.headers.get(REQUEST_ID_HEADER) or str(uuid4())
        started = time.perf_counter()
        with request_context(request_id):
            response = await call_next(request)
            duration = time.perf_counter() - started
            path = _route_path(request)
            HTTP_REQUESTS.labels(method=request.method, path=path, status=str(response.status_code)).inc()
            HTTP_REQUEST_DURATION.labels(method=request.method, path=path).observe(duration)
            response.headers[REQUEST_ID_HEADER] = request_id
            log.info(
                "http_request",
                method=request.method,
                path=path,
                status=response.status_code,
                duration_ms=round(duration * 1000, 1),
            )
            return response

    @app.get("/health", response_model=HealthResponse, summary="Проверка живости ML-сервиса")
    async def health() -> HealthResponse:
        capabilities = detect_capabilities(settings)
        return HealthResponse(status=service_status(capabilities), version=__version__, capabilities=capabilities)

    @app.get("/metrics", summary="Метрики Prometheus", include_in_schema=False)
    async def metrics() -> Response:
        return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)

    def _token_error(request: Request) -> JSONResponse | None:
        """Если у ml задан INTERNAL_TOKEN, api обязан присылать его в заголовке."""
        if not settings.internal_token:
            return None
        if request.headers.get(INTERNAL_TOKEN_HEADER) == settings.internal_token:
            return None
        return JSONResponse({"detail": "Неверный internal token"}, status_code=401)

    @app.post("/v1/jobs", status_code=202, summary="Поставить задачу разбора или сравнения")
    async def submit_job(request: Request) -> Response:
        denied = _token_error(request)
        if denied is not None:
            return denied

        try:
            body: Any = await request.json()
            envelope = Envelope.model_validate(body)
        except ValidationError as exc:
            # контракт требует 400 на некорректное сообщение, а не 422 по умолчанию FastAPI
            return JSONResponse({"detail": "Некорректный Envelope", "errors": exc.errors()}, status_code=400)
        except ValueError:
            return JSONResponse({"detail": "Тело запроса — не JSON"}, status_code=400)

        if envelope.type.root not in {"ml.parse.request", "ml.compare.request"}:
            return JSONResponse({"detail": f"ml не принимает сообщения типа {envelope.type.root}"}, status_code=400)

        state = job_runner.submit(envelope.model_dump(mode="json"))
        return JSONResponse(state, status_code=202)

    @app.get("/v1/jobs/{message_id}", summary="Состояние задачи")
    async def job_state(message_id: str, request: Request) -> Response:
        denied = _token_error(request)
        if denied is not None:
            return denied

        state = job_runner.state(message_id)
        if state is None:
            return JSONResponse({"detail": "Нет такой задачи"}, status_code=404)
        return JSONResponse(state)

    return app


app = create_app()
