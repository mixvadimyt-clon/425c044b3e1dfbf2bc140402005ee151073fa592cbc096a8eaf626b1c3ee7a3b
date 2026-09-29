"""Общие помощники тестов задач: подготовка хранилища и конверты сообщений."""

from __future__ import annotations

import shutil
import time
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi.testclient import TestClient

from inspector_ml.config import Settings
from inspector_ml.storage.files import sha256_of

REPLY_TO = "http://api.test/internal/ml/results"
PROCESS_ID = "0b6e7f52-1d8e-4a8b-9d55-3a2f1f0c9e10"
OBJECT_ID = "6f1c1c9e-6c38-4d7e-9c1a-2f0f4b0b7a01"


def store(settings: Settings, source: Path) -> tuple[str, str]:
    """Положить файл в STORAGE_DIR, как это делает api. Возвращает sha256 и ключ S3Ref."""
    sha = sha256_of(source)
    key = f"raw/{sha}"
    target = settings.storage_dir / key
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    return sha, key


def parse_envelope(sha: str, key: str, *, name: str = "ПЗ.pdf", size: int = 1024, **options: Any) -> dict[str, Any]:
    return {
        "message_id": str(uuid4()),
        "type": "ml.parse.request",
        "schema_version": "0.4.0",
        "correlation_id": PROCESS_ID,
        "reply_to": REPLY_TO,
        "attempt": 1,
        "created_at": "2026-09-19T08:00:00Z",
        "payload": {
            "process_id": PROCESS_ID,
            "object_id": OBJECT_ID,
            "file": {
                "file_id": str(uuid4()),
                "sha256": sha,
                "format": "PDF",
                "source": {"bucket": "local", "key": key},
                "original_name": name,
                "size_bytes": size,
            },
            **({"options": options} if options else {}),
        },
    }


def wait_for_job(client: TestClient, message_id: str, *, timeout: float = 10.0) -> dict[str, Any]:
    """Дождаться завершения задачи (очередь работает в фоне)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        state = client.get(f"/v1/jobs/{message_id}").json()
        if state["state"] in {"DONE", "FAILED"}:
            return state
        time.sleep(0.02)
    raise AssertionError(f"задача {message_id} не завершилась за {timeout} с")


def submit(client: TestClient, envelope: dict[str, Any]) -> dict[str, Any]:
    response = client.post("/v1/jobs", json=envelope)
    assert response.status_code == 202, response.text
    return response.json()


# --- обработчики для проверки пула процессов: должны лежать в модуле, чтобы их можно было передать
# --- в рабочий процесс (spawn передаёт функцию по имени модуля)


def hang(settings: dict[str, Any], _payload: dict[str, Any]) -> dict[str, Any]:
    """Зависшая задача: записывает PID и спит, пока её не убьют."""
    import os

    Path(settings["cache_dir"], "hang.pid").write_text(str(os.getpid()), encoding="ascii")
    time.sleep(600)
    return {"status": "OK"}


def hang_or_slow(settings: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """Файл с sha256 на «a» зависает; остальные работают 15 секунд — дольше таймаута зависшей — и отмечают
    каждый свой запуск, чтобы тест видел перезапуск после поломки пула."""
    import os

    file = payload["file"]
    if file["sha256"].startswith("a"):
        return hang(settings, payload)
    with Path(settings["cache_dir"], "slow.starts").open("a", encoding="ascii") as starts:
        starts.write(f"{os.getpid()} ")
    time.sleep(15)
    return {
        "process_id": payload["process_id"],
        "file_id": file["file_id"],
        "sha256": file["sha256"],
        "status": "FAILED",
        "error": {"code": "SLOW_DONE", "message": "отработала до конца", "retryable": False},
        "parser_version": settings["parser_version"],
    }


def _quick_result(settings: dict[str, Any], payload: dict[str, Any], code: str) -> dict[str, Any]:
    file = payload["file"]
    return {
        "process_id": payload["process_id"],
        "file_id": file["file_id"],
        "sha256": file["sha256"],
        "status": "FAILED",
        "error": {"code": code, "message": "задача дошла до конца", "retryable": False},
        "parser_version": settings["parser_version"],
    }


def hang_once(settings: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """Первый запуск зависает и ждёт, пока процесс убьют снаружи (как ядро по нехватке памяти); следующие
    отвечают сразу."""
    import os

    marker = Path(settings["cache_dir"], "hang_once.started")
    if not marker.exists():
        marker.write_text("1", encoding="ascii")
        Path(settings["cache_dir"], "hang.pid").write_text(str(os.getpid()), encoding="ascii")
        time.sleep(600)
    return _quick_result(settings, payload, "AFTER_KILL")


def crash_or_quick(settings: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """Файл с sha256 на «d» роняет рабочий процесс при каждом запуске (как падение в paddle или torch),
    остальные отвечают сразу."""
    import os

    if payload["file"]["sha256"].startswith("d"):
        os._exit(1)
    return _quick_result(settings, payload, "QUICK")
