"""Клиент к локальной модели: молчание и мусор — это `None`, а не исключение."""

from __future__ import annotations

import httpx
import pytest

from inspector_ml.config import Settings
from inspector_ml.llm.client import LlmClient, is_local, parse_object

#: httpx требует, чтобы у ответа был запрос — иначе `raise_for_status` не работает.
REQUEST = httpx.Request("POST", "http://localhost:11434/v1/chat/completions")


def reply(content: str) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": content}}]}, request=REQUEST)


@pytest.fixture
def post(monkeypatch):
    """Подменяет `httpx.post` заданным обработчиком и запоминает отправленное."""
    sent: dict = {}

    def install(handler):
        def fake_post(url, **kwargs):
            sent["url"] = url
            sent["json"] = kwargs.get("json")
            sent["timeout"] = kwargs.get("timeout")
            return handler(url, kwargs)

        monkeypatch.setattr("inspector_ml.llm.client.httpx.post", fake_post)
        return sent

    return install


class TestClientIsBuiltFromSettings:
    def test_disabled_by_default(self) -> None:
        assert LlmClient.from_settings(Settings(_env_file=None)) is None

    def test_enabled_gives_a_client(self) -> None:
        client = LlmClient.from_settings(Settings(_env_file=None, llm_enabled=True))

        assert client is not None
        assert client.model == "qwen3:8b"

    def test_trailing_slash_does_not_double(self) -> None:
        client = LlmClient.from_settings(
            Settings(_env_file=None, llm_enabled=True, llm_base_url="http://localhost:8000/v1/")
        )

        assert client is not None
        assert client.base_url == "http://localhost:8000/v1"


class TestAsking:
    client = LlmClient(base_url="http://localhost:11434/v1", model="qwen3:8b", timeout=5)

    def test_json_answer_comes_back(self, post) -> None:
        post(lambda url, kw: reply('{"hypotheses": []}'))

        assert self.client.ask_json("system", "user") == {"hypotheses": []}

    def test_request_goes_to_chat_completions(self, post) -> None:
        sent = post(lambda url, kw: reply("{}"))
        self.client.ask_json("system", "user")

        assert sent["url"] == "http://localhost:11434/v1/chat/completions"
        assert sent["timeout"] == 5

    def test_temperature_is_zero(self, post) -> None:
        """На одних и тех же документах протокол должен получаться один и тот же."""
        sent = post(lambda url, kw: reply("{}"))
        self.client.ask_json("system", "user")

        assert sent["json"]["temperature"] == 0

    def test_model_is_not_running(self, post) -> None:
        def refuse(url, kw):
            raise httpx.ConnectError("connection refused")

        post(refuse)

        assert self.client.ask_json("system", "user") is None

    def test_timeout_is_not_an_error_for_the_run(self, post) -> None:
        def slow(url, kw):
            raise httpx.ReadTimeout("too slow")

        post(slow)

        assert self.client.ask_json("system", "user") is None

    def test_server_error(self, post) -> None:
        post(lambda url, kw: httpx.Response(500, request=httpx.Request("POST", url), text="boom"))

        assert self.client.ask_json("system", "user") is None

    def test_answer_without_choices(self, post) -> None:
        post(lambda url, kw: httpx.Response(200, json={"error": "no model"}, request=REQUEST))

        assert self.client.ask_json("system", "user") is None

    def test_answer_that_is_not_json(self, post) -> None:
        post(lambda url, kw: reply("расхождений не нашёл"))

        assert self.client.ask_json("system", "user") is None


class TestRemoteAddressIsRefused:
    """Запрет внешних API — механизм, а не намерение.

    Документы госнадзора наружу не уходят: клиент не поднимается на нелокальном адресе.
    Прогон при этом продолжается без гипотез — ронять проверку из-за настройки нельзя.
    """

    @pytest.mark.parametrize(
        "url",
        [
            "http://localhost:11434/v1",
            "http://127.0.0.1:8000/v1",
            "http://[::1]:8000/v1",
            "http://vllm:8000/v1",  # имя сервиса внутри compose
            "http://host.docker.internal:11434/v1",
            "http://ml-llm.internal/v1",
            "http://192.168.1.50:8000/v1",
            "http://10.0.0.7:8000/v1",
        ],
    )
    def test_local_addresses_pass(self, url: str) -> None:
        assert is_local(url) is True

    @pytest.mark.parametrize(
        "url",
        [
            "https://api.openai.com/v1",
            "https://api.example.org/v1",
            "http://example.com:11434/v1",
            "https://8.8.8.8/v1",
            "not-a-url",
        ],
    )
    def test_outside_addresses_do_not(self, url: str) -> None:
        assert is_local(url) is False

    def test_client_refuses_to_start_on_a_remote_address(self) -> None:
        settings = Settings(_env_file=None, llm_enabled=True, llm_base_url="https://api.openai.com/v1")

        assert LlmClient.from_settings(settings) is None

    def test_explicit_permission_still_works(self) -> None:
        """Осознанное решение остаётся возможным — запрещена случайность, а не выбор."""
        settings = Settings(
            _env_file=None,
            llm_enabled=True,
            llm_base_url="https://llm.example.com/v1",
            llm_allow_remote=True,
        )

        assert LlmClient.from_settings(settings) is not None

    def test_local_address_needs_no_permission(self) -> None:
        assert LlmClient.from_settings(Settings(_env_file=None, llm_enabled=True)) is not None


class TestTruncatedAnswer:
    """Ответ, обрезанный по потолку токенов: целые гипотезы из начала ответа не теряются."""

    def test_complete_items_are_kept(self) -> None:
        text = '{"hypotheses": [{"subject": "Помещение 1", "pd_quote": "а"}, {"subject": "Помещение 2", "pd_q'
        assert parse_object(text) == {"hypotheses": [{"subject": "Помещение 1", "pd_quote": "а"}]}

    def test_nothing_complete_gives_none(self) -> None:
        assert parse_object('{"hypotheses": [{"subject": "Поме') is None

    def test_think_off_sends_the_switches(self, monkeypatch) -> None:
        sent: list[dict] = []

        def fake_post(url, json, timeout, headers):
            sent.append(json)
            raise httpx.ConnectError("нет сети")

        monkeypatch.setattr(httpx, "post", fake_post)
        LlmClient("http://localhost:11434/v1", "qwen3:8b", think=False).ask_json("s", "u")
        LlmClient("http://localhost:11434/v1", "qwen3:8b").ask_json("s", "u")

        assert sent[0]["reasoning_effort"] == "none"
        assert sent[0]["chat_template_kwargs"] == {"enable_thinking": False}
        assert sent[0]["max_tokens"] < sent[1]["max_tokens"]
        assert "reasoning_effort" not in sent[1]
