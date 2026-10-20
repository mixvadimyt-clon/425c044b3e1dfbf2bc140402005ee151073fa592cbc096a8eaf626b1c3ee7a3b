"""Кеш разбора документов (REQ-PRS-07).

Ключ — `sha256 + PARSER_VERSION`, значение — `ParsedDocument` в
`{STORAGE_DIR}/parsed/{sha256}/{parser_version}.json`. В `CACHE_DIR` лежит лёгкий индекс:
по нему видно, что уже разобрано, без обхода хранилища.

Повторная загрузка того же файла (в том числе в другую проверку) отвечает из кеша
с `from_cache = true`. `PARSER_VERSION` поднимается при любом изменении разбора,
которое меняет результат, — старые записи просто перестают находиться.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from inspector_ml.storage.files import long_path

PARSED_PREFIX = "parsed"


@dataclass(frozen=True)
class CacheEntry:
    """Запись индекса кеша."""

    sha256: str
    parser_version: str
    key: str
    pages: int
    size_bytes: int
    created_at: str


class ParsedCache:
    """Кеш разобранных документов поверх файловой системы."""

    def __init__(self, storage_dir: Path, cache_dir: Path) -> None:
        self.storage_dir = storage_dir
        self.cache_dir = cache_dir

    @staticmethod
    def storage_key(sha256: str, parser_version: str) -> str:
        """Ключ `S3Ref` для разобранного документа."""
        return f"{PARSED_PREFIX}/{sha256}/{parser_version}.json"

    def parsed_path(self, sha256: str, parser_version: str) -> Path:
        return self.storage_dir / self.storage_key(sha256, parser_version)

    def index_path(self, sha256: str, parser_version: str) -> Path:
        return self.cache_dir / PARSED_PREFIX / f"{sha256}.{parser_version}.json"

    def get(self, sha256: str, parser_version: str) -> dict[str, Any] | None:
        """Разобранный документ из кеша или `None`. Битый JSON считается промахом."""
        path = long_path(self.parsed_path(sha256, parser_version))
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    def put(self, sha256: str, parser_version: str, document: dict[str, Any]) -> str:
        """Сохранить разбор и обновить индекс. Возвращает ключ `S3Ref`."""
        path = self.parsed_path(sha256, parser_version)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(document, ensure_ascii=False)
        _write_atomic(path, payload)

        entry = CacheEntry(
            sha256=sha256,
            parser_version=parser_version,
            key=self.storage_key(sha256, parser_version),
            pages=len(document.get("pages") or []),
            size_bytes=len(payload.encode("utf-8")),
            created_at=datetime.now(UTC).isoformat(),
        )
        index = self.index_path(sha256, parser_version)
        index.parent.mkdir(parents=True, exist_ok=True)
        _write_atomic(index, json.dumps(entry.__dict__, ensure_ascii=False))
        return entry.key

    def load_by_key(self, key: str) -> dict[str, Any] | None:
        """Разобранный документ по ключу `S3Ref` (нужен движку сравнения)."""
        path = long_path(self.storage_dir / key)
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None


def _write_atomic(path: Path, text: str) -> None:
    """Записать файл целиком или никак: рядом во временный файл, потом `replace`.

    Рабочий процесс теперь могут убить посреди записи (таймаут задачи), и полупустой JSON в кеше
    читался бы как промах только до первой ошибки разбора. Имя временного файла — с PID: два процесса могут
    разбирать один и тот же файл одновременно.
    """
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    long_path(temporary).write_text(text, encoding="utf-8")
    long_path(temporary).replace(long_path(path))
