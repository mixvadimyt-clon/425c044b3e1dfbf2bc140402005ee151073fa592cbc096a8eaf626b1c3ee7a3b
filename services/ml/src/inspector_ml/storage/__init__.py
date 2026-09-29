"""Работа с общим хранилищем файлов и кешем разбора.

`S3Ref{bucket: "local", key}` — это путь `{STORAGE_DIR}/{key}`: api и ml запускаются на одной
машине и видят одну папку. Кеш разбора живёт по ключу `sha256 + PARSER_VERSION`.
"""

from inspector_ml.storage.cache import ParsedCache
from inspector_ml.storage.files import FileMissingError, UnsupportedBucketError, resolve_ref, sha256_of

__all__ = ["FileMissingError", "ParsedCache", "UnsupportedBucketError", "resolve_ref", "sha256_of"]
