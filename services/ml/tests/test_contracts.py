"""Кодогенерация моделей из contracts/dist (uv run gen)."""

from __future__ import annotations

import pytest

from inspector_ml import contracts


def test_events_module_reports_missing_generation() -> None:
    """Без кодогенерации импорт даёт понятную подсказку, а не ModuleNotFoundError."""
    if contracts.is_generated():
        pytest.skip("модели уже сгенерированы")

    with pytest.raises(RuntimeError, match="uv run gen"):
        contracts.load_events()


def test_generated_models_cover_envelope() -> None:
    """Если модели сгенерированы — в них есть ключевые схемы обмена api ⇄ ml."""
    if not contracts.is_generated():
        pytest.skip("сначала выполните uv run gen")

    events = contracts.load_events()
    assert contracts.load_events() is events  # повторный вызов не ломается
    for name in ("Envelope", "ParseRequest", "ParseResult", "CompareRequest", "CompareResult", "JobState"):
        assert hasattr(events, name), f"в сгенерированных моделях нет {name}"
