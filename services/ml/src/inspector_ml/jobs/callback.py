"""Отправка результата на `reply_to` (HTTP-транспорт).

api ждёт `Envelope` с `ml.parse.result` или `ml.compare.result` и отвечает `204`.
Если api недоступен, повторяем через 1, 5 и 15 секунд — этого хватает, чтобы пережить
перезапуск api во время разработки. Совсем недоставленный результат не теряется:
он остаётся в `GET /v1/jobs/{message_id}`, откуда api может забрать его сам.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterable, Sequence
from typing import Any
from urllib.parse import urlsplit

import httpx

from inspector_ml.logging import get_logger
from inspector_ml.metrics import CALLBACKS

log = get_logger(__name__)

RETRY_DELAYS: tuple[float, ...] = (1.0, 5.0, 15.0)
INTERNAL_TOKEN_HEADER = "x-internal-token"
#: Один и тот же компьютер под разными именами: api на localhost, а в reply_to — 127.0.0.1.
LOOPBACK = ("localhost", "127.0.0.1", "::1")

Origin = tuple[str, str, int]


def origin(url: str) -> Origin | None:
    """Схема, хост и порт адреса; `None` — не http(s) или без хоста."""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None
    return parts.scheme, parts.hostname.lower(), port or (443 if parts.scheme == "https" else 80)


def allowed_origins(api_url: str, extra: str | Iterable[str] = "") -> frozenset[Origin]:
    """Куда можно слать результат: адрес api из настроек и явно перечисленные.

    Внешний вход в ml закрыт внутренним токеном, но `reply_to` приходит в самом задании. Без проверки
    ml послал бы результат — разобранный документ со страницами и значениями — на любой адрес, который
    ему передали. Это защита в глубину: результат на чужой адрес не уходит, а остаётся в
    `GET /v1/jobs/{message_id}`.
    """
    urls = [api_url, *(extra.split(",") if isinstance(extra, str) else extra)]
    allowed: set[Origin] = set()
    for url in urls:
        parsed = origin(url.strip())
        if parsed is None:
            continue
        allowed.add(parsed)
        if parsed[1] in LOOPBACK:
            allowed.update((parsed[0], host, parsed[2]) for host in LOOPBACK)
    return frozenset(allowed)


class CallbackSender:
    """Доставка результата с повторами."""

    def __init__(
        self,
        *,
        internal_token: str = "",
        delays: Sequence[float] = RETRY_DELAYS,
        timeout_s: float = 15.0,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.internal_token = internal_token
        self.delays = tuple(delays)
        self.timeout_s = timeout_s
        self._client = client
        self._owns_client = client is None

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.timeout_s)
        return self._client

    async def aclose(self) -> None:
        if self._client is not None and self._owns_client:
            await self._client.aclose()
            self._client = None

    async def send(self, reply_to: str, envelope: dict[str, Any]) -> bool:
        """Отправить результат. `True` — api принял, `False` — все попытки исчерпаны."""
        headers = {"content-type": "application/json"}
        if self.internal_token:
            headers[INTERNAL_TOKEN_HEADER] = self.internal_token

        attempts = len(self.delays) + 1
        for attempt in range(1, attempts + 1):
            try:
                response = await self.client.post(reply_to, json=envelope, headers=headers)
                if response.status_code < 400:
                    CALLBACKS.labels(outcome="delivered").inc()
                    return True
                reason = f"HTTP {response.status_code}"
            except httpx.HTTPError as exc:
                reason = f"{type(exc).__name__}: {exc}"

            if attempt == attempts:
                CALLBACKS.labels(outcome="failed").inc()
                log.error(
                    "callback_failed",
                    reply_to=reply_to,
                    message_id=envelope.get("message_id"),
                    attempts=attempt,
                    reason=reason,
                )
                return False

            delay = self.delays[attempt - 1]
            log.warning("callback_retry", reply_to=reply_to, attempt=attempt, delay_s=delay, reason=reason)
            await asyncio.sleep(delay)
        return False
