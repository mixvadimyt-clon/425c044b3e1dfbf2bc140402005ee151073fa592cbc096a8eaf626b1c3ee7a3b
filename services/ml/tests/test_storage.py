"""Хранилище и кеш разбора (REQ-PRS-07)."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from pathlib import Path

import pytest

from inspector_ml.config import Settings
from inspector_ml.storage.cache import ParsedCache
from inspector_ml.storage.files import UnsupportedBucketError, reachable, resolve_ref, sha256_of

DOCUMENT = {"sha256": "abc", "parser_version": "0.1.0", "format": "PDF", "pages": [{"page": 1}, {"page": 2}]}


def test_resolve_ref_builds_path(settings: Settings) -> None:
    assert resolve_ref(settings.storage_dir, "local", "raw/abc") == settings.storage_dir / "raw" / "abc"


def test_resolve_ref_rejects_remote_bucket(settings: Settings) -> None:
    with pytest.raises(UnsupportedBucketError):
        resolve_ref(settings.storage_dir, "inspector", "raw/abc")


def test_resolve_ref_rejects_escape(settings: Settings) -> None:
    """Ключ из сообщения не должен уводить чтение за пределы хранилища."""
    with pytest.raises(UnsupportedBucketError):
        resolve_ref(settings.storage_dir, "local", "../../secrets.env")


def test_sha256_of(tmp_path: Path) -> None:
    payload = b"inspector" * 200_000  # больше одного читаемого блока
    path = tmp_path / "file.bin"
    path.write_bytes(payload)

    assert sha256_of(path) == hashlib.sha256(payload).hexdigest()


def test_cache_put_and_get(settings: Settings) -> None:
    cache = ParsedCache(settings.storage_dir, settings.cache_dir)

    key = cache.put("abc", "0.1.0", DOCUMENT)

    assert key == "parsed/abc/0.1.0.json"
    assert cache.get("abc", "0.1.0") == DOCUMENT
    assert cache.load_by_key(key) == DOCUMENT


def test_cache_miss_on_other_version(settings: Settings) -> None:
    """PARSER_VERSION в ключе: после изменения разбора старые записи не находятся."""
    cache = ParsedCache(settings.storage_dir, settings.cache_dir)
    cache.put("abc", "0.1.0", DOCUMENT)

    assert cache.get("abc", "0.2.0") is None
    assert cache.get("other", "0.1.0") is None


def test_cache_writes_index(settings: Settings) -> None:
    cache = ParsedCache(settings.storage_dir, settings.cache_dir)
    cache.put("abc", "0.1.0", DOCUMENT)

    entry = json.loads(cache.index_path("abc", "0.1.0").read_text(encoding="utf-8"))

    assert entry["key"] == "parsed/abc/0.1.0.json"
    assert entry["pages"] == 2
    assert entry["created_at"]


def test_cache_survives_broken_json(settings: Settings) -> None:
    """Обрезанный файл кеша считается промахом, а не ошибкой разбора."""
    cache = ParsedCache(settings.storage_dir, settings.cache_dir)
    path = cache.parsed_path("abc", "0.1.0")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('{"pages": [', encoding="utf-8")

    assert cache.get("abc", "0.1.0") is None


def test_cache_roundtrip_with_real_document(settings: Settings, make_pdf: Callable[..., Path]) -> None:
    from inspector_ml.ingest.pdf import parse_pdf

    cache = ParsedCache(settings.storage_dir, settings.cache_dir)
    path = make_pdf(pages=2)
    parsed = parse_pdf(path, sha256_of(path), "0.1.0")

    key = cache.put(parsed["sha256"], "0.1.0", parsed)

    assert cache.load_by_key(key) == parsed


class TestReachable:
    """Путь длиннее предела Linux — не ошибка обхода, а недоступный файл."""

    def test_existing_file(self, tmp_path: Path) -> None:
        path = tmp_path / "есть.pdf"
        path.write_bytes(b"%PDF-1.7")

        assert reachable(path) is True

    def test_missing_file(self, tmp_path: Path) -> None:
        assert reachable(tmp_path / "нет.pdf") is False

    def test_directory_is_not_a_file(self, tmp_path: Path) -> None:
        assert reachable(tmp_path) is False

    def test_too_long_name_is_not_an_error(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """В Linux предел — 255 байт на элемент пути, и `stat` кидает ENAMETOOLONG.

        В выгрузке организаторов такой каталог есть: раздел 10.1 про энергоэффективность,
        310 байт, файл F0152. Обход корпуса из-за него падал.
        """

        def boom(_self: Path) -> bool:
            raise OSError(36, "File name too long")

        monkeypatch.setattr(Path, "is_file", boom)

        assert reachable(tmp_path / ("х" * 200)) is False
