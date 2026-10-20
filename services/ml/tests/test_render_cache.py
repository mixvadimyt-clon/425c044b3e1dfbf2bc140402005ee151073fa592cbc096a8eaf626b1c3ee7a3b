"""Кеш растров страниц для CV."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

import pymupdf
import pytest

from inspector_ml.config import Settings
from inspector_ml.cv.render import RenderCache, page_image, warm_document
from inspector_ml.precompute import warm_renders

SHA = "a" * 64


def cache_of(settings: Settings) -> RenderCache:
    return RenderCache(settings.storage_dir)


class TestKey:
    def test_dpi_is_part_of_the_key(self) -> None:
        """Иначе смена настройки молча отдавала бы картинку не того разрешения."""
        assert RenderCache.storage_key(SHA, 3, 150) != RenderCache.storage_key(SHA, 3, 50)

    def test_page_numbers_are_padded(self) -> None:
        """Чтобы каталог сортировался по порядку листов, а не как «1, 10, 2»."""
        assert RenderCache.storage_key(SHA, 7, 150).endswith("/0007.png")


class TestCache:
    def test_a_miss_returns_nothing(self, settings: Settings) -> None:
        assert cache_of(settings).get(SHA, 1, 150) is None

    def test_what_was_put_comes_back(self, settings: Settings, make_pdf: Callable[..., Path]) -> None:
        cache = cache_of(settings)
        source = make_pdf(pages=2)

        first = page_image(cache, SHA, source, 1, dpi=72, max_px=4000)
        again = cache.get(SHA, 1, 72)

        assert again is not None
        assert again.shape == first.shape
        assert again.ndim == 2  # оттенки серого, без цветовых каналов

    def test_the_second_call_does_not_touch_the_pdf(self, settings: Settings, make_pdf: Callable[..., Path]) -> None:
        """Ради этого кеш и заведён: лист за проверку просят несколько раз."""
        cache = cache_of(settings)
        source = make_pdf()
        page_image(cache, SHA, source, 1, dpi=72, max_px=4000)
        source.unlink()

        assert page_image(cache, SHA, source, 1, dpi=72, max_px=4000) is not None

    def test_a_truncated_file_is_a_miss_not_a_crash(self, settings: Settings, make_pdf: Callable[..., Path]) -> None:
        """Обрыв прогона не должен оставить картинку, которая читается как попадание."""
        cache = cache_of(settings)
        page_image(cache, SHA, make_pdf(), 1, dpi=72, max_px=4000)
        cache.path(SHA, 1, 72).write_bytes(b"\x89PNG\r\n")

        assert cache.get(SHA, 1, 72) is None

    def test_stats_count_pages_by_resolution(self, settings: Settings, make_pdf: Callable[..., Path]) -> None:
        cache = cache_of(settings)
        source = make_pdf(pages=3)
        list(warm_document(cache, SHA, source, dpi=72, max_px=4000))
        list(warm_document(cache, SHA, source, [1], dpi=36, max_px=4000))

        report = cache.stats()

        assert report["documents"] == 1
        assert report["pages"] == 4
        assert report["by_dpi"] == {"36": 1, "72": 3}
        assert report["size_bytes"] > 0

    def test_clear_removes_one_document(self, settings: Settings, make_pdf: Callable[..., Path]) -> None:
        cache = cache_of(settings)
        source = make_pdf(pages=2)
        list(warm_document(cache, SHA, source, dpi=72, max_px=4000))
        list(warm_document(cache, "b" * 64, source, dpi=72, max_px=4000))

        assert cache.clear(SHA) == 2
        assert cache.stats()["documents"] == 1


class TestWarmDocument:
    def test_renders_every_page_once(self, settings: Settings, make_pdf: Callable[..., Path]) -> None:
        cache = cache_of(settings)
        source = make_pdf(pages=3)

        first = list(warm_document(cache, SHA, source, dpi=72, max_px=4000))
        again = list(warm_document(cache, SHA, source, dpi=72, max_px=4000))

        assert [page for page, _size in first] == [1, 2, 3]
        assert again == []  # повторный прогон ничего не переделывает

    def test_page_numbers_outside_the_document_are_skipped(
        self, settings: Settings, make_pdf: Callable[..., Path]
    ) -> None:
        cache = cache_of(settings)

        rendered = list(warm_document(cache, SHA, make_pdf(pages=2), [1, 5], dpi=72, max_px=4000))

        assert [page for page, _size in rendered] == [1]

    def test_the_long_side_is_capped(self, settings: Settings, make_pdf: Callable[..., Path]) -> None:
        """Лист A0 при 300 dpi — это 14 000 пикселей по длинной стороне и гигабайты в памяти."""
        cache = cache_of(settings)
        source = make_pdf(width=2384, height=1684)

        image = page_image(cache, SHA, source, 1, dpi=300, max_px=1000)

        assert max(image.shape) == 1000


class TestWarmRenders:
    def test_walks_the_folder_and_reports(
        self, settings: Settings, make_pdf: Callable[..., Path], tmp_path: Path
    ) -> None:
        make_pdf("один.pdf", pages=2)
        make_pdf("два.pdf", pages=1)

        report = warm_renders(tmp_path, cache_of(settings), dpi=72, max_px=4000).as_dict()

        assert report["documents"] == 2
        assert report["pages_rendered"] == 3
        assert report["failed"] == 0
        assert report["size_bytes"] > 0

    def test_max_pages_limits_each_document(
        self, settings: Settings, make_pdf: Callable[..., Path], tmp_path: Path
    ) -> None:
        """В ИД встречаются сканы на девятьсот листов — целиком их рисовать незачем."""
        make_pdf("толстый.pdf", pages=5)

        report = warm_renders(tmp_path, cache_of(settings), dpi=72, max_px=4000, max_pages=2).as_dict()

        assert report["pages_rendered"] == 2

    def test_a_broken_pdf_does_not_stop_the_run(
        self, settings: Settings, make_pdf: Callable[..., Path], tmp_path: Path
    ) -> None:
        make_pdf("целый.pdf", pages=1)
        (tmp_path / "битый.pdf").write_bytes("%PDF-1.7 и дальше мусор".encode())

        report = warm_renders(tmp_path, cache_of(settings), dpi=72, max_px=4000).as_dict()

        assert report["pages_rendered"] == 1
        assert report["failed"] == 1

    def test_closed_materials_are_skipped(
        self, settings: Settings, make_pdf: Callable[..., Path], tmp_path: Path
    ) -> None:
        """Закрытые материалы организатора не трогаем."""
        closed = tmp_path / "ОРГАНИЗАТОР_ЗАКРЫТЫЙ"
        closed.mkdir()
        document = pymupdf.open()
        document.new_page(width=200, height=200)
        document.save(closed / "секрет.pdf")
        document.close()

        report = warm_renders(tmp_path, cache_of(settings), dpi=72, max_px=4000).as_dict()

        assert report["files_total"] == 0


class TestClearFromCli:
    """Очистка через CLI: на стенде растры копятся всю экспертизу, а диск там общий."""

    def run(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *args: str) -> int:
        from inspector_ml.cli import main
        from inspector_ml.config import get_settings

        monkeypatch.setenv("STORAGE_DIR", str(tmp_path / "storage"))
        get_settings.cache_clear()
        try:
            return main(["cache", "renders", *args])
        finally:
            get_settings.cache_clear()

    def test_clears_everything(
        self,
        settings: Settings,
        make_pdf: Callable[..., Path],
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        cache = cache_of(settings)
        list(warm_document(cache, SHA, make_pdf(pages=2), dpi=72, max_px=4000))

        assert self.run(tmp_path, monkeypatch, "--clear") == 0

        report = json.loads(capsys.readouterr().out)
        assert report["pages_removed"] == 2
        assert report["freed_bytes"] > 0
        assert cache.stats()["pages"] == 0

    def test_clears_one_document(
        self,
        settings: Settings,
        make_pdf: Callable[..., Path],
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        cache = cache_of(settings)
        source = make_pdf(pages=2)
        list(warm_document(cache, SHA, source, dpi=72, max_px=4000))
        list(warm_document(cache, "b" * 64, source, dpi=72, max_px=4000))

        assert self.run(tmp_path, monkeypatch, "--clear", SHA) == 0

        assert json.loads(capsys.readouterr().out)["pages_removed"] == 2
        assert cache.stats()["documents"] == 1

    def test_a_typo_instead_of_sha256_is_refused(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """Иначе `--clear` молча съел бы путь к папке и отчитался, что удалять нечего."""
        assert self.run(tmp_path, monkeypatch, "--clear", "D:/dataset") == 1
        assert "sha256" in capsys.readouterr().err
