"""Очередь задач на стенде (ревью п. 2–4): адрес ответа, хранение результатов, зависшие процессы."""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

import helpers
from helpers import parse_envelope, submit, wait_for_job
from inspector_ml.api.app import create_app
from inspector_ml.config import Settings
from inspector_ml.jobs import runner as runner_module
from inspector_ml.jobs.callback import CallbackSender, allowed_origins, origin
from inspector_ml.jobs.runner import JobRecord, JobRunner


def alive(pid: int) -> bool:
    """Жив ли процесс. На Windows os.kill(pid, 0) не проверяет, а убивает, поэтому — через WinAPI."""
    if sys.platform == "win32":
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        code = ctypes.c_ulong()
        kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        kernel32.CloseHandle(handle)
        return code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def quick(_settings: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    file = payload["file"]
    return {
        "process_id": payload["process_id"],
        "file_id": file["file_id"],
        "sha256": file["sha256"],
        "status": "FAILED",
        "error": {"code": "QUICK", "message": "быстрая задача", "retryable": False},
        "parser_version": "0.5.0",
    }


class TestReplyTo:
    def test_allowed_origins(self) -> None:
        allowed = allowed_origins("http://localhost:3000", "https://api.example.test, not a url")

        assert origin("http://127.0.0.1:3000/internal/ml/results") in allowed  # localhost = 127.0.0.1
        assert origin("http://localhost:3001/internal/ml/results") not in allowed  # другой порт
        assert origin("https://api.example.test/x") in allowed  # порт по умолчанию 443
        assert origin("http://api.example.test/x") not in allowed  # другая схема
        assert origin("ftp://localhost:3000/x") is None

    def test_result_is_not_sent_to_a_foreign_address(self, settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
        """Чужой reply_to: результат не уходит, но остаётся в GET /v1/jobs."""
        sent: list[httpx.Request] = []
        callback = CallbackSender(
            delays=(),
            client=httpx.AsyncClient(transport=httpx.MockTransport(lambda r: sent.append(r) or httpx.Response(204))),
        )
        monkeypatch.setitem(runner_module.HANDLERS, "ml.parse.request", quick)
        with TestClient(create_app(settings, runner=JobRunner(settings, callback=callback))) as client:
            envelope = parse_envelope("b" * 64, "raw/x")
            envelope["reply_to"] = "http://attacker.test/collect"
            submit(client, envelope)
            state = wait_for_job(client, envelope["message_id"])

        assert state["result"]["payload"]["error"]["code"] == "QUICK"
        assert sent == []


class TestStoredResults:
    def test_result_survives_restart_and_is_not_rerun(
        self, settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setitem(runner_module.HANDLERS, "ml.parse.request", quick)
        envelope = parse_envelope("b" * 64, "raw/x")
        envelope["reply_to"] = None
        with TestClient(create_app(settings, runner=JobRunner(settings, callback=CallbackSender(delays=())))) as client:
            submit(client, envelope)
            before = wait_for_job(client, envelope["message_id"])

        restarted = JobRunner(settings, callback=CallbackSender(delays=()))  # новый процесс ml: память пуста
        after = restarted.state(envelope["message_id"])
        again = restarted.submit(envelope)

        assert after == before
        assert again == before
        assert restarted.queue_size == 0  # повтор после перезапуска работу не запускает

    def test_memory_is_bounded_and_evicted_results_come_from_disk(self, settings: Settings) -> None:
        settings = settings.model_copy(update={"ml_job_memory_max": 10})
        runner = JobRunner(settings, callback=CallbackSender(delays=()))
        for n in range(12):
            record = JobRecord(message_id=f"job-{n:02d}", envelope={}, state="DONE", progress=100, result={"n": n})
            record.finished_at = float(n)
            runner._jobs[record.message_id] = record
            runner._store(record)
        runner._evict()

        assert len(runner._jobs) == 10
        assert "job-00" not in runner._jobs
        assert runner.state("job-00")["result"] == {"n": 0}

    def test_old_results_are_removed(self, settings: Settings) -> None:
        runner = JobRunner(settings, callback=CallbackSender(delays=()))
        record = JobRecord(message_id="old-job", envelope={}, state="DONE", progress=100, result={})
        runner._store(record)
        path = Path(settings.cache_dir) / "jobs" / "old-job.json"
        old = time.time() - settings.ml_job_ttl_s - 60
        os.utime(path, (old, old))

        assert runner.state("old-job") is None  # просроченный результат не отдаём
        runner._cleanup(force=True)
        assert not path.exists()

    def test_unsafe_message_id_never_becomes_a_path(self, settings: Settings) -> None:
        runner = JobRunner(settings, callback=CallbackSender(delays=()))
        record = JobRecord(message_id="../../escape", envelope={}, state="DONE", progress=100, result={})
        runner._store(record)

        assert not (Path(settings.cache_dir) / "escape.json").exists()
        assert runner.state("../../escape") is None


@pytest.fixture
def process_settings(settings: Settings) -> Settings:
    """Настоящий пул процессов, как на стенде: в потоках убивать нечего."""
    return settings.model_copy(update={"ml_executor": "process"})


class TestHungProcess:
    def test_timeout_kills_the_worker_process(
        self, process_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setitem(runner_module.HANDLERS, "ml.parse.request", helpers.hang)
        runner = JobRunner(process_settings, callback=CallbackSender(delays=()))
        with TestClient(create_app(process_settings, runner=runner)) as client:
            envelope = parse_envelope("a" * 64, "raw/x", timeout_s=8)
            envelope["reply_to"] = None
            submit(client, envelope)
            state = wait_for_job(client, envelope["message_id"], timeout=60)
            pid = int((Path(process_settings.cache_dir) / "hang.pid").read_text(encoding="ascii"))

            deadline = time.monotonic() + 10
            while alive(pid) and time.monotonic() < deadline:
                time.sleep(0.1)

            assert state["result"]["payload"]["error"]["code"] == "TIMEOUT"
            assert not alive(pid), "зависший процесс пережил таймаут"

    def test_neighbour_in_the_same_pool_is_restarted_not_failed(
        self, process_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Убийство зависшего процесса ломает весь пул; соседняя задача перезапускается и доходит до конца."""
        settings = process_settings.model_copy(update={"ml_workers": 2})
        monkeypatch.setitem(runner_module.HANDLERS, "ml.parse.request", helpers.hang_or_slow)
        runner = JobRunner(settings, callback=CallbackSender(delays=()))
        with TestClient(create_app(settings, runner=runner)) as client:
            hung = parse_envelope("a" * 64, "raw/x", timeout_s=8)
            slow = parse_envelope("b" * 64, "raw/y", timeout_s=60)
            for envelope in (hung, slow):
                envelope["reply_to"] = None
                submit(client, envelope)

            hung_state = wait_for_job(client, hung["message_id"], timeout=60)
            slow_state = wait_for_job(client, slow["message_id"], timeout=90)

        starts = (Path(settings.cache_dir) / "slow.starts").read_text(encoding="ascii").split()
        assert hung_state["result"]["payload"]["error"]["code"] == "TIMEOUT"
        assert slow_state["result"]["payload"]["error"]["code"] == "SLOW_DONE"
        assert len(starts) == 2, "соседняя задача должна была перезапуститься в новом пуле ровно один раз"


class TestBrokenPool:
    """Пул сломан не нами — процесс убило ядро или он упал в paddle/torch.

    Раньше пул оставался сломанным, и все следующие задачи падали `INTERNAL` до ручного перезапуска ml.
    """

    def test_worker_killed_from_outside_is_retried_in_a_new_pool(
        self, process_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setitem(runner_module.HANDLERS, "ml.parse.request", helpers.hang_once)
        runner = JobRunner(process_settings, callback=CallbackSender(delays=()))
        pid_file = Path(process_settings.cache_dir) / "hang.pid"
        with TestClient(create_app(process_settings, runner=runner)) as client:
            first = parse_envelope("b" * 64, "raw/x", timeout_s=120)
            first["reply_to"] = None
            submit(client, first)
            deadline = time.monotonic() + 60
            while not pid_file.exists() and time.monotonic() < deadline:
                time.sleep(0.1)
            runner_module._kill(int(pid_file.read_text(encoding="ascii")))  # «ядро убило процесс»
            first_state = wait_for_job(client, first["message_id"], timeout=90)

            second = parse_envelope("c" * 64, "raw/y", timeout_s=60)
            second["reply_to"] = None
            submit(client, second)
            second_state = wait_for_job(client, second["message_id"], timeout=90)

        assert first_state["result"]["payload"]["error"]["code"] == "AFTER_KILL"  # повтор в новом пуле
        assert second_state["result"]["payload"]["error"]["code"] == "AFTER_KILL"

    def test_task_that_always_crashes_fails_but_the_next_one_passes(
        self, process_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setitem(runner_module.HANDLERS, "ml.parse.request", helpers.crash_or_quick)
        runner = JobRunner(process_settings, callback=CallbackSender(delays=()))
        with TestClient(create_app(process_settings, runner=runner)) as client:
            crashing = parse_envelope("d" * 64, "raw/x", timeout_s=60)
            normal = parse_envelope("b" * 64, "raw/y", timeout_s=60)
            for envelope in (crashing, normal):
                envelope["reply_to"] = None
            submit(client, crashing)
            crashed = wait_for_job(client, crashing["message_id"], timeout=90)
            submit(client, normal)
            passed = wait_for_job(client, normal["message_id"], timeout=90)

        assert crashed["state"] == "FAILED"
        assert crashed["result"]["payload"]["error"]["code"] == "INTERNAL"  # роняла процесс и на повторе
        assert passed["result"]["payload"]["error"]["code"] == "QUICK"  # пул после неё снова целый

    def test_stopping_ml_kills_running_workers(
        self, process_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Рабочие процессы — главы своих групп, Ctrl+C до них не доходит: при остановке ml их убиваем сами."""
        monkeypatch.setitem(runner_module.HANDLERS, "ml.parse.request", helpers.hang)
        runner = JobRunner(process_settings, callback=CallbackSender(delays=()))
        pid_file = Path(process_settings.cache_dir) / "hang.pid"
        with TestClient(create_app(process_settings, runner=runner)) as client:
            envelope = parse_envelope("a" * 64, "raw/x", timeout_s=600)
            envelope["reply_to"] = None
            submit(client, envelope)
            deadline = time.monotonic() + 60
            while not pid_file.exists() and time.monotonic() < deadline:
                time.sleep(0.1)
            pid = int(pid_file.read_text(encoding="ascii"))

        deadline = time.monotonic() + 10
        while alive(pid) and time.monotonic() < deadline:
            time.sleep(0.1)
        assert not alive(pid), "рабочий процесс пережил остановку ml"


class TestEvictOnlyStored:
    def test_result_not_written_to_disk_stays_in_memory(self, settings: Settings) -> None:
        """Диск кончился — результат остаётся в памяти, а не пропадает совсем."""
        settings = settings.model_copy(update={"ml_job_memory_max": 10})
        runner = JobRunner(settings, callback=CallbackSender(delays=()))
        for n in range(12):
            record = JobRecord(message_id=f"job-{n:02d}", envelope={}, state="DONE", progress=100, result={"n": n})
            record.finished_at = float(n)
            runner._jobs[record.message_id] = record
            if n >= 2:  # две самые старые не записались
                runner._store(record)
        runner._evict()

        assert "job-00" in runner._jobs and "job-01" in runner._jobs
        assert runner.state("job-00")["result"] == {"n": 0}


def test_parsed_cache_write_leaves_no_temporary_files(tmp_path: Path) -> None:
    from inspector_ml.storage.cache import ParsedCache

    cache = ParsedCache(tmp_path / "storage", tmp_path / "cache")
    cache.put("f" * 64, "0.5.0", {"pages": [{"page": 1}]})

    assert cache.get("f" * 64, "0.5.0") == {"pages": [{"page": 1}]}
    assert not list(tmp_path.rglob("*.tmp"))
