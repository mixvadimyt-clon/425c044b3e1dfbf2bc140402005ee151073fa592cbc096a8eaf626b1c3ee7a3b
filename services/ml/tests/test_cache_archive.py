"""Перенос кеша разбора на стенд (ADR-0007): выгрузка, загрузка, предрасчёт."""

from __future__ import annotations

import json
import os
import tarfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from inspector_ml.config import Settings
from inspector_ml.precompute import EXCLUDED_DIRS, fingerprint, pdf_files, verify_cache, warm_cache
from inspector_ml.storage.archive import ArchiveError, export_cache, import_cache, stats
from inspector_ml.storage.cache import ParsedCache

VERSION = "1.2.3"


@pytest.fixture
def cache(settings: Settings) -> ParsedCache:
    return ParsedCache(settings.storage_dir, settings.cache_dir)


@pytest.fixture
def other_cache(tmp_path: Path) -> ParsedCache:
    """Кеш другой машины — в него загружаем архив."""
    return ParsedCache(tmp_path / "stand-storage", tmp_path / "stand-cache")


def _document(pages: int) -> dict:
    return {
        "sha256": "a" * 64,
        "parser_version": VERSION,
        "format": "PDF",
        "metadata": {},
        "pages": [{"page": n + 1, "blocks": [], "tables": []} for n in range(pages)],
    }


class TestExportImport:
    def test_round_trip(self, cache: ParsedCache, other_cache: ParsedCache, tmp_path: Path) -> None:
        cache.put("a" * 64, VERSION, _document(3))
        cache.put("b" * 64, VERSION, _document(5))
        archive = tmp_path / "cache.tar.gz"

        exported = export_cache(cache, archive, parser_version=VERSION)
        imported = import_cache(other_cache, archive)

        assert exported["files"] == 2
        assert exported["pages"] == 8
        assert imported["added"] == 2
        assert imported["pages"] == 8
        assert other_cache.get("a" * 64, VERSION) == cache.get("a" * 64, VERSION)

    def test_import_is_idempotent(self, cache: ParsedCache, other_cache: ParsedCache, tmp_path: Path) -> None:
        """Повторная загрузка ничего не перезаписывает: на стенде кеш уже мог пополниться."""
        cache.put("a" * 64, VERSION, _document(3))
        archive = tmp_path / "cache.tar.gz"
        export_cache(cache, archive, parser_version=VERSION)
        import_cache(other_cache, archive)

        again = import_cache(other_cache, archive)

        assert again == {"archive": str(archive), "added": 0, "skipped": 1, "pages": 0, "parser_versions": [VERSION]}

    def test_import_restores_the_index(self, cache: ParsedCache, other_cache: ParsedCache, tmp_path: Path) -> None:
        """Индекс CACHE_DIR в архив не кладём — он восстанавливается из манифеста."""
        cache.put("a" * 64, VERSION, _document(4))
        archive = tmp_path / "cache.tar.gz"
        export_cache(cache, archive, parser_version=VERSION)
        import_cache(other_cache, archive)

        index = json.loads(other_cache.index_path("a" * 64, VERSION).read_text(encoding="utf-8"))

        assert index["sha256"] == "a" * 64
        assert index["pages"] == 4
        assert index["key"] == ParsedCache.storage_key("a" * 64, VERSION)

    def test_export_selects_one_parser_version(self, cache: ParsedCache, tmp_path: Path) -> None:
        """На стенд едет только замороженная версия разбора, а не всё, что накопилось."""
        cache.put("a" * 64, VERSION, _document(3))
        cache.put("a" * 64, "0.0.1", _document(3))

        report = export_cache(cache, tmp_path / "cache.tar.gz", parser_version=VERSION)

        assert report["parser_versions"] == [VERSION]
        assert report["files"] == 1

    def test_export_without_cache_explains_why(self, cache: ParsedCache, tmp_path: Path) -> None:
        with pytest.raises(ArchiveError, match="нет разобранных документов"):
            export_cache(cache, tmp_path / "cache.tar.gz")

    def test_import_rejects_a_foreign_archive(self, other_cache: ParsedCache, tmp_path: Path) -> None:
        foreign = tmp_path / "foreign.tar.gz"
        with tarfile.open(foreign, "w:gz") as tar:
            tar.add(tmp_path, arcname="empty")

        with pytest.raises(ArchiveError, match="не архив кеша"):
            import_cache(other_cache, foreign)

    def test_stats_counts_by_version(self, cache: ParsedCache) -> None:
        cache.put("a" * 64, VERSION, _document(3))
        cache.put("b" * 64, "0.0.1", _document(7))

        report = stats(cache)

        assert report["files"] == 2
        assert report["pages"] == 10
        assert report["by_parser_version"][VERSION]["pages"] == 3


class TestWarm:
    def test_parses_and_then_reuses_the_cache(
        self, cache: ParsedCache, tmp_path: Path, make_pdf: Callable[..., Path]
    ) -> None:
        folder = tmp_path / "docs"
        folder.mkdir()
        make_pdf("one.pdf", pages=2).rename(folder / "one.pdf")
        make_pdf("two.pdf", pages=3).rename(folder / "two.pdf")

        first = warm_cache(folder, cache, VERSION)
        second = warm_cache(folder, cache, VERSION)

        assert (first.parsed, first.cached, first.pages) == (2, 0, 5)
        assert (second.parsed, second.cached, second.pages) == (0, 2, 5)

    def test_broken_file_does_not_stop_the_run(
        self, cache: ParsedCache, tmp_path: Path, make_pdf: Callable[..., Path]
    ) -> None:
        """Прогон идёт часами, а в выгрузке организаторов есть обрезанные PDF."""
        folder = tmp_path / "docs"
        folder.mkdir()
        (folder / "broken.pdf").write_bytes(b"%PDF-1.7 not really a pdf")
        make_pdf("good.pdf", pages=2).rename(folder / "good.pdf")

        report = warm_cache(folder, cache, VERSION)

        assert report.parsed == 1
        assert report.failed == 1
        assert report.errors[0]["file"] == "broken.pdf"

    def test_closed_organizer_materials_are_skipped(self, tmp_path: Path, make_pdf: Callable[..., Path]) -> None:
        """Закрытые материалы организатора в кеш стенда не попадают."""
        closed = tmp_path / "docs" / EXCLUDED_DIRS[0]
        closed.mkdir(parents=True)
        make_pdf("secret.pdf").rename(closed / "secret.pdf")
        make_pdf("open.pdf").rename(tmp_path / "docs" / "open.pdf")

        found = [path.name for path in pdf_files(tmp_path / "docs")]

        assert found == ["open.pdf"]

    def test_unreadable_directory_does_not_stop_the_walk(
        self, tmp_path: Path, make_pdf: Callable[..., Path], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Выгрузка на сетевой шаре: длинное имя ломает перечисление каталога, а не отдельный файл.

        В WSL `scandir` папки с элементом длиннее 255 байт обрывается с `EIO`, и раньше такой
        каталог ронял обход целиком — вместе с 46 нормальными PDF, лежавшими в нём по соседству.
        """
        docs = tmp_path / "docs"
        broken, fine = docs / "неперечислимая", docs / "обычная"
        broken.mkdir(parents=True)
        fine.mkdir()
        make_pdf("a.pdf").rename(fine / "a.pdf")

        real_scandir = os.scandir

        def scandir(path: Any = ".") -> Any:
            if str(path) == str(broken):
                raise OSError(5, "Input/output error", str(broken))
            return real_scandir(path)

        monkeypatch.setattr(os, "scandir", scandir)

        assert [path.name for path in pdf_files(docs)] == ["a.pdf"]

    def test_skipped_directory_is_in_the_warm_report(
        self, tmp_path: Path, cache: ParsedCache, make_pdf: Callable[..., Path], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Пропуск виден в итоге прогона, а не только строкой журнала среди тысяч."""
        docs = tmp_path / "docs"
        broken, fine = docs / "неперечислимая", docs / "обычная"
        broken.mkdir(parents=True)
        fine.mkdir()
        make_pdf("a.pdf").rename(fine / "a.pdf")
        real_scandir = os.scandir

        def scandir(path: Any = ".") -> Any:
            if str(path) == str(broken):
                raise OSError(5, "Input/output error", str(broken))
            return real_scandir(path)

        monkeypatch.setattr(os, "scandir", scandir)

        report = warm_cache(docs, cache, VERSION).as_dict()

        assert report["parsed"] == 1
        assert report["skipped"] == 1
        assert report["skipped_paths"][0].startswith(str(broken))
        assert "Input/output error" in report["skipped_paths"][0]


class TestVerify:
    """Сверка кеша с исходными PDF — ею проверяют перенос на стенд."""

    def test_clean_cache_passes(self, cache: ParsedCache, tmp_path: Path, make_pdf: Callable[..., Path]) -> None:
        folder = tmp_path / "docs"
        folder.mkdir()
        make_pdf("one.pdf", pages=2).rename(folder / "one.pdf")
        warm_cache(folder, cache, VERSION)

        report = verify_cache(folder, cache, VERSION, sample=1)

        assert report.as_dict()["ok"] is True
        assert (report.entries, report.matched, report.identical) == (1, 1, 1)

    def test_truncated_entry_is_caught(self, cache: ParsedCache, tmp_path: Path, make_pdf: Callable[..., Path]) -> None:
        """Обрезанный перенос: в кеше меньше страниц, чем в PDF."""
        folder = tmp_path / "docs"
        folder.mkdir()
        source = make_pdf("one.pdf", pages=3)
        source.rename(folder / "one.pdf")
        warm_cache(folder, cache, VERSION)

        sha = next(iter(p.parent.name for p in (cache.storage_dir / "parsed").glob(f"*/{VERSION}.json")))
        document = cache.get(sha, VERSION)
        assert document is not None
        document["pages"] = document["pages"][:1]
        cache.put(sha, VERSION, document)

        report = verify_cache(folder, cache, VERSION)

        assert report.as_dict()["ok"] is False
        assert report.page_mismatch[0]["pages_in_cache"] == 1
        assert report.page_mismatch[0]["pages_in_pdf"] == 3

    def test_entry_without_a_source_file_is_an_orphan(self, cache: ParsedCache, tmp_path: Path) -> None:
        """Запись кеша, которой не соответствует ни один PDF корпуса."""
        folder = tmp_path / "docs"
        folder.mkdir()
        cache.put("c" * 64, VERSION, _document(2))

        report = verify_cache(folder, cache, VERSION)

        assert report.entries == 1
        assert report.matched == 0
        assert report.orphans == ["c" * 16]

    def test_fingerprint_reacts_to_changed_text(self) -> None:
        """Слепок сравнивает содержимое, а не только структуру."""
        first = {"pages": [{"source": "TEXT_LAYER", "blocks": [{"text": "B25"}], "tables": []}]}
        second = {"pages": [{"source": "TEXT_LAYER", "blocks": [{"text": "B30"}], "tables": []}]}

        assert fingerprint(first)["pages"] == fingerprint(second)["pages"]
        assert fingerprint(first)["text_sha256"] != fingerprint(second)["text_sha256"]
