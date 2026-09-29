"""Выбор движка OCR по настройкам.

`OCR_ENGINE=paddle` — основной, `tesseract` — запасной, `none` — распознавание выключено.
Если выбранный движок не установлен, берём любой доступный и пишем об этом в лог:
лучше распознать Tesseract'ом, чем не распознать вовсе.

**Движок живёт столько же, сколько рабочий процесс.** PaddleOCR поднимает веса при первом
распознавании и держит их в экземпляре, а экземпляр раньше создавался на каждую задачу разбора —
то есть модель поднималась заново для каждого документа. Пул процессов задачи переживает,
поэтому движок кешируется по своим параметрам и достаётся уже прогретым.

Замер на двух настоящих актах ИД (`АОСР №3А-БСС` и `АОСР №10БЗ`, вместе 5 распознанных страниц):
**14.8 с против 8.5 с**. Экономия на задачу — около 5 с на первой в процессе и около 1.3 с
на следующих: во второй раз веса уже в памяти операционной системы, но обёртку PaddleOCR
приходилось собирать заново.

Кеш именно процессный: при `ML_EXECUTOR=process` (умолчание) в каждом рабочем процессе своя
копия весов, и одновременного доступа к одному движку не возникает. При `ML_EXECUTOR=thread`
(тесты и отладка) задачи делят процесс, и один движок будут звать из нескольких потоков —
создание модели защищено замком, но само распознавание PaddleOCR потокобезопасным не заявлено.
Для отладочного режима это приемлемо, для боевого — режим не тот.
"""

from __future__ import annotations

from functools import lru_cache

from inspector_ml.logging import get_logger
from inspector_ml.ocr.base import OcrEngine
from inspector_ml.ocr.paddle import DET_MODEL, PaddleEngine
from inspector_ml.ocr.tesseract import TesseractEngine

log = get_logger(__name__)

ENGINES = {"paddle": PaddleEngine, "tesseract": TesseractEngine}


def available_engines() -> list[str]:
    """Какие движки реально установлены в этом окружении."""
    return [name for name, engine in ENGINES.items() if engine.available()]


@lru_cache(maxsize=8)
def build_engine(name: str, *, paddle_det_model: str | None = None, device: str = "auto") -> OcrEngine | None:
    """Движок по имени из настроек или `None`, если распознавать нечем.

    Результат кешируется на процесс: см. пояснение в начале модуля. В тестах кеш сбрасывается
    через `build_engine.cache_clear()`.
    """
    if name == "none":
        return None

    available = available_engines()
    if not available:
        log.info("ocr_unavailable", requested=name, hint="uv sync --extra ocr")
        return None

    chosen = name if name in available else available[0]
    if chosen != name:
        log.warning("ocr_engine_substituted", requested=name, used=chosen)
    if chosen == "paddle":
        return PaddleEngine(det_model=paddle_det_model or DET_MODEL, device=device)
    return ENGINES[chosen]()
