"""Матрица параметров для команд, которые работают без api.

В рантайме матрица приходит в `CompareRequest.matrix`: её ведёт api, а источник — `data/matrix/`
(`overrides.csv` → `params.csv`, формат в `docs/domain/matrix.md`). Но `inspector-ml eval` и
офлайн-прогоны на выборке api не поднимают, а извлечению нужны те же `regex_pattern`,
`semantic_anchors` и `enum_values`, иначе офлайн-прогон меряет не то, что работает на стенде.

Поэтому здесь читается **тот же CSV**, из которого api заполняет свою таблицу. Своих значений
модуль не добавляет: нет строки в матрице — нет и параметра.
"""

from __future__ import annotations

import csv
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path

from inspector_ml.config import find_repo_root
from inspector_ml.contracts.events import MatrixParam

#: Колонки-списки: в CSV записаны через `|`, в контракте это массивы строк.
LIST_FIELDS = ("semantic_anchors", "enum_values")


def params_path() -> Path:
    """Путь к матрице в репозитории."""
    return find_repo_root() / "data" / "matrix" / "params.csv"


def load_params(path: Path | None = None) -> dict[str, MatrixParam]:
    """Матрица по кодам параметров: `{"M-002": MatrixParam, …}`."""
    return _load(path or params_path())


def param(code: str, path: Path | None = None) -> MatrixParam | None:
    """Один параметр матрицы или `None`, если его в ней нет."""
    return load_params(path).get(code)


@lru_cache(maxsize=4)
def _load(path: Path) -> dict[str, MatrixParam]:
    """Чтение CSV с кешем: матрицу читают в цикле по проверкам эталона, а файл не меняется."""
    if not path.is_file():
        return {}
    # `id`, `created_at` и `updated_at` есть только в БД api; здесь они синтетические —
    # номер строки и время правки файла. Движок сравнения их не использует.
    changed = datetime.fromtimestamp(path.stat().st_mtime, tz=UTC)
    with path.open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    params = (_param(index, row, changed) for index, row in enumerate(rows, 1))
    return {p.code: p for p in params}


def _param(index: int, row: dict[str, str | None], changed: datetime) -> MatrixParam:
    fields: dict[str, object] = {name: value.strip() or None for name, value in row.items() if value is not None}
    for name in LIST_FIELDS:
        raw = fields.get(name)
        fields[name] = [part.strip() for part in str(raw).split("|") if part.strip()] if raw else None
    return MatrixParam.model_validate({**fields, "id": index, "created_at": changed, "updated_at": changed})
