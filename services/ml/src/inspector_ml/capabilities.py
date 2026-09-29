"""Какие необязательные компоненты доступны в текущей установке.

Базовая установка (``uv sync``) работает без тяжёлых зависимостей; extras ставятся
командой ``uv sync --extra ocr --extra layout``. Результат отдаётся в ``GET /health``
(поле ``capabilities`` контракта ``ml-events.v1``), чтобы api и инспектор видели,
что именно умеет запущенный сервис.
"""

from __future__ import annotations

from importlib.util import find_spec

from inspector_ml.config import Settings

# Возможность → модуль, по наличию которого она определяется.
_MODULE_BY_CAPABILITY: dict[str, str] = {
    "pdf": "pymupdf",  # PyMuPDF — базовый парсинг
    "cv": "cv2",  # OpenCV — совмещение и визуальные различия
    "docling": "docling",  # extra layout
    "embeddings": "sentence_transformers",  # extra embeddings
}


def _module_available(module: str) -> bool:
    try:
        return find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def detect_capabilities(settings: Settings) -> dict[str, bool]:
    """Карта «возможность → доступна ли». LLM считается доступной только при ``LLM_ENABLED``."""
    from inspector_ml.ocr.engines import available_engines

    capabilities = {name: _module_available(module) for name, module in _MODULE_BY_CAPABILITY.items()}
    # OCR доступен, если установлен хоть один движок и он не выключен настройкой
    capabilities["ocr"] = bool(available_engines()) and settings.ocr_engine != "none"
    capabilities["ocr_gpu"] = capabilities["ocr"] and settings.ocr_device != "cpu" and _cuda_available()
    capabilities["llm"] = settings.llm_enabled
    return capabilities


def _cuda_available() -> bool:
    """Видит ли paddle видеокарту прямо сейчас.

    Нужно для проверяющего стенда: нормативы меряют в GPU-конфигурации, а `OCR_DEVICE=auto` скроет
    неудачу — распознавание просто пойдёт на процессоре и станет много медленнее. По `GET /health`
    это видно до первой задачи, без разбора документа.

    Модель не поднимается: проверяются только сборка paddle и число видимых карт.
    """
    try:
        import paddle
    except Exception:  # paddle ставится вместе с extra ocr, его может не быть вовсе
        return False
    try:
        return bool(paddle.device.is_compiled_with_cuda()) and paddle.device.cuda.device_count() > 0
    except Exception:  # pragma: no cover — сломанная установка CUDA не должна ронять /health
        return False


def service_status(capabilities: dict[str, bool]) -> str:
    """``ok``, пока доступен базовый путь (PyMuPDF + OpenCV); иначе ``degraded``."""
    return "ok" if capabilities.get("pdf") and capabilities.get("cv") else "degraded"
