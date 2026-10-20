"""Кодогенерация pydantic-моделей из контрактов (команда ``uv run gen``).

Источник — ``contracts/dist/ml-events.v1.json`` (бандл со всеми разрешёнными ``$ref``),
результат — ``src/inspector_ml/contracts/events.py`` (в git не попадает).
Параметры совпадают с описанием в ``docs/contracts.md``.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from inspector_ml.config import find_repo_root
from inspector_ml.contracts import GENERATED_PATH
from inspector_ml.logging import ensure_utf8_streams

CONTRACT_BUNDLE = Path("contracts/dist/ml-events.v1.json")

_CODEGEN_ARGS = [
    "--input-file-type",
    "openapi",
    "--output-model-type",
    "pydantic_v2.BaseModel",
    "--target-python-version",
    "3.12",
    "--use-standard-collections",
    "--use-union-operator",
    "--enum-field-as-literal",
    "all",
]


def generate(bundle: Path | None = None, output: Path | None = None) -> int:
    """Запустить datamodel-code-generator. Возвращает код возврата процесса."""
    bundle = bundle or (find_repo_root() / CONTRACT_BUNDLE)
    output = output or GENERATED_PATH

    if not bundle.exists():
        print(f"Не найден бандл контрактов: {bundle}", file=sys.stderr)
        print("Соберите его командой «npm run bundle» в contracts/.", file=sys.stderr)
        return 1

    output.parent.mkdir(parents=True, exist_ok=True)
    command = [
        sys.executable,
        "-m",
        "datamodel_code_generator",
        "--input",
        str(bundle),
        "--output",
        str(output),
        *_CODEGEN_ARGS,
    ]
    try:
        completed = subprocess.run(command, check=False)
    except FileNotFoundError:  # pragma: no cover — зависит от окружения
        print("Не найден datamodel-code-generator. Установите dev-зависимости: uv sync --dev", file=sys.stderr)
        return 1

    if completed.returncode == 0:
        print(f"Модели контрактов сгенерированы: {output}")
    return completed.returncode


def main() -> int:
    ensure_utf8_streams()
    return generate()


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
