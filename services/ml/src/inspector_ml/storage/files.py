"""Доступ к файлам общего хранилища (`STORAGE_DIR`)."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

LOCAL_BUCKET = "local"
_CHUNK = 1 << 20  # 1 МиБ


class UnsupportedBucketError(ValueError):
    """Пришёл не локальный bucket: S3 или MinIO в локальном режиме не поддерживаются."""


class FileMissingError(FileNotFoundError):
    """Файла нет по ожидаемому пути внутри STORAGE_DIR."""


def long_path(path: Path) -> Path:
    """Путь, пригодный для длинных имён Windows.

    В выгрузке организаторов встречаются пути до 401 символа — без префикса `\\\\?\\`
    Windows отказывается открывать такие файлы. На других системах путь возвращается как есть.
    """
    if os.name != "nt":
        return path
    text = str(path)
    if text.startswith("\\\\?\\"):
        return path
    absolute = os.path.abspath(text)
    if absolute.startswith("\\\\"):  # сетевой путь \\server\share
        return Path("\\\\?\\UNC" + absolute[1:])
    return Path("\\\\?\\" + absolute)


def reachable(path: Path) -> bool:
    """Файл существует и его вообще можно открыть на этой системе.

    Обычный `Path.exists()` тут не годится: в Linux предел длины **одного элемента** пути —
    255 байт, а в выгрузке организаторов есть каталог на 310 байт (раздел 10.1 про
    энергоэффективность, файл `F0152`). На таком пути `stat` не возвращает `False`, а кидает
    `OSError: [Errno 36] File name too long`, и обход корпуса падает на ровном месте.

    Windows такие пути открывает через префикс `\\\\?\\` (см. `long_path`), Linux — нет: это
    предел ядра, обойти его нельзя. Поэтому из WSL и из контейнера такой файл просто недоступен,
    и это не ошибка, а свойство раскладки каталогов у организаторов. На стенде проблемы нет:
    api сохраняет загруженный файл как `raw/{sha256}`, то есть коротким путём.
    """
    try:
        return long_path(path).is_file()
    except OSError:
        return False


def resolve_ref(storage_dir: Path, bucket: str, key: str) -> Path:
    """`S3Ref` → путь в хранилище. Ключ не должен выводить за пределы `STORAGE_DIR`."""
    if bucket != LOCAL_BUCKET:
        raise UnsupportedBucketError(f"Поддерживается только bucket «{LOCAL_BUCKET}», получен «{bucket}»")

    root = storage_dir.resolve()
    path = (root / key).resolve()
    if root not in path.parents and path != root:
        raise UnsupportedBucketError(f"Ключ «{key}» выводит за пределы STORAGE_DIR")
    return path


def sha256_of(path: Path) -> str:
    """SHA-256 файла (потоково, файлы бывают на гигабайты)."""
    digest = hashlib.sha256()
    with long_path(path).open("rb") as fh:
        for chunk in iter(lambda: fh.read(_CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()
