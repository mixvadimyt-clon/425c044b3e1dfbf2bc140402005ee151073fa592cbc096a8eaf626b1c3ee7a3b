"""Общие фикстуры тестов."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from pathlib import Path

import pymupdf
import pytest
from fastapi.testclient import TestClient

from inspector_ml.api.app import create_app
from inspector_ml.config import Settings, get_settings

# Встроенные шрифты PyMuPDF кириллицу не рисуют: в тексте она есть, а в растре — нет.
# Для тестов OCR нужен настоящий шрифт с кириллицей, ищем его среди системных.
CYRILLIC_FONTS = (
    Path("C:/Windows/Fonts/arial.ttf"),
    Path("C:/Windows/Fonts/segoeui.ttf"),
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    Path("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"),
    Path("/usr/share/fonts/TTF/DejaVuSans.ttf"),
)


def cyrillic_font() -> Path | None:
    """Первый найденный системный шрифт с кириллицей или `None`."""
    return next((path for path in CYRILLIC_FONTS if path.exists()), None)


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    """Настройки без чтения ``.env``: хранилище и кеш — во временной папке.

    Задачи выполняются в потоках: в тестах не нужен запуск процессов (на Windows он медленный),
    а поведение очереди от этого не зависит.
    """
    return Settings(
        _env_file=None,
        storage_dir=tmp_path / "storage",
        cache_dir=tmp_path / "cache",
        ml_workers=1,
        ml_executor="thread",
        api_url="http://api.test",  # тот же адрес, что в REPLY_TO: результат можно слать только api
    )


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    get_settings.cache_clear()
    with TestClient(create_app(settings)) as test_client:
        yield test_client
    get_settings.cache_clear()


@pytest.fixture
def make_pdf(tmp_path: Path) -> Callable[..., Path]:
    """Собрать небольшой PDF: текст в левом верхнем углу каждой страницы."""

    def factory(
        name: str = "sample.pdf",
        *,
        pages: int = 1,
        rotation: int = 0,
        width: float = 400,
        height: float = 600,
        cropbox: tuple[float, float, float, float] | None = None,
        text: str = "Общая площадь здания 3009,4 м2",
        empty: bool = False,
    ) -> Path:
        document = pymupdf.open()
        font = cyrillic_font()
        for index in range(pages):
            page = document.new_page(width=width, height=height)
            if not empty:
                body = f"{text} — лист {index + 1}"
                if font is not None:
                    page.insert_text((40, 60), body, fontsize=11, fontname="ru", fontfile=str(font))
                else:  # pragma: no cover — на машине нет ни одного шрифта с кириллицей
                    page.insert_text((40, 60), body, fontsize=11)
            if cropbox is not None:
                page.set_cropbox(pymupdf.Rect(*cropbox))
            if rotation:
                page.set_rotation(rotation)
        path = tmp_path / name
        document.save(path)
        document.close()
        return path

    return factory


@pytest.fixture(autouse=True)
def _fresh_ocr_engine() -> Iterator[None]:
    """Движок OCR кешируется на процесс — между тестами кеш сбрасываем.

    Иначе тест, подменивший движок или настройки, отдаст свой экземпляр следующему.
    """
    from inspector_ml.ocr.engines import build_engine

    build_engine.cache_clear()
    yield
    build_engine.cache_clear()
