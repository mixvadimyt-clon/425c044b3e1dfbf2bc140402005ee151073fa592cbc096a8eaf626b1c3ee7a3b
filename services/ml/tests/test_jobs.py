"""Очередь задач: приём, идемпотентность, кеш, ошибки и доставка результата на reply_to."""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from helpers import PROCESS_ID, REPLY_TO, parse_envelope, store, submit, wait_for_job
from inspector_ml.api.app import create_app
from inspector_ml.config import Settings
from inspector_ml.jobs.callback import CallbackSender
from inspector_ml.jobs.runner import JobRunner


@pytest.fixture
def delivered() -> list[httpx.Request]:
    return []


@pytest.fixture
def job_client(settings: Settings, delivered: list[httpx.Request]) -> Iterator[TestClient]:
    """Клиент с подменённой доставкой результата: api не поднимаем, ловим запросы."""

    def handler(request: httpx.Request) -> httpx.Response:
        delivered.append(request)
        return httpx.Response(204)

    callback = CallbackSender(
        internal_token=settings.internal_token,
        delays=(0, 0, 0),
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    runner = JobRunner(settings, callback=callback)
    with TestClient(create_app(settings, runner=runner)) as client:
        yield client


def test_parse_job_produces_parsed_document(
    job_client: TestClient, settings: Settings, make_pdf: Callable[..., Path], delivered: list[httpx.Request]
) -> None:
    sha, key = store(settings, make_pdf(pages=3))
    envelope = parse_envelope(sha, key)

    accepted = submit(job_client, envelope)
    assert accepted["state"] == "QUEUED"

    state = wait_for_job(job_client, envelope["message_id"])
    assert state["state"] == "DONE"

    result = state["result"]
    assert result["type"] == "ml.parse.result"
    assert result["correlation_id"] == PROCESS_ID  # correlation_id — это process_id проверки

    payload = result["payload"]
    assert payload["status"] == "OK"
    assert payload["from_cache"] is False
    assert payload["parsed_ref"] == {"bucket": "local", "key": f"parsed/{sha}/{settings.parser_version}.json"}
    assert payload["quality"]["pages_total"] == 3
    assert payload["quality"]["pages_text_layer"] == 3
    assert (settings.storage_dir / payload["parsed_ref"]["key"]).exists()

    # результат ушёл на reply_to
    assert len(delivered) == 1
    assert str(delivered[0].url) == REPLY_TO


def test_second_upload_of_same_file_hits_cache(
    job_client: TestClient, settings: Settings, make_pdf: Callable[..., Path]
) -> None:
    """Тот же файл в другой проверке разбирается из кеша (REQ-PRS-07)."""
    sha, key = store(settings, make_pdf())

    first = parse_envelope(sha, key)
    submit(job_client, first)
    assert wait_for_job(job_client, first["message_id"])["result"]["payload"]["from_cache"] is False

    second = parse_envelope(sha, key)
    submit(job_client, second)
    assert wait_for_job(job_client, second["message_id"])["result"]["payload"]["from_cache"] is True


def test_cache_hit_recomputes_metadata_with_this_file_name(
    job_client: TestClient, settings: Settings, make_pdf: Callable[..., Path]
) -> None:
    """Метаданные из кеша пересчитываются: имя этой загрузки, а не той, что была при предрасчёте."""
    sha, key = store(settings, make_pdf())
    first = parse_envelope(sha, key, name="scan-0001.pdf")
    submit(job_client, first)
    wait_for_job(job_client, first["message_id"])

    second = parse_envelope(sha, key, name="РД-2025-04-266-АР2.pdf")
    submit(job_client, second)
    payload = wait_for_job(job_client, second["message_id"])["result"]["payload"]

    assert payload["from_cache"] is True
    assert (payload["metadata"]["doc_stage"], payload["metadata"]["discipline"]) == ("RD", "АР")


def test_force_reparse_ignores_cache(job_client: TestClient, settings: Settings, make_pdf: Callable[..., Path]) -> None:
    sha, key = store(settings, make_pdf())
    first = parse_envelope(sha, key)
    submit(job_client, first)
    wait_for_job(job_client, first["message_id"])

    second = parse_envelope(sha, key, force_reparse=True)
    submit(job_client, second)

    assert wait_for_job(job_client, second["message_id"])["result"]["payload"]["from_cache"] is False


def test_repeated_message_id_does_not_run_twice(
    job_client: TestClient, settings: Settings, make_pdf: Callable[..., Path], delivered: list[httpx.Request]
) -> None:
    """api повторяет отправку при сетевых сбоях — задача должна выполниться один раз."""
    sha, key = store(settings, make_pdf())
    envelope = parse_envelope(sha, key)

    submit(job_client, envelope)
    wait_for_job(job_client, envelope["message_id"])
    repeat = submit(job_client, envelope)

    assert repeat["state"] == "DONE"
    assert len(delivered) == 1


def test_missing_file_reports_retryable_error(job_client: TestClient) -> None:
    envelope = parse_envelope("0" * 64, "raw/нет-такого-файла")

    submit(job_client, envelope)
    state = wait_for_job(job_client, envelope["message_id"])

    assert state["state"] == "FAILED"
    error = state["result"]["payload"]["error"]
    assert error["code"] == "FILE_NOT_FOUND"
    assert error["retryable"] is True


def test_sha256_mismatch_is_not_retryable(
    job_client: TestClient, settings: Settings, make_pdf: Callable[..., Path]
) -> None:
    _sha, key = store(settings, make_pdf())
    envelope = parse_envelope("1" * 64, key)

    submit(job_client, envelope)
    state = wait_for_job(job_client, envelope["message_id"])

    error = state["result"]["payload"]["error"]
    assert error["code"] == "SHA256_MISMATCH"
    assert error["retryable"] is False


def test_corrupted_pdf_fails_without_killing_worker(
    job_client: TestClient, settings: Settings, tmp_path: Path, make_pdf: Callable[..., Path]
) -> None:
    """Обрезанный PDF (такие есть в датасете) — это CORRUPTED_FILE, а не падение воркера."""
    broken = tmp_path / "broken.pdf"
    broken.write_bytes(b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n")
    sha, key = store(settings, broken)

    envelope = parse_envelope(sha, key)
    submit(job_client, envelope)
    state = wait_for_job(job_client, envelope["message_id"])

    assert state["state"] == "FAILED"
    error = state["result"]["payload"]["error"]
    assert error["code"] == "CORRUPTED_FILE"
    assert error["retryable"] is False

    # очередь жива: следующая задача выполняется нормально
    good_sha, good_key = store(settings, make_pdf("good.pdf"))
    good = parse_envelope(good_sha, good_key)
    submit(job_client, good)
    assert wait_for_job(job_client, good["message_id"])["state"] == "DONE"


def test_unsupported_format(job_client: TestClient) -> None:
    """OTHER (архивы, DWG, изображения) лежит в комплекте карточкой и не разбирается; DOCX и XML — test_docx_xml."""
    envelope = parse_envelope("0" * 64, "raw/doc")
    envelope["payload"]["file"]["format"] = "OTHER"

    submit(job_client, envelope)
    state = wait_for_job(job_client, envelope["message_id"])

    assert state["result"]["payload"]["error"]["code"] == "UNSUPPORTED_FORMAT"


def test_timeout_is_retryable(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    """Задача, не уложившаяся в timeout_s, отдаёт TIMEOUT с retryable = true."""
    release = threading.Event()

    def slow(_settings: dict[str, Any], _payload: dict[str, Any]) -> dict[str, Any]:
        release.wait(timeout=10)
        return {"status": "OK"}

    monkeypatch.setitem(
        __import__("inspector_ml.jobs.runner", fromlist=["HANDLERS"]).HANDLERS, "ml.parse.request", slow
    )
    runner = JobRunner(settings, callback=CallbackSender(delays=()))
    try:
        with TestClient(create_app(settings, runner=runner)) as client:
            envelope = parse_envelope("0" * 64, "raw/x", timeout_s=1)
            envelope["reply_to"] = None
            submit(client, envelope)
            state = wait_for_job(client, envelope["message_id"])

            assert state["state"] == "FAILED"
            error = state["result"]["payload"]["error"]
            assert error["code"] == "TIMEOUT"
            assert error["retryable"] is True
    finally:
        release.set()


def test_callback_retries_until_delivered() -> None:
    attempts: list[int] = []

    def handler(_request: httpx.Request) -> httpx.Response:
        attempts.append(1)
        return httpx.Response(204 if len(attempts) > 2 else 503)

    sender = CallbackSender(delays=(0, 0, 0), client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))

    assert asyncio.run(sender.send(REPLY_TO, {"message_id": "x"})) is True
    assert len(attempts) == 3


def test_callback_gives_up_and_result_stays_available() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("api недоступен")

    sender = CallbackSender(delays=(0,), client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))

    assert asyncio.run(sender.send(REPLY_TO, {"message_id": "x"})) is False


def test_callback_sends_internal_token() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(204)

    sender = CallbackSender(
        internal_token="secret",
        delays=(),
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    asyncio.run(sender.send(REPLY_TO, {"message_id": "x"}))

    assert seen[0].headers["x-internal-token"] == "secret"
