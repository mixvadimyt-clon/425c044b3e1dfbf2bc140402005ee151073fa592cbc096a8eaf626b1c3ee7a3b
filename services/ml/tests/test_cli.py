"""CLI: доступные команды и понятные сообщения о ещё не готовых."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

import pytest

from inspector_ml import __version__
from inspector_ml.cli import main
from inspector_ml.config import get_settings


def test_version(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exc:
        main(["--version"])

    assert exc.value.code == 0
    assert __version__ in capsys.readouterr().out


def test_info_prints_settings_and_capabilities(capsys: pytest.CaptureFixture[str]) -> None:
    """inspector-ml info показывает, что установлено и куда сервис смотрит."""
    assert main(["info"]) == 0

    payload = json.loads(capsys.readouterr().out)
    assert payload["version"] == __version__
    assert payload["capabilities"]["pdf"] is True
    assert payload["storage_dir"]


def test_compare_reports_its_task(capsys: pytest.CaptureFixture[str]) -> None:
    """Пока команда не реализована, она не падает трассировкой, а говорит, чего ждёт."""
    assert main(["compare", "x"]) == 2
    assert "появится" in capsys.readouterr().err


def test_eval_ocr_without_engine_explains_how_to_install(
    make_pdf: Callable[..., Path], capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Без extra ocr команда подсказывает, что установить, а не падает."""
    from inspector_ml.config import get_settings

    monkeypatch.setenv("OCR_ENGINE", "none")
    get_settings.cache_clear()
    try:
        assert main(["eval", "ocr", str(make_pdf())]) == 1
        assert "uv sync --extra ocr" in capsys.readouterr().err
    finally:
        get_settings.cache_clear()


def test_parse_without_engine_explains_how_to_install(
    make_pdf: Callable[..., Path], capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    from inspector_ml.config import get_settings

    monkeypatch.setenv("OCR_ENGINE", "none")
    get_settings.cache_clear()
    try:
        assert main(["parse", str(make_pdf()), "--ocr"]) == 1
    finally:
        get_settings.cache_clear()


def test_parse_prints_summary(make_pdf: Callable[..., Path], capsys: pytest.CaptureFixture[str]) -> None:
    """inspector-ml parse — проверка конвейера без api."""
    assert main(["parse", str(make_pdf(pages=2, rotation=90))]) == 0

    summary = json.loads(capsys.readouterr().out)
    assert summary["pages"] == 2
    assert summary["pages_text_layer"] == 2
    assert summary["rotations"] == {"90": 2}
    assert summary["blocks"] >= 2


def test_parse_writes_parsed_document(make_pdf: Callable[..., Path], tmp_path: Path) -> None:
    out = tmp_path / "parsed.json"

    assert main(["parse", str(make_pdf()), "--out", str(out)]) == 0

    parsed = json.loads(out.read_text(encoding="utf-8"))
    assert parsed["format"] == "PDF"
    assert len(parsed["pages"]) == 1


def test_parse_reports_missing_file(capsys: pytest.CaptureFixture[str], tmp_path: Path) -> None:
    assert main(["parse", str(tmp_path / "нет.pdf")]) == 1
    assert "Нет файла" in capsys.readouterr().err


class TestLlmCheck:
    """`inspector-ml llm` — одна команда, чтобы понять, поднимется ли свободный поиск."""

    def test_says_when_the_model_is_switched_off(self, capsys: pytest.CaptureFixture[str]) -> None:
        """Выключенная модель — это состояние нашего публичного стенда, а не поломка."""
        assert main(["llm"]) == 1
        assert "LLM_ENABLED" in capsys.readouterr().out

    def test_reports_the_address_and_the_answer(
        self, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("LLM_ENABLED", "true")
        get_settings.cache_clear()
        monkeypatch.setattr("inspector_ml.llm.client.LlmClient.ask_json", lambda self, s, u: {"ok": True})

        assert main(["llm"]) == 0

        out = capsys.readouterr().out
        assert "qwen3:8b" in out
        assert "ok" in out

    def test_no_answer_is_a_failure_with_a_hint(
        self, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("LLM_ENABLED", "true")
        get_settings.cache_clear()
        monkeypatch.setattr("inspector_ml.llm.client.LlmClient.ask_json", lambda self, s, u: None)

        assert main(["llm"]) == 1
        assert "ответа нет" in capsys.readouterr().err
