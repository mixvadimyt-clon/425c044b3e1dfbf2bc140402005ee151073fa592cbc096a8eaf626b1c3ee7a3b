"""Очередь задач ML-сервиса.

Приём задач асинхронный (`POST /v1/jobs` отвечает `202` сразу), само выполнение — в пуле
процессов: разбор PDF упирается в процессор, и в потоках он блокировал бы событийный цикл.

Гарантии:

- **идемпотентность по `message_id`**: повтор той же задачи не запускает работу второй раз,
  а возвращает текущее состояние (api повторяет отправку при сетевых сбоях — REQ-UPL-06);
- **таймаут** из `options.timeout_s`, иначе `ML_JOB_TIMEOUT_S`. Зависший процесс убивается, а не
  доедает процессор стенда;
- **результат не теряется**: он лежит в `GET /v1/jobs/{message_id}` независимо от того,
  удалось ли доставить его на `reply_to`, — в памяти и на диске (`CACHE_DIR/jobs`), так что
  переживает и перезапуск ml. Хранится `ML_JOB_TTL_S` (по умолчанию 48 часов), в памяти — не больше
  `ML_JOB_MEMORY_MAX` готовых задач. Задача, которая стояла в очереди или
  выполнялась в момент перезапуска, теряется: `GET` отвечает 404, и api повторяет отправку с тем же
  `message_id`;
- **результат уходит только на разрешённый адрес** — `API_URL` и `ML_CALLBACK_ORIGINS`.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import signal
import time
from collections.abc import Callable
from concurrent.futures import Executor, ProcessPoolExecutor, ThreadPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime
from multiprocessing import get_context
from pathlib import Path
from typing import Any
from uuid import uuid4

from inspector_ml.config import Settings
from inspector_ml.contracts.events import Envelope
from inspector_ml.jobs.callback import CallbackSender, allowed_origins, origin
from inspector_ml.jobs.handlers import HANDLERS, RESULT_TYPE
from inspector_ml.logging import get_logger, request_context
from inspector_ml.metrics import CALLBACKS, JOB_DURATION, JOBS, JOBS_QUEUED

log = get_logger(__name__)

#: `message_id` становится именем файла результата — пускаем только безопасные символы.
SAFE_ID = re.compile(r"[0-9A-Za-z_-]{1,100}")
#: Как часто чистить устаревшие результаты на диске.
CLEANUP_EVERY_S = 600.0


def _worker_init() -> None:
    """Рабочий процесс — глава своей группы процессов: по таймауту убиваем его вместе с потомками."""
    if hasattr(os, "setpgrp"):
        os.setpgrp()


def _run(
    handler: Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]],
    settings_data: dict[str, Any],
    payload: dict[str, Any],
    pid_file: str | None,
) -> dict[str, Any]:
    """Выполнить задачу в рабочем процессе, записав его PID: зависший процесс runner убьёт по нему."""
    if pid_file:
        Path(pid_file).write_text(str(os.getpid()), encoding="ascii")
    return handler(settings_data, payload)


def _kill(pid: int) -> None:
    """Убить процесс, а в Linux — всю его группу (рабочий процесс — глава группы, `_worker_init`)."""
    if pid == os.getpid():
        return
    if hasattr(os, "killpg"):
        with suppress(ProcessLookupError):
            if os.getpgid(pid) == pid:
                os.killpg(pid, signal.SIGKILL)
            else:
                os.kill(pid, signal.SIGKILL)
    else:  # Windows: os.kill — это TerminateProcess
        with suppress(OSError):
            os.kill(pid, signal.SIGTERM)


@dataclass
class JobRecord:
    """Состояние одной задачи."""

    message_id: str
    envelope: dict[str, Any]
    state: str = "QUEUED"
    progress: int = 0
    result: dict[str, Any] | None = None
    created_at: float = field(default_factory=time.monotonic)
    finished_at: float | None = None
    #: результат записан на диск — только такую задачу можно вытеснить из памяти
    stored: bool = False

    def as_state(self) -> dict[str, Any]:
        return {
            "message_id": self.message_id,
            "state": self.state,
            "progress": self.progress,
            "result": self.result,
        }


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _failure_payload(envelope: dict[str, Any], settings: Settings, error: dict[str, Any]) -> dict[str, Any]:
    """Результат-ошибка по типу запроса: контракт требует те же обязательные поля."""
    payload = envelope.get("payload") or {}
    if envelope["type"] == "ml.parse.request":
        file = payload.get("file") or {}
        return {
            "process_id": payload.get("process_id"),
            "file_id": file.get("file_id"),
            "sha256": file.get("sha256", ""),
            "status": "FAILED",
            "error": error,
            "parser_version": settings.parser_version,
        }
    return {
        "process_id": payload.get("process_id"),
        "protocol_version": payload.get("protocol_version", 1),
        "status": "FAILED",
        "error": error,
    }


def result_envelope(request: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """Конверт с результатом: `correlation_id` — это `process_id` проверки."""
    envelope = {
        "message_id": str(uuid4()),
        "type": RESULT_TYPE[request["type"]],
        "schema_version": request.get("schema_version", "0.4.0"),
        "correlation_id": payload.get("process_id") or request.get("correlation_id"),
        "attempt": request.get("attempt") or 1,
        "created_at": _now(),
        "payload": payload,
    }
    # проверяем результат по контракту до отправки: лучше упасть у себя, чем прислать api мусор
    return Envelope.model_validate(envelope).model_dump(mode="json")


class JobRunner:
    """Очередь задач с пулом процессов и доставкой результата на `reply_to`."""

    def __init__(
        self,
        settings: Settings,
        *,
        callback: CallbackSender | None = None,
        executor: Executor | None = None,
    ) -> None:
        self.settings = settings
        self.callback = callback if callback is not None else CallbackSender(internal_token=settings.internal_token)
        self._settings_data = settings.model_dump(mode="json")
        self._external_executor = executor
        self._executor: Executor | None = executor
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._jobs: dict[str, JobRecord] = {}
        self._workers: list[asyncio.Task[None]] = []
        self._allowed = allowed_origins(settings.api_url, settings.ml_callback_origins)
        self._jobs_dir = Path(settings.cache_dir) / "jobs"
        # номер пула: после таймаута пул пересоздаётся, и задачи старого пула, сломанного убийством
        # зависшего процесса, один раз перезапускаются в новом
        self._generation = 0
        self._last_cleanup = 0.0

    # --- жизненный цикл -------------------------------------------------

    def _new_executor(self) -> Executor:
        if self.settings.ml_executor == "thread":
            return ThreadPoolExecutor(max_workers=self.settings.ml_workers, thread_name_prefix="ml-job")
        # Рабочие процессы поднимаем через spawn, а не через fork (умолчание Linux).
        #
        # `GET /health` спрашивает у paddle, видна ли видеокарта (`capabilities._cuda_available`),
        # и этим создаёт контекст CUDA в головном процессе. Форк такой контекст не переносит:
        # в потомке первая же операция падает с «CUDA error(3), initialization error», и падает
        # она на каждой плитке — то есть распознавание молча даёт ноль страниц. Проверка здоровья,
        # написанная чтобы доказать, что карта видна, ломала работу на карте. Поймано 22.09
        # на RTX 3050: в командной строке 183 страницы скана ИД распознавались за 4м50с,
        # а та же работа через сервис не давала ни одной строки.
        #
        # spawn стоит нескольких секунд на подъём каждого рабочего процесса, но процессы живут
        # долго (движок в них кешируется — `ocr.engines.build_engine`), так что цену платим один раз.
        return ProcessPoolExecutor(
            max_workers=self.settings.ml_workers, mp_context=get_context("spawn"), initializer=_worker_init
        )

    async def start(self) -> None:
        if self._workers:
            return
        self._cleanup(force=True)
        if self._executor is None:
            self._executor = self._new_executor()
        self._workers = [asyncio.create_task(self._worker(i)) for i in range(self.settings.ml_workers)]
        log.info("runner_started", workers=self.settings.ml_workers, executor=self.settings.ml_executor)

    async def stop(self) -> None:
        # Рабочие процессы — главы своих групп (`_worker_init`), и Ctrl+C терминала до них не доходит:
        # идущие задачи убиваем сами, иначе в локальном режиме процессы досчитывали бы после остановки ml.
        for record in list(self._jobs.values()):
            if record.state == "RUNNING":
                self._kill_worker(self._pid_file(record.message_id))
        for task in self._workers:
            task.cancel()
        for task in self._workers:
            with suppress(asyncio.CancelledError):
                await task
        self._workers.clear()
        if self._executor is not None and self._external_executor is None:
            self._executor.shutdown(wait=False, cancel_futures=True)
            self._executor = None
        await self.callback.aclose()
        log.info("runner_stopped")

    # --- приём задач ----------------------------------------------------

    def submit(self, envelope: dict[str, Any]) -> dict[str, Any]:
        """Поставить задачу в очередь. Повтор того же `message_id` работу не дублирует."""
        message_id = str(envelope["message_id"])
        existing = self._jobs.get(message_id)
        if existing is not None:
            log.info("job_duplicate", message_id=message_id, state=existing.state)
            return existing.as_state()
        stored = self._load(message_id)
        if stored is not None:  # задача уже выполнена до перезапуска ml или вытеснена из памяти
            log.info("job_duplicate", message_id=message_id, state=stored["state"], stored=True)
            return stored

        record = JobRecord(message_id=message_id, envelope=envelope)
        self._jobs[message_id] = record
        self._queue.put_nowait(message_id)
        JOBS_QUEUED.set(self._queue.qsize())
        log.info("job_queued", message_id=message_id, type=envelope["type"])
        return record.as_state()

    def state(self, message_id: str) -> dict[str, Any] | None:
        record = self._jobs.get(str(message_id))
        return record.as_state() if record else self._load(str(message_id))

    @property
    def queue_size(self) -> int:
        return self._queue.qsize()

    # --- выполнение -----------------------------------------------------

    async def _worker(self, index: int) -> None:
        while True:
            message_id = await self._queue.get()
            JOBS_QUEUED.set(self._queue.qsize())
            record = self._jobs[message_id]
            with request_context(message_id):
                try:
                    await self._execute(record)
                except asyncio.CancelledError:
                    raise
                except Exception:  # воркер не должен умирать из-за одной задачи
                    log.exception("job_worker_error", worker=index, message_id=message_id)
                finally:
                    self._queue.task_done()

    def _timeout_for(self, envelope: dict[str, Any]) -> float:
        options = (envelope.get("payload") or {}).get("options") or {}
        return float(options.get("timeout_s") or self.settings.ml_job_timeout_s)

    async def _execute(self, record: JobRecord) -> None:
        envelope = record.envelope
        job_type = envelope["type"]
        handler = HANDLERS[job_type]
        record.state = "RUNNING"
        started = time.monotonic()
        pid_file = self._pid_file(record.message_id)

        try:
            payload = await self._run_with_retry(record, handler, pid_file)
            outcome = payload.get("status", "OK")
        except TimeoutError:
            payload = _failure_payload(
                envelope,
                self.settings,
                {"code": "TIMEOUT", "message": "Задача не уложилась в отведённое время", "retryable": True},
            )
            outcome = "TIMEOUT"
            log.error("job_timeout", message_id=record.message_id, type=job_type)
            self._kill_worker(pid_file)
            self._recycle_executor()
        except Exception as exc:  # любая внутренняя ошибка уходит в результат, а не в трассировку
            payload = _failure_payload(
                envelope,
                self.settings,
                {"code": "INTERNAL", "message": f"{type(exc).__name__}: {exc}", "retryable": True},
            )
            outcome = "INTERNAL"
            log.exception("job_failed", message_id=record.message_id, type=job_type)
        finally:
            if pid_file is not None:
                with suppress(OSError):
                    pid_file.unlink(missing_ok=True)

        duration = time.monotonic() - started
        JOB_DURATION.labels(type=job_type).observe(duration)
        JOBS.labels(type=job_type, outcome=outcome).inc()

        record.result = result_envelope(envelope, payload)
        record.state = "DONE" if outcome == "OK" else "FAILED"
        record.progress = 100
        record.finished_at = time.monotonic()
        # большой результат сравнения пишется долго — не в цикле событий, иначе встают /health и GET /v1/jobs
        await asyncio.to_thread(self._store, record)
        log.info(
            "job_finished",
            message_id=record.message_id,
            type=job_type,
            outcome=outcome,
            duration_ms=round(duration * 1000),
        )

        reply_to = envelope.get("reply_to")
        if reply_to:
            if origin(reply_to) in self._allowed:
                await self.callback.send(reply_to, record.result)
            else:
                CALLBACKS.labels(outcome="rejected").inc()
                log.warning("callback_rejected", message_id=record.message_id, reply_to=reply_to)
        self._evict()
        self._cleanup()

    async def _run_with_retry(
        self, record: JobRecord, handler: Callable[..., dict[str, Any]], pid_file: Path | None
    ) -> dict[str, Any]:
        """Выполнить задачу; если её пул сломался — ещё раз в новом.

        Пул ломается двумя путями. Мы сами убили чужой зависший процесс и уже пересоздали пул: поколение
        поменялось, просто повторяем. Или процесс умер без нас: ядро убило его по нехватке памяти, он упал в
        paddle или torch. Тогда поколение прежнее, и пул пересоздаём здесь — иначе все следующие задачи
        падали бы `INTERNAL` до ручного перезапуска ml, а `/health` оставался бы зелёным.
        Повтор — один: задача, которая сама роняет процесс, второй раз уходит в `INTERNAL`, но пул после неё
        снова целый.
        """
        loop = asyncio.get_running_loop()
        timeout = self._timeout_for(record.envelope)
        for attempt in (1, 2):
            generation = self._generation
            future = loop.run_in_executor(
                self._executor,
                _run,
                handler,
                self._settings_data,
                record.envelope["payload"],
                str(pid_file) if pid_file else None,
            )
            try:
                return await asyncio.wait_for(future, timeout=timeout)
            except BrokenProcessPool:
                if generation == self._generation:
                    log.error("executor_broken", message_id=record.message_id, attempt=attempt)
                    self._recycle_executor()
                if attempt == 1:
                    log.warning("job_restarted_after_pool_recycle", message_id=record.message_id)
                    continue
                raise
        raise AssertionError("недостижимо")

    def _pid_file(self, message_id: str) -> Path | None:
        """Куда рабочий процесс запишет свой PID. Только для своего пула процессов: в потоках убивать нечего."""
        if self.settings.ml_executor != "process" or self._external_executor is not None:
            return None
        if not SAFE_ID.fullmatch(message_id):
            return None
        self._jobs_dir.mkdir(parents=True, exist_ok=True)
        return self._jobs_dir / f"{message_id}.pid"

    def _kill_worker(self, pid_file: Path | None) -> None:
        """Убить процесс зависшей задачи: иначе он доедает процессор стенда, а пул лишь пересоздаётся."""
        if pid_file is None:
            return
        try:
            pid = int(pid_file.read_text(encoding="ascii").strip())
        except (OSError, ValueError):
            return  # задача ещё не начала выполняться — убивать нечего
        _kill(pid)
        log.warning("job_process_killed", pid=pid)

    def _recycle_executor(self) -> None:
        """После таймаута пул пересоздаётся: зависшая задача не должна занимать воркера навсегда.

        Процесс зависшей задачи убит (`_kill_worker`), и старый пул от этого сломан: задачи, которые
        в нём ещё шли, получат `BrokenProcessPool` и один раз перезапустятся в новом пуле.
        """
        if self._external_executor is not None or self._executor is None:
            return
        old, self._executor = self._executor, self._new_executor()
        self._generation += 1
        old.shutdown(wait=False, cancel_futures=True)
        log.warning("executor_recycled")

    # --- хранение результатов --------------------------------------------

    def _result_path(self, message_id: str) -> Path | None:
        return self._jobs_dir / f"{message_id}.json" if SAFE_ID.fullmatch(message_id) else None

    def _store(self, record: JobRecord) -> None:
        """Результат — на диск: переживает перезапуск ml и не держит память."""
        path = self._result_path(record.message_id)
        if path is None:
            return
        try:
            self._jobs_dir.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(".tmp")
            temporary.write_text(json.dumps(record.as_state(), ensure_ascii=False), encoding="utf-8")
            temporary.replace(path)
            record.stored = True
        except OSError as exc:  # диск — вторая копия; без неё результат всё равно лежит в памяти
            log.warning("job_store_failed", message_id=record.message_id, reason=str(exc))

    def _load(self, message_id: str) -> dict[str, Any] | None:
        path = self._result_path(message_id)
        if path is None or not path.is_file():
            return None
        try:
            if time.time() - path.stat().st_mtime > self.settings.ml_job_ttl_s:
                return None
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def _evict(self) -> None:
        """В памяти — не больше `ML_JOB_MEMORY_MAX` готовых задач, самые старые читаются с диска."""
        finished = [r for r in self._jobs.values() if r.finished_at is not None]
        extra = len(finished) - self.settings.ml_job_memory_max
        if extra <= 0:
            return
        for record in sorted(finished, key=lambda r: r.finished_at or 0.0)[:extra]:
            if record.stored:  # без копии на диске не вытесняем: иначе результат пропал бы совсем
                self._jobs.pop(record.message_id, None)

    def _cleanup(self, *, force: bool = False) -> None:
        """Стереть с диска результаты старше `ML_JOB_TTL_S` и забытые файлы PID."""
        now = time.monotonic()
        if not force and now - self._last_cleanup < CLEANUP_EVERY_S:
            return
        self._last_cleanup = now
        if not self._jobs_dir.is_dir():
            return
        deadline = time.time() - self.settings.ml_job_ttl_s
        removed = 0
        for path in self._jobs_dir.iterdir():
            with suppress(OSError):
                if path.stat().st_mtime < deadline:
                    path.unlink()
                    removed += 1
        if removed:
            log.info("job_results_cleaned", removed=removed)
