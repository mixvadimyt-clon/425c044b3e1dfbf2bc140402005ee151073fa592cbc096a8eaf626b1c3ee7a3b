"""Перенос кеша разбора между машинами ([ADR-0007](../../../../docs/adr/0007-stand-cpu-precomputed-cache.md)).

Стенд работает без GPU, а OCR на процессоре занимает около минуты на страницу. Поэтому тяжёлый
разбор считается заранее на видеокарте и переносится на стенд архивом: те же файлы (тот же
`sha256` и та же `PARSER_VERSION`) отвечают из кеша сразу, новые разбираются на месте.

Это **кеш по содержимому**, а не заготовленные ответы: в архиве лежит ровно то, что стенд
посчитал бы сам, только медленнее. `force_reparse` считает заново в любом случае.

Формат — `tar.gz`: внутри `manifest.json` и записи `parsed/{sha256}/{version}.json`.
Индекс `CACHE_DIR` в архив не кладём — он восстанавливается из манифеста при загрузке,
иначе пришлось бы держать в архиве две копии одних и тех же сведений.
"""

from __future__ import annotations

import io
import json
import tarfile
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from inspector_ml import __version__
from inspector_ml.logging import get_logger
from inspector_ml.storage.cache import PARSED_PREFIX, CacheEntry, ParsedCache
from inspector_ml.storage.files import long_path

MANIFEST = "manifest.json"
ARCHIVE_FORMAT = 1

log = get_logger(__name__)


class ArchiveError(Exception):
    """Архив не читается или собран другой версией формата."""


@dataclass(frozen=True)
class ArchiveItem:
    """Запись архива: разобранный документ и его размеры."""

    sha256: str
    parser_version: str
    pages: int
    size_bytes: int

    @property
    def name(self) -> str:
        return ParsedCache.storage_key(self.sha256, self.parser_version)


def entries(cache: ParsedCache, *, parser_version: str | None = None) -> list[ArchiveItem]:
    """Что лежит в кеше разбора. `parser_version=None` — все версии.

    Источник правды — сами файлы разбора, а не индекс: индекс из него выводится, и если он
    отстал (например, каталог переносили руками), выгрузка всё равно будет полной.
    """
    root = long_path(cache.storage_dir / PARSED_PREFIX)
    if not root.is_dir():
        return []

    items: list[ArchiveItem] = []
    for path in sorted(root.glob("*/*.json")):
        version = path.stem
        if parser_version is not None and version != parser_version:
            continue
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            log.warning("cache_entry_unreadable", path=str(path))
            continue
        items.append(
            ArchiveItem(
                sha256=path.parent.name,
                parser_version=version,
                pages=len(document.get("pages") or []),
                size_bytes=path.stat().st_size,
            )
        )
    return items


def export_cache(cache: ParsedCache, archive: Path, *, parser_version: str | None = None) -> dict[str, Any]:
    """Собрать кеш разбора в архив. Возвращает отчёт для CLI."""
    items = entries(cache, parser_version=parser_version)
    if not items:
        raise ArchiveError("В кеше нет разобранных документов — сначала выполните разбор")

    manifest = {
        "format": ARCHIVE_FORMAT,
        "created_at": datetime.now(UTC).isoformat(),
        "tool_version": __version__,
        "parser_versions": sorted({item.parser_version for item in items}),
        "items": [asdict(item) for item in items],
    }

    archive.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")
    with tarfile.open(long_path(archive), "w:gz") as tar:
        info = tarfile.TarInfo(MANIFEST)
        info.size = len(payload)
        tar.addfile(info, io.BytesIO(payload))
        for item in items:
            tar.add(long_path(cache.storage_dir / item.name), arcname=item.name)

    return {
        "archive": str(archive),
        "files": len(items),
        "pages": sum(item.pages for item in items),
        "parsed_bytes": sum(item.size_bytes for item in items),
        "archive_bytes": archive.stat().st_size,
        "parser_versions": manifest["parser_versions"],
    }


def import_cache(cache: ParsedCache, archive: Path) -> dict[str, Any]:
    """Загрузить кеш из архива. Идемпотентно: уже разобранные документы не трогаются."""
    added: list[ArchiveItem] = []
    skipped = 0

    with tarfile.open(long_path(archive), "r:gz") as tar:
        manifest = _manifest(tar)
        for item in (ArchiveItem(**raw) for raw in manifest["items"]):
            target = cache.parsed_path(item.sha256, item.parser_version)
            if long_path(target).exists():
                skipped += 1
                continue
            member = tar.getmember(item.name)
            target.parent.mkdir(parents=True, exist_ok=True)
            source = tar.extractfile(member)
            if source is None:  # pragma: no cover — в архиве только обычные файлы
                continue
            long_path(target).write_bytes(source.read())
            _write_index(cache, item, manifest["created_at"])
            added.append(item)

    return {
        "archive": str(archive),
        "added": len(added),
        "skipped": skipped,
        "pages": sum(item.pages for item in added),
        "parser_versions": manifest["parser_versions"],
    }


def _manifest(tar: tarfile.TarFile) -> dict[str, Any]:
    try:
        source = tar.extractfile(MANIFEST)
    except KeyError as exc:
        raise ArchiveError(f"В архиве нет {MANIFEST} — это не архив кеша разбора") from exc
    if source is None:  # pragma: no cover — манифест всегда обычный файл
        raise ArchiveError(f"{MANIFEST} не читается")

    manifest = json.loads(source.read().decode("utf-8"))
    if manifest.get("format") != ARCHIVE_FORMAT:
        raise ArchiveError(f"Формат архива {manifest.get('format')!r}, ожидается {ARCHIVE_FORMAT}")
    return manifest


def _write_index(cache: ParsedCache, item: ArchiveItem, created_at: str) -> None:
    """Запись индекса `CACHE_DIR` — та же, что создал бы разбор на этой машине."""
    entry = CacheEntry(
        sha256=item.sha256,
        parser_version=item.parser_version,
        key=item.name,
        pages=item.pages,
        size_bytes=item.size_bytes,
        created_at=created_at,
    )
    index = cache.index_path(item.sha256, item.parser_version)
    index.parent.mkdir(parents=True, exist_ok=True)
    long_path(index).write_text(json.dumps(asdict(entry), ensure_ascii=False), encoding="utf-8")


def stats(cache: ParsedCache, *, parser_version: str | None = None) -> dict[str, Any]:
    """Что уже разобрано на этой машине — чтобы понимать, сколько осталось до предрасчёта."""
    items = entries(cache, parser_version=parser_version)
    by_version: dict[str, dict[str, int]] = {}
    for item in items:
        bucket = by_version.setdefault(item.parser_version, {"files": 0, "pages": 0, "bytes": 0})
        bucket["files"] += 1
        bucket["pages"] += item.pages
        bucket["bytes"] += item.size_bytes
    return {
        "storage_dir": str(cache.storage_dir),
        "files": len(items),
        "pages": sum(item.pages for item in items),
        "parsed_bytes": sum(item.size_bytes for item in items),
        "by_parser_version": by_version,
    }
