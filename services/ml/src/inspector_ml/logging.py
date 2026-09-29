"""Структурное логирование (JSON) — единый формат для всех сервисов.

Каждая запись содержит ``timestamp``, ``level``, ``service="ml"``, ``message`` и ``request_id``
(если он задан для текущего запроса или задачи). Сообщения сторонних библиотек (uvicorn)
проходят через тот же форматтер, поэтому в stdout всегда один JSON-поток — его можно
отдавать в ELK без дополнительной обработки.
"""

from __future__ import annotations

import logging
import sys
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from contextvars import ContextVar
from typing import Any

import structlog

_SERVICE_NAME = "ml"
_request_id: ContextVar[str | None] = ContextVar("request_id", default=None)


def set_request_id(request_id: str | None) -> None:
    """Задать идентификатор текущего запроса или задачи."""
    _request_id.set(request_id)


def get_request_id() -> str | None:
    return _request_id.get()


@contextmanager
def request_context(request_id: str | None) -> Iterator[None]:
    """Временно связать логи с ``request_id`` (запрос FastAPI или выполнение задачи)."""
    token = _request_id.set(request_id)
    try:
        yield
    finally:
        _request_id.reset(token)


def ensure_utf8_streams() -> None:
    """Вывод в UTF-8 независимо от кодовой страницы консоли (актуально для Windows)."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        # Поток может не поддерживать смену кодировки (например, подменён в тестах)
        with suppress(ValueError, OSError):
            reconfigure(encoding="utf-8", errors="replace")


def _add_service_fields(_logger: Any, _method: str, event_dict: dict[str, Any]) -> dict[str, Any]:
    event_dict["service"] = _SERVICE_NAME
    event_dict["request_id"] = event_dict.get("request_id") or _request_id.get()
    return event_dict


def _shared_processors() -> list[Any]:
    return [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        _add_service_fields,
        structlog.processors.TimeStamper(fmt="iso", utc=True, key="timestamp"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.EventRenamer("message"),
    ]


def configure_logging(level: str = "info", *, stream: Any | None = None) -> None:
    """Настроить structlog и стандартный logging на вывод JSON.

    По умолчанию логи идут в stdout — так их ждут контейнеры и сборщики логов.
    Командам CLI, которые сами печатают JSON (`parse`, `eval`, `dataset`), нужен stderr,
    иначе логи перемешиваются с результатом и его нельзя разобрать.
    """
    ensure_utf8_streams()
    log_level = getattr(logging, level.upper(), logging.INFO)

    handler = logging.StreamHandler(stream or sys.stdout)
    handler.setFormatter(
        structlog.stdlib.ProcessorFormatter(
            foreign_pre_chain=_shared_processors(),
            processors=[
                structlog.stdlib.ProcessorFormatter.remove_processors_meta,
                structlog.processors.JSONRenderer(ensure_ascii=False),
            ],
        )
    )
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(log_level)

    structlog.configure(
        processors=[*_shared_processors(), structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        wrapper_class=structlog.stdlib.BoundLogger,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)
