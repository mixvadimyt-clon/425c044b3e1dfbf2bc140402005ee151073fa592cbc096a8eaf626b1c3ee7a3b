"""Сверка извлечения с эталоном организаторов.

Эталон — `data/samples/public_gold_checks.jsonl`, публичная разметка TRAIN: 15 атомарных проверок,
у каждой есть `parameter_code`, `location` (наш `rule_key`), значения по стадиям и **ссылки на
доказательства** — файл и номер страницы. Этого хватает, чтобы проверить три вещи сразу:

- найдено ли значение вообще (recall по точкам эталона);
- совпало ли **значение** с эталонным;
- попали ли мы в **ту же страницу**, что эксперт (локализация — 15 баллов в оценке организаторов).

Проверяются только параметры, которые мы извлекаем (`PARAMETERS`), и только те проверки, у которых
на диске есть исходный файл. Сравнение ключей — как в движке (`compare.keys.rule_group`), чтобы
«Фундаментная плита» и «фундаментная плита» считались одной точкой.

Матрица берётся из `data/matrix/params.csv` ([matrix.py](../matrix.py)) — того же файла, из
которого её загружает api. Так офлайн-прогон идёт по тем же якорям и шаблонам, что и сравнение
на стенде.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from inspector_ml.compare.keys import rule_group
from inspector_ml.contracts.events import MatrixParam
from inspector_ml.corpus.labels import Split
from inspector_ml.extract import concrete, elevation, foundation, rooms
from inspector_ml.extract.base import Found
from inspector_ml.ingest.pdf import parse_pdf
from inspector_ml.matrix import load_params, params_path
from inspector_ml.storage.files import reachable

#: Коды организаторов → наши извлекатели. Соответствие кодов — `data/samples/parameter-code-map.csv`.
PARAMETERS = {
    "PZ-002": ("M-002", rooms.extract),
    "PZ-009": ("M-009", elevation.extract),
    "KR-055": ("M-055", concrete.extract),
    "KR-058": ("M-058", foundation.extract),
}
#: Число в эталонном значении-строке: «1000/1200 мм» — толщины зон плиты.
_NUMBER = re.compile(r"\d+(?:[.,]\d+)?")
STAGES = ("pd", "rd", "id")


def evaluate_gold(root: Path, gold: Path, *, split: str = "TRAIN_PUBLIC", matrix: Path | None = None) -> dict[str, Any]:
    """Пройти эталонные проверки и сравнить с тем, что извлекает конвейер."""
    checks = [json.loads(line) for line in gold.read_text(encoding="utf-8").splitlines() if line.strip()]
    checks = [c for c in checks if c.get("parameter_code") in PARAMETERS]
    matrix = matrix or params_path()
    params = load_params(matrix)

    corpus = Split(root, split)
    files = {row["file_id"]: row for row in corpus.files()}
    cache: dict[str, list[Found]] = {}

    points: list[dict[str, Any]] = []
    skipped: list[str] = []
    for check in checks:
        code, extractor = PARAMETERS[check["parameter_code"]]
        param = params.get(code)
        if param is None:  # параметра нет в матрице — извлекать нечем, но прогон не роняем
            skipped.append(code)
            continue
        for evidence in check.get("evidence") or []:
            row = files.get(evidence["file_id"])
            if row is None or not reachable(corpus.source_path(row)):
                continue
            found = _extract(cache, corpus, row, param, extractor)
            points.append(_point(check, code, evidence, found))

    report = {
        "gold": str(gold),
        "matrix": str(matrix),
        "split": split,
        "points": points,
        "totals": _totals(points),
    }
    if skipped:
        report["skipped_params"] = sorted(set(skipped))
    return report


def _extract(
    cache: dict[str, list[Found]], corpus: Split, row: dict[str, Any], param: MatrixParam, extractor: Any
) -> list[Found]:
    key = f"{row['file_id']}:{param.code}"
    if key not in cache:
        path = corpus.source_path(row)
        parsed = parse_pdf(path, row.get("source_sha256") or "0" * 64, "eval", file_name=path.name)
        cache[key] = extractor(param, parsed["pages"])
    return cache[key]


def _point(check: dict[str, Any], code: str, evidence: dict[str, Any], found: list[Found]) -> dict[str, Any]:
    """Одна строка отчёта: эталонная точка и что по ней нашлось."""
    stage = str(evidence["stage"]).lower()
    expected = check.get(f"{stage}_value") if stage in STAGES else None
    wanted = rule_group(check.get("location"))

    same_key = [item for item in found if rule_group(item.rule_key) == wanted]
    same_page = [item for item in same_key if item.page == evidence["pdf_page_number"]]
    matched = [item for item in same_key if _same_value(item, expected)]

    return {
        "check_id": check["check_id"],
        "param_code": code,
        "parameter_code": check["parameter_code"],
        "location": check.get("location"),
        "stage": evidence["stage"],
        "file_id": evidence["file_id"],
        "gold_page": evidence["pdf_page_number"],
        "gold_value": expected,
        "found_key": bool(same_key),
        "found_value": bool(matched),
        "found_page": bool(same_page),
        "pages": sorted({item.page for item in same_key})[:5],
        "values": sorted({str(item.value) for item in same_key})[:5],
    }


def _same_value(item: Found, expected: object) -> bool:
    """Значения совпадают: числа — с допуском на округление, остальное — по строке.

    Эталон бывает перечнем чисел строкой: у KR-058 «1000/1200 мм» — толщины зон плиты, а мы отдаём
    самую тонкую (`extract/foundation.py`). Число совпадает, если оно одно из перечисленных.
    """
    if expected is None:
        return False
    if isinstance(item.value, (int, float)) and not isinstance(item.value, bool):
        if isinstance(expected, (int, float)):
            return abs(float(expected) - float(item.value)) <= 0.05
        listed = [float(n.replace(",", ".")) for n in _NUMBER.findall(str(expected))]
        return any(abs(n - float(item.value)) <= 0.05 for n in listed)
    return str(item.value).casefold() == str(expected).casefold()


def _totals(points: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(points)
    if not total:
        return {"points": 0}
    found_key = sum(1 for p in points if p["found_key"])
    return {
        "points": total,
        "found_key": found_key,
        "found_value": sum(1 for p in points if p["found_value"]),
        "found_page": sum(1 for p in points if p["found_page"]),
        "recall_key": round(found_key / total, 4),
        "recall_value": round(sum(1 for p in points if p["found_value"]) / total, 4),
        "recall_page": round(sum(1 for p in points if p["found_page"]) / total, 4),
    }
