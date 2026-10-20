"""Модели обмена api ⇄ ml.

Файл ``events.py`` рядом **генерируется** из бандла контрактов
``contracts/dist/ml-events.v1.json`` и не коммитится (см. корневой ``.gitignore``).
Сгенерировать: ``uv run gen`` (в ``services/ml``).

Правило простое: код подстраивается под контракт, а не наоборот. Нужно новое поле —
сначала правка контракта в ``contracts/``.
"""

from __future__ import annotations

from importlib.util import find_spec
from pathlib import Path
from types import ModuleType

GENERATED_MODULE = "inspector_ml.contracts.events"
GENERATED_PATH = Path(__file__).with_name("events.py")
GENERATE_COMMAND = "uv run gen"


def is_generated() -> bool:
    """Сгенерированы ли модели контрактов в текущей установке."""
    if GENERATED_PATH.exists():
        return True
    try:
        return find_spec(GENERATED_MODULE) is not None
    except (ImportError, ValueError):
        return False


def load_events() -> ModuleType:
    """Модуль сгенерированных моделей с понятной ошибкой, если кодогенерация не выполнялась.

    Имя не ``events``: импорт подмодуля ``contracts.events`` перезаписывает одноимённый атрибут пакета,
    и второй вызов функции падал бы с «'module' object is not callable».
    """
    import importlib

    try:
        return importlib.import_module(GENERATED_MODULE)
    except ModuleNotFoundError as exc:  # pragma: no cover — зависит от окружения
        raise RuntimeError(
            f"Модели контрактов не сгенерированы. Выполните «{GENERATE_COMMAND}» в services/ml."
        ) from exc


__all__ = ["GENERATED_MODULE", "GENERATED_PATH", "GENERATE_COMMAND", "is_generated", "load_events"]
