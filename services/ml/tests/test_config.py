"""Настройки: корень репозитория и пути, общие с api."""

from __future__ import annotations

from pathlib import Path

from inspector_ml.config import Settings, find_repo_root


def test_repo_root_contains_markers() -> None:
    """Корень репозитория определяется по docker-compose.yml и contracts/."""
    root = find_repo_root()

    assert (root / "docker-compose.yml").exists()
    assert (root / "contracts" / "dist" / "ml-events.v1.json").exists()


def test_repo_root_from_env(tmp_path: Path, monkeypatch) -> None:
    """REPO_ROOT перекрывает автоопределение (нужно в контейнере и в тестах)."""
    monkeypatch.setenv("REPO_ROOT", str(tmp_path))

    assert find_repo_root() == tmp_path.resolve()


def test_relative_paths_resolve_against_repo_root(tmp_path: Path, monkeypatch) -> None:
    """var/storage из .env — это папка репозитория, общая с api."""
    monkeypatch.setenv("REPO_ROOT", str(tmp_path))
    settings = Settings(_env_file=None, storage_dir=Path("var/storage"), cache_dir=Path("var/cache"))

    assert settings.storage_dir == (tmp_path / "var" / "storage").resolve()
    assert settings.cache_dir == (tmp_path / "var" / "cache").resolve()


def test_storage_path_follows_s3ref_key(settings: Settings) -> None:
    """S3Ref{bucket: local, key} → {STORAGE_DIR}/{key}."""
    assert settings.storage_path("raw/9f86d081") == settings.storage_dir / "raw" / "9f86d081"
    assert settings.parsed_dir == settings.storage_dir / "parsed"


def test_defaults_match_env_example(monkeypatch) -> None:
    """Умолчания совпадают с .env.example, чтобы сервис поднимался без .env."""
    for name in ("ML_PORT", "API_URL", "LLM_ENABLED", "INTERNAL_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    settings = Settings(_env_file=None)

    assert settings.ml_port == 8000
    assert settings.api_url == "http://localhost:3000"
    assert settings.llm_enabled is False
    assert settings.internal_token == ""
