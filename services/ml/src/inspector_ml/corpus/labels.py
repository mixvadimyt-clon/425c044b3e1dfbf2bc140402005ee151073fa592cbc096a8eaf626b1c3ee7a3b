"""Чтение разметки организаторов (`*.jsonl`) и путей корпуса.

Разбор самой выгрузки — [data/samples/dataset-overview.md](../../../../data/samples/dataset-overview.md).
Данные в git не попадают, поэтому здесь только доступ к ним по пути из `--root`.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from inspector_ml.storage.files import reachable

CORPUS_DIR = "01_ПАКЕТ_УЧАСТНИКАМ_3_ОБЪЕКТА/ХАКАТОН_УЧАСТНИКАМ_ГОТОВО_К_ПЕРЕДАЧЕ/01_ДОКУМЕНТАЦИЯ"
SPLIT_DIRS = {
    "TRAIN_PUBLIC": "РАЗМЕЧЕННЫЙ_TRAIN_PUBLIC_203/РАЗМЕЧЕННЫЙ_TRAIN_PUBLIC_203/data",
    "TEST_HIDDEN": "РАЗМЕЧЕННЫЙ_TEST__213/РАЗМЕЧЕННЫЙ_TEST_HIDDEN_ОРГАНИЗАТОР_213/data",
}


def read_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                yield json.loads(line)


@dataclass(frozen=True)
class Split:
    """Размеченная часть датасета: индексы файлов, страниц и аннотаций."""

    root: Path
    name: str

    @property
    def data_dir(self) -> Path:
        return self.root / SPLIT_DIRS[self.name]

    @property
    def corpus_dir(self) -> Path:
        return self.root / CORPUS_DIR

    def files(self) -> list[dict[str, Any]]:
        return list(read_jsonl(self.data_dir / "files_index.jsonl"))

    def pages(self) -> list[dict[str, Any]]:
        return list(read_jsonl(self.data_dir / "page_index.jsonl"))

    def annotations(self) -> Iterator[dict[str, Any]]:
        yield from read_jsonl(self.data_dir / "annotations.jsonl")

    def source_path(self, file_row: dict[str, Any]) -> Path:
        """Путь к исходному документу корпуса (а не к PDF с наложенной разметкой)."""
        return self.corpus_dir / file_row["source_relative_path"]

    def exists(self) -> bool:
        return self.data_dir.is_dir() and self.corpus_dir.is_dir()


def pdf_files(split: Split, limit: int | None = None) -> list[dict[str, Any]]:
    """Файлы сплита, для которых есть исходный PDF на диске.

    Выборка равномерная по списку, а не первые N: файлы идут по объектам, и первые сотни —
    это сплошные акты одного объекта. Порядок детерминированный, отчёт воспроизводится.
    """
    rows = [r for r in split.files() if r.get("extension") == ".pdf" and reachable(split.source_path(r))]
    rows.sort(key=lambda r: r["file_id"])
    if not limit or limit >= len(rows):
        return rows
    step = len(rows) / limit
    return [rows[int(i * step)] for i in range(limit)]
