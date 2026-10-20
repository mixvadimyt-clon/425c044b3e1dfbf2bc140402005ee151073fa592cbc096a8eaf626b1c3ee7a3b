"""Загрузка весов OCR на этапе сборки образа ([ADR-0007](../../../docs/adr/0007-stand-cpu-precomputed-cache.md)).

По умолчанию PaddleOCR тянет веса при первом распознавании — то есть уже в работе и уже с сетью.
Стенду и образу организаторов это не подходит: интернета в рантайме может не быть, а первый
запрос инспектора не должен ждать загрузку моделей. Поэтому веса кладём в образ на сборке.

Запуск::

    uv run --extra ocr python scripts/fetch_ocr_models.py

Скрипт загружает **ровно те** модели, что закреплены в `ocr/paddle.py` (`PP-OCRv5_mobile_det`
и `eslav_PP-OCRv5_mobile_rec`), и распознаёт одну сгенерированную картинку: без прогона часть
весов не скачивается — PaddleOCR тянет их лениво, когда доходит до соответствующего шага.

Печатает каталог кеша моделей и его размер — этот каталог и копируется в образ
(`PADDLE_PDX_CACHE_HOME`, по умолчанию `~/.paddlex`).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np

# скрипт запускают из каталога сервиса при сборке образа, пакет может быть ещё не установлен
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))


def cache_home() -> Path:
    """Каталог, куда PaddleOCR складывает веса."""
    for name in ("PADDLE_PDX_CACHE_HOME", "PADDLEX_HOME"):
        value = os.environ.get(name)
        if value:
            return Path(value)
    return Path.home() / ".paddlex"


def directory_size(path: Path) -> int:
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def main() -> int:
    from inspector_ml.ocr.paddle import DET_MODEL, LANG, REC_MODEL, PaddleEngine

    if not PaddleEngine.available():
        print("PaddleOCR не установлен: uv sync --extra ocr", file=sys.stderr)
        return 1

    print(f"Загружаю веса: детектор {DET_MODEL}, распознаватель {REC_MODEL}, язык {LANG}", file=sys.stderr)
    engine = PaddleEngine(device=os.environ.get("OCR_DEVICE", "cpu"))

    # белый лист с чёрной полосой: распознавать нечего, но оба шага конвейера отработают
    # и дотянут свои веса — ради этого прогон и нужен
    image = np.full((320, 640, 3), 255, dtype=np.uint8)
    image[150:180, 80:560] = 0
    engine.recognize(image)

    home = cache_home()
    if not home.is_dir():
        print(f"Каталог весов не появился: {home}", file=sys.stderr)
        return 1

    print(f"Веса на месте: {home} ({directory_size(home) / 1e6:.0f} МБ)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
