"""Кеш растров страниц — источник картинки для CV.

Наложению листов и поиску различий нужен растр, а на этапе сравнения у движка только
разобранный JSON. Отсюда этот кеш: `renders/{sha256}/{dpi}/{page}.png` в `STORAGE_DIR` рядом с
`parsed/`. Один и тот же лист за проверку запрашивают несколько раз — подпись листа, выравнивание,
diff, повторный просмотр инспектором, — и платить за рендер каждый раз незачем.

**На стенд этот кеш не едет,** в отличие от кеша разбора
([ADR-0007](../../../../docs/adr/0007-stand-cpu-precomputed-cache.md)), и это сознательно.
Разбор переносят потому, что OCR на процессоре стоит около минуты на страницу; рендер же —
чистая растеризация PyMuPDF без моделей, и на 506 листах Речникова это вышло **0.145 с на лист**
(замеры в [docs/services/ml.md](../../../../docs/services/ml.md)). Зато весит он много: те же
листы при 150 dpi заняли 500 КБ каждый, то есть весь корпус — порядка 13 ГБ против 86 МБ у
архива разбора. Поэтому растр считается на месте и по запросу, а кеш только не даёт считать
одно и то же дважды.

Три решения, которые стоит объяснить:

- **`dpi` входит в ключ.** Потребители разные: подписи листа хватает 50 dpi (от 16 КБ на листе A3
  до 260 КБ на A1), а выравниванию и diff нужно 150 — на тех же листах втрое дороже по весу.
  Без dpi в ключе смена настройки молча отдавала бы картинку не того разрешения.
- **Оттенки серого, без альфы.** Вдвое меньше цветного PNG (99 КБ против 187 КБ на листе A3),
  а выравнивание по ORB и разностный diff всё равно работают по яркости.
- **Длинная сторона ограничена `max_px`.** Лист A0 при 300 dpi — это 14 000 пикселей по длинной
  стороне и гигабайты в памяти; предел тот же, что у OCR (`OCR_MAX_PX`).
"""

from __future__ import annotations

import os
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import pymupdf

from inspector_ml.logging import get_logger
from inspector_ml.ocr.render import render_page
from inspector_ml.storage.files import long_path

RENDERS_PREFIX = "renders"

log = get_logger(__name__)


@dataclass(frozen=True)
class RenderCache:
    """Растры страниц на файловой системе.

    Номер страницы — с единицы, как в `ParsedPage.page`, и дополнен нулями до четырёх знаков:
    так содержимое каталога сортируется по порядку листов, а не как «1, 10, 2».
    """

    storage_dir: Path

    @staticmethod
    def storage_key(sha256: str, page: int, dpi: int) -> str:
        """Ключ `S3Ref` для растра страницы."""
        return f"{RENDERS_PREFIX}/{sha256}/{dpi}/{page:04d}.png"

    def path(self, sha256: str, page: int, dpi: int) -> Path:
        return self.storage_dir / self.storage_key(sha256, page, dpi)

    def get(self, sha256: str, page: int, dpi: int) -> np.ndarray | None:
        """Растр из кеша или `None`. Битый файл считается промахом, а не ошибкой."""
        path = long_path(self.path(sha256, page, dpi))
        if not path.exists():
            return None
        image = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
        if image is None:
            log.warning("render_unreadable", sha256=sha256, page=page, dpi=dpi)
        return image

    def put(self, sha256: str, page: int, dpi: int, image: np.ndarray) -> str:
        """Сохранить растр. Возвращает ключ `S3Ref`.

        Пишем через временный файл и переименование: прогон рендеров идёт минутами, и обрыв
        посередине не должен оставить обрезанный PNG — при следующем запуске он выглядел бы
        попаданием в кеш.
        """
        path = self.path(sha256, page, dpi)
        path.parent.mkdir(parents=True, exist_ok=True)
        ok, buffer = cv2.imencode(".png", image)
        if not ok:  # pragma: no cover — imencode для PNG не отказывает
            raise RuntimeError(f"Не удалось закодировать PNG для {sha256} стр. {page}")

        temporary = path.with_suffix(".png.part")
        long_path(temporary).write_bytes(buffer.tobytes())
        os.replace(long_path(temporary), long_path(path))
        return self.storage_key(sha256, page, dpi)

    def stats(self) -> dict[str, Any]:
        """Что лежит в кеше растров — для `inspector-ml cache stats`."""
        root = long_path(self.storage_dir / RENDERS_PREFIX)
        if not root.is_dir():
            return {"documents": 0, "pages": 0, "size_bytes": 0, "by_dpi": {}}

        by_dpi: dict[str, int] = {}
        pages = size = 0
        documents = set()
        for path in root.glob("*/*/*.png"):
            documents.add(path.parent.parent.name)
            by_dpi[path.parent.name] = by_dpi.get(path.parent.name, 0) + 1
            pages += 1
            size += path.stat().st_size
        return {
            "documents": len(documents),
            "pages": pages,
            "size_bytes": size,
            "by_dpi": dict(sorted(by_dpi.items(), key=lambda item: int(item[0]))),
        }

    def clear(self, sha256: str | None = None) -> int:
        """Удалить растры одного документа или все. Возвращает число удалённых файлов."""
        root = self.storage_dir / RENDERS_PREFIX / sha256 if sha256 else self.storage_dir / RENDERS_PREFIX
        root = long_path(root)
        if not root.is_dir():
            return 0
        removed = 0
        for path in sorted(root.glob("**/*.png"), reverse=True):
            path.unlink()
            removed += 1
        return removed


def page_image(
    cache: RenderCache,
    sha256: str,
    source: Path,
    page: int,
    *,
    dpi: int,
    max_px: int,
) -> np.ndarray:
    """Растр страницы: из кеша, а при промахе — из PDF с сохранением в кеш.

    `page` — с единицы. `source` открывается только при промахе, поэтому повторные обращения
    к одному листу стоят чтения PNG.
    """
    cached = cache.get(sha256, page, dpi)
    if cached is not None:
        return cached

    with pymupdf.open(long_path(source)) as document:
        image = render_page(document[page - 1], dpi, max_px)
    cache.put(sha256, page, dpi, image)
    return image


def warm_document(
    cache: RenderCache,
    sha256: str,
    source: Path,
    pages: Iterable[int] | None = None,
    *,
    dpi: int,
    max_px: int,
) -> Iterator[tuple[int, int]]:
    """Отрисовать страницы документа в кеш, открыв PDF один раз.

    Отдаёт пары «страница, размер PNG в байтах»; уже лежащие в кеше пропускаются. Открывать
    документ на каждую страницу дорого: у листов A1 это десятки миллисекунд сверх рендера.
    """
    with pymupdf.open(long_path(source)) as document:
        numbers = list(pages) if pages is not None else range(1, document.page_count + 1)
        for number in numbers:
            if not 1 <= number <= document.page_count:
                continue
            path = long_path(cache.path(sha256, number, dpi))
            if path.exists():
                continue
            cache.put(sha256, number, dpi, render_page(document[number - 1], dpi, max_px))
            yield number, path.stat().st_size
