"""Клиент к локальной модели по OpenAI-совместимому протоколу.

Берём `httpx`, который и так в зависимостях, а не пакет `openai`: нужен ровно один вызов
`POST /chat/completions`, и vLLM с Ollama отвечают на него одинаково. Значит extra `llm`
для работы не требуется — на стенде меньше зависимостей, а сменить рантайм можно переменной
окружения, не трогая код (ADR-0008).

**Ни одна ошибка отсюда не поднимается выше.** Модель не поднята, отвечает не то, молчит дольше
таймаута — возвращаем `None`, пишем предупреждение, прогон идёт дальше без гипотез. Проверка
не имеет права упасть из-за языковой модели.
"""

from __future__ import annotations

import ipaddress
import json
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx

from inspector_ml.config import Settings
from inspector_ml.logging import get_logger

log = get_logger(__name__)

#: Qwen3 по умолчанию рассуждает вслух и оборачивает рассуждение в этот тег. В JSON-режиме он
#: всё равно иногда просачивается в ответ, поэтому срезаем его перед разбором.
_THINK = re.compile(r"<think>.*?</think>", re.DOTALL)
#: Потолок длины ответа модели, токенов: без рассуждения и с ним (рассуждение входит в тот же счёт).
MAX_ANSWER_TOKENS = 1500
MAX_THINKING_TOKENS = 6000
#: Модель любит обрамлять JSON пояснением или ```json ... ```. Достаём самый внешний объект.
_OBJECT = re.compile(r"\{.*\}", re.DOTALL)
#: Начало списка в обрезанном ответе: `"hypotheses": [`.
_LIST_START = re.compile(r'"(\w+)"\s*:\s*\[')

#: Имена, которые заведомо никуда не ведут наружу.
_LOCAL_NAMES = {"localhost", "host.docker.internal"}
#: Суффиксы имён внутренних сетей.
_LOCAL_SUFFIXES = (".local", ".internal", ".localdomain")


def is_local(url: str) -> bool:
    """Ведёт ли адрес внутрь нашего контура.

    Локальным считаем: петлю (`localhost`, `127.0.0.1`, `::1`), имя без точек — так называются
    сервисы внутри compose (`vllm`, `ollama`), `host.docker.internal`, суффиксы внутренних сетей
    и частные диапазоны адресов (RFC 1918 и подобные), из которых в интернет не выйти.

    Всё остальное — наружу, и туда мы чертежи не отправляем.
    """
    host = (urlsplit(url).hostname or "").strip().lower()
    if not host:
        return False
    if host in _LOCAL_NAMES or host.endswith(_LOCAL_SUFFIXES):
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        # имя без точек — это сервис внутри compose или короткое имя в локальной сети
        return "." not in host
    return address.is_loopback or address.is_private or address.is_link_local or address.is_unspecified


@dataclass(frozen=True)
class LlmClient:
    """Одно соединение с моделью. Создаётся на задачу, не кешируется — вызовов мало и они редкие."""

    base_url: str
    model: str
    api_key: str = "local"
    timeout: float = 90.0
    think: bool = True

    @classmethod
    def from_settings(cls, settings: Settings) -> LlmClient | None:
        """Клиент, либо `None` — если модель выключена или адрес ведёт наружу.

        Выключенная модель (`LLM_ENABLED=false`) — умолчание и состояние нашего публичного стенда,
        это не ошибка. А вот нелокальный адрес — ошибка настройки, и она пишется уровнем `error`:
        152-ФЗ запрещает отправлять документы госнадзора
        во внешние API, и запрет должен быть механизмом, а не намерением. Осознанное исключение
        остаётся: `LLM_ALLOW_REMOTE=true`.

        Прогон при этом продолжается без гипотез, как и при любой другой недоступности модели
        ([ADR-0008](../../../../docs/adr/0008-llm-scope.md)): ронять проверку из-за настройки нельзя.
        """
        if not settings.llm_enabled:
            return None
        if not settings.llm_allow_remote and not is_local(settings.llm_base_url):
            log.error(
                "llm_remote_blocked",
                url=settings.llm_base_url,
                reason=(
                    "адрес модели не локальный: документы госнадзора наружу не уходят "
                    "(152-ФЗ). Поднимите модель в своём контуре "
                    "или выставьте LLM_ALLOW_REMOTE=true осознанно."
                ),
            )
            return None
        return cls(
            base_url=settings.llm_base_url.rstrip("/"),
            model=settings.llm_model,
            api_key=settings.llm_api_key,
            timeout=settings.llm_timeout_s,
            think=settings.llm_think,
        )

    def ask_json(self, system: str, user: str) -> dict[str, Any] | None:
        """Спросить модель и получить объект JSON. Любая неудача — `None`, а не исключение."""
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            # температура ноль: на одних и тех же документах протокол должен получаться один и тот же
            "temperature": 0,
            "response_format": {"type": "json_object"},
            "stream": False,
            # Потолок ответа. Без него зациклившаяся модель писала до конца контекста, а локальный сервер
            # обрабатывает запросы по одному — очередь вставала на час.
            "max_tokens": MAX_THINKING_TOKENS if self.think else MAX_ANSWER_TOKENS,
        }
        if not self.think:
            # Выключатель рассуждения Qwen3. «/no_think» в тексте Ollama не слушает (замер 27.09: 241 токен
            # ответа и 730 символов рассуждения против 13 токенов); `reasoning_effort` — поле OpenAI API, его
            # понимает Ollama, `chat_template_kwargs` — выключатель Qwen3 в vLLM. Лишние поля оба пропускают.
            payload["reasoning_effort"] = "none"
            payload["chat_template_kwargs"] = {"enable_thinking": False}
        try:
            response = httpx.post(
                f"{self.base_url}/chat/completions",
                json=payload,
                timeout=self.timeout,
                headers={"Authorization": f"Bearer {self.api_key}"},
            )
            response.raise_for_status()
            body = response.json()
        except (httpx.HTTPError, ValueError) as error:
            log.warning("llm_unavailable", model=self.model, url=self.base_url, reason=str(error))
            return None

        content = _content(body)
        if content is None:
            log.warning("llm_empty_answer", model=self.model)
            return None
        parsed = parse_object(content)
        if parsed is None:
            log.warning("llm_not_json", model=self.model, answer=content[:200])
        return parsed


def _content(body: Any) -> str | None:
    try:
        choices = body["choices"]
        return str(choices[0]["message"]["content"])
    except (KeyError, IndexError, TypeError):
        return None


def parse_object(content: str) -> dict[str, Any] | None:
    """Объект JSON из ответа модели: с рассуждением вслух, обрамлением и прочим мусором вокруг."""
    text = _THINK.sub("", content).strip()
    try:
        value = json.loads(text)
    except ValueError:
        match = _OBJECT.search(text)
        if match is None:
            return _salvage(text)
        try:
            value = json.loads(match.group(0))
        except ValueError:
            return _salvage(text)
    return value if isinstance(value, dict) else None


def _salvage(text: str) -> dict[str, Any] | None:
    """Ответ, обрезанный по потолку токенов: берём целые элементы списка из его начала.

    Модель, которой разрешили длинный ответ, иногда перечисляет гипотезы до потолка — и JSON обрывается
    посреди последнего элемента. Первые, законченные элементы от этого хуже не становятся.
    """
    match = _LIST_START.search(text)
    if match is None:
        return None
    decoder = json.JSONDecoder()
    items: list[Any] = []
    position = match.end()
    while True:
        while position < len(text) and text[position] in " \t\r\n,":
            position += 1
        if position >= len(text) or text[position] != "{":
            break
        try:
            item, position = decoder.raw_decode(text, position)
        except ValueError:
            break
        items.append(item)
    return {match.group(1): items} if items else None
