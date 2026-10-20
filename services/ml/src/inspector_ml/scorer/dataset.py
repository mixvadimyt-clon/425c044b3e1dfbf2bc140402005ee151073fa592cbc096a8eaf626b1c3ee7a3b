"""Выгрузка версии GOLD-набора из api и проверка её хешей (контракт: `exportDatasetVersion`).

Строка выгрузки — `DatasetRecord`. Хеш части (`DatasetVersion.split_hashes`) — SHA-256 байтов её
строк, каждая с `\\n` на конце, в порядке выгрузки. Считаем по строкам **как они пришли**, без
пересериализации JSON: иначе порядок ключей или пробелы дали бы другой хеш, и api не принял бы
модель (`registerModelVersion` сверяет хеши).

Хеш есть у каждой из трёх частей, даже у пустой: api считает его всегда, и у пустой части это SHA-256 пустой
строки (`e3b0c442…`). Первый прогон на стенде (`ds-2026.09.1`, 28.09: в HIDDEN_TEST ноль записей) без этого
падал на сверке хешей, а потом упал бы и на регистрации модели.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

SPLITS = ("TRAIN", "VALIDATION", "HIDDEN_TEST")


@dataclass(frozen=True)
class Export:
    """Записи выгрузки по частям и хеши частей, посчитанные по строкам."""

    records: list[dict[str, Any]]
    split_hashes: dict[str, str]

    def part(self, split: str) -> list[dict[str, Any]]:
        return [record for record in self.records if record.get("split") == split]


def read_export(text: str) -> Export:
    """Разобрать JSONL выгрузки и посчитать хеши частей."""
    records: list[dict[str, Any]] = []
    digests: dict[str, Any] = {split: hashlib.sha256() for split in SPLITS}
    for line in text.splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        records.append(record)
        split = str(record.get("split"))
        digests.setdefault(split, hashlib.sha256()).update((line + "\n").encode("utf-8"))
    return Export(records, {split: digest.hexdigest() for split, digest in digests.items()})


def check_hashes(export: Export, published: dict[str, str] | None) -> list[str]:
    """Расхождения с хешами версии в api. Пусто — выгрузка та самая."""
    if not published:
        return []
    return [
        f"{split}: в api {published.get(split)}, в выгрузке {export.split_hashes.get(split)}"
        for split in sorted(set(published) | set(export.split_hashes))
        if published.get(split) != export.split_hashes.get(split)
    ]
