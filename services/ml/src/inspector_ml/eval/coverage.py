"""Находимость параметров матрицы на живых документах: `inspector-ml eval coverage`.

Эталон организаторов покрывает 15 проверок, а параметров 132. Сверка с эталоном (`eval extract`)
отвечает на вопрос «верно ли найдено там, где эксперт разметил», но молчит о том, **где параметр
вообще находится**. Этот замер закрывает второй вопрос: по каждому параметру × стадии × объекту —
в скольких документах нашлось значение, каким способом, с какими примерами и какие из значений
подозрительны.

Считается на кеше разбора (`STORAGE_DIR/parsed/<sha256>/<версия>.json`), а не на PDF: разбор
корпуса — часы, извлечение по готовому кешу — минуты. Извлекатель выбирается так же, как в
сравнении (`extract.api.extractor_for`), и матрица читается из того же `params.csv`, из которого
её загружает api. Иначе замер мерил бы не то, что работает на стенде.

**Подозрительное — не значит ложное.** Это список для глаз, чтобы ложные значения не прятались
за ростом находимости:

- `out_of_range` — число вне `min_value`/`max_value` матрицы;
- `not_in_enum` — значение не из `enum_values`;
- `not_a_number` — у числового параметра значение не число;
- `word_fragment` — короткое значение, которое в тексте есть только внутри слов: «а» из «класс
  энергоэффективности **лифта**» (M-021, M-124 на замере 24.09). Сама по себе короткость
  ничего не значит — «A+» и «B» законные классы энергоэффективности, — подозрительна склейка;
- `shared_value` — одно и то же число на одной странице взяли три и больше параметров: так
  выглядит число из чужой фразы, подхваченное несколькими якорями сразу.
"""

from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable, Mapping
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from inspector_ml.contracts.events import MatrixParam
from inspector_ml.extract.api import extractor_for
from inspector_ml.extract.base import Found
from inspector_ml.extract.normalize import key, lookalike
from inspector_ml.matrix import load_params
from inspector_ml.metadata.document import document_metadata

STAGES = ("PD", "RD", "ID")
#: Сколько примеров хранить на параметр в документе и в сводке.
DOC_SAMPLES = 3
SUMMARY_SAMPLES = 4
#: Столько параметров должны взять одно число с одной страницы, чтобы это выглядело чужим числом.
SHARED_BY = 3
#: Значение не длиннее стольких букв и цифр проверяем на склейку со словом.
SHORT_TEXT = 3
_ALNUM = re.compile(r"[0-9A-Za-zА-Яа-яЁё]")

#: Папки стадий в выгрузках организаторов: «ПД», «Проектная документация», «Стадия П»,
#: «Рабочая и исполнительная документация». Объект — папка **перед** первой такой.
_STAGE_FOLDER = re.compile(r"^(?:пд|рд|ид|проектн|рабоч|исполнит|стади)", re.IGNORECASE)


@dataclass(frozen=True)
class Source:
    """Откуда документ: имя файла и объект. Известно, только если передан корень корпуса."""

    file: str | None = None
    object: str | None = None


def object_of(relative: Path) -> str | None:
    """Объект по пути файла относительно корня корпуса — папка перед первой папкой стадии.

    `Речников ул. 7-7/ПД/…` → «Речников ул. 7-7», `Алтуфьевское, 79Б/Проектная документация/…` →
    «Алтуфьевское, 79Б». Если папки стадии в пути нет, объектом считается верхняя папка.
    """
    folders = relative.parts[:-1]
    for index, part in enumerate(folders):
        if _STAGE_FOLDER.match(part.strip()) and index > 0:
            return folders[index - 1]
    return folders[0] if folders else None


def suspicions(found: Found, param: MatrixParam) -> list[str]:
    """Признаки, по которым значение стоит проверить глазами."""
    reasons: list[str] = []
    kind = _plain(param.data_type)
    value = found.value
    if kind == "number":
        # Только когда числа не вышло вовсе. Строка вместо числа бывает задумана: у M-002 точка
        # «пом. 1.09 (назначение)» несёт наименование помещения — на первом замере это дало 1879
        # ложных тревог из 1879.
        numeric = isinstance(value, (int, float)) and not isinstance(value, bool)
        if value is None:
            reasons.append("not_a_number")
        elif numeric and _outside(value, param.min_value, param.max_value):
            reasons.append("out_of_range")
    elif _word_fragment(str(found.raw_value), found.snippet or ""):
        reasons.append("word_fragment")
    if param.enum_values and not _in_enum(found, param.enum_values):
        reasons.append("not_in_enum")
    return reasons


def _outside(value: float, low: float | None, high: float | None) -> bool:
    return (low is not None and value < low) or (high is not None and value > high)


def _word_fragment(raw: str, snippet: str) -> bool:
    """Короткое буквенное значение встречается в тексте только приклеенным к буквам — обрывок слова.

    Только буквы: «В50» из «БСТ В50F150W4» тоже приклеено к «F», но так класс бетона и пишут —
    на первом замере это дало 316 ложных тревог у M-055.
    """
    token = raw.strip()
    if not token or len(_ALNUM.findall(token)) > SHORT_TEXT or any(ch.isdigit() for ch in token):
        return False
    places = [match.start() for match in re.finditer(re.escape(token), snippet, re.IGNORECASE)]
    if not places:
        return False

    def glued(start: int) -> bool:
        before = snippet[start - 1] if start > 0 else " "
        end = start + len(token)
        after = snippet[end] if end < len(snippet) else " "
        return before.isalpha() or after.isalpha()

    return all(glued(start) for start in places)


def _in_enum(found: Found, allowed: Iterable[str]) -> bool:
    variants = {lookalike(str(found.raw_value)), lookalike(str(found.value)), key(str(found.value))}
    return any(lookalike(item) in variants or key(item) in variants for item in allowed)


def document_coverage(
    parsed: Mapping[str, Any],
    params: Mapping[str, MatrixParam],
    source: Source | None = None,
    *,
    samples: int = DOC_SAMPLES,
) -> dict[str, Any]:
    """Строка замера по одному разобранному документу: что нашлось по каждому параметру.

    Стадия, марка и шифр пересчитываются тем же кодом, что при попадании в кеш на стенде
    (`metadata.document_metadata`), — иначе замер делил бы документы по стадиям не так, как продукт.
    Сохранённые в кеше значения — только запасные, если признаков в документе нет вовсе.
    """
    pages = parsed.get("pages") or []
    stored = parsed.get("metadata") or {}
    fresh = document_metadata(pages, file_name=source.file if source else None)
    meta = {key: fresh.get(key) or stored.get(key) for key in ("doc_stage", "discipline", "document_code")}
    row: dict[str, Any] = {
        "sha256": parsed.get("sha256"),
        "file": source.file if source else None,
        "object": source.object if source else None,
        "stage": _plain(meta.get("doc_stage")),
        "discipline": meta.get("discipline"),
        "document_code": meta.get("document_code"),
        "pages": len(pages),
        "found": {},
        "errors": {},
    }

    hits: dict[str, list[Found]] = {}
    for code, param in params.items():
        try:
            found = extractor_for(code)(param, pages)
        except Exception as exc:  # один сломанный параметр не должен обрывать замер остальных
            row["errors"][code] = repr(exc)[:200]
            continue
        if found:
            hits[code] = found

    shared = _shared(hits)
    for code, found in hits.items():
        param = params[code]
        reasons: Counter[str] = Counter()
        kept: list[list[Any]] = []
        for item in found:
            item_reasons = suspicions(item, param)
            if (item.page, str(item.raw_value)) in shared:
                item_reasons.append("shared_value")
            reasons.update(item_reasons)
            if len(kept) < samples:
                snippet = (item.snippet or "")[:140]
                kept.append([item.page, str(item.raw_value)[:60], snippet, item.method, item_reasons])
        row["found"][code] = {
            "values": len(found),
            "keys": len({item.rule_key for item in found}),
            "methods": dict(Counter(item.method for item in found)),
            "suspicious": dict(reasons),
            "samples": kept,
        }
    return row


def _shared(hits: Mapping[str, list[Found]]) -> set[tuple[int, str]]:
    """Числа, которые на одной странице взяли `SHARED_BY` и больше разных параметров."""
    claimed: dict[tuple[int, str], set[str]] = defaultdict(set)
    for code, found in hits.items():
        for item in found:
            claimed[(item.page, str(item.raw_value))].add(code)
    return {place for place, codes in claimed.items() if len(codes) >= SHARED_BY}


def summarize(rows: Iterable[Mapping[str, Any]], params: Mapping[str, MatrixParam]) -> dict[str, Any]:
    """Сводка по параметрам: где находится, сколько, чем и что из этого подозрительно."""
    rows = list(rows)
    per: dict[str, dict[str, Any]] = {}
    errors: Counter[str] = Counter()
    for row in rows:
        stage = row.get("stage") or "UNKNOWN"
        for code in row.get("errors") or {}:
            errors[code] += 1
        for code, found in (row.get("found") or {}).items():
            item = per.setdefault(
                code,
                {
                    "documents": Counter(),
                    "objects": set(),
                    "values": 0,
                    "keys": 0,
                    "methods": Counter(),
                    "suspicious": Counter(),
                    "samples": [],
                    "suspicious_samples": [],
                },
            )
            item["documents"][stage] += 1
            if row.get("object"):
                item["objects"].add(row["object"])
            item["values"] += found["values"]
            item["keys"] = max(item["keys"], found["keys"])
            item["methods"].update(found["methods"])
            item["suspicious"].update(found["suspicious"])
            for page, raw, snippet, method, reasons in found["samples"]:
                sample = {
                    "file": row.get("file") or row.get("document_code") or (row.get("sha256") or "")[:12],
                    "object": row.get("object"),
                    "stage": stage,
                    "page": page,
                    "value": raw,
                    "snippet": snippet,
                    "method": method,
                }
                if reasons and len(item["suspicious_samples"]) < SUMMARY_SAMPLES:
                    item["suspicious_samples"].append({**sample, "reasons": reasons})
                elif not reasons and len(item["samples"]) < SUMMARY_SAMPLES:
                    item["samples"].append(sample)

    found_codes = [code for code in params if code in per]
    both = [c for c in found_codes if per[c]["documents"]["PD"] and per[c]["documents"]["RD"]]
    every = [c for c in found_codes if all(per[c]["documents"][s] for s in STAGES)]
    by_type: dict[str, dict[str, int]] = defaultdict(lambda: {"total": 0, "found": 0})
    for code, param in params.items():
        kind = str(_plain(param.data_type))
        by_type[kind]["total"] += 1
        by_type[kind]["found"] += code in per

    suspicious_total: Counter[str] = Counter()
    for item in per.values():
        suspicious_total.update(item["suspicious"])

    report_params = []
    for code in sorted(found_codes, key=lambda c: (-sum(per[c]["documents"].values()), c)):
        item = per[code]
        param = params[code]
        report_params.append(
            {
                "code": code,
                "name": param.parameter_name,
                "section": param.section,
                "data_type": _plain(param.data_type),
                "documents": {stage: item["documents"][stage] for stage in STAGES},
                "objects": len(item["objects"]),
                "values": item["values"],
                "keys": item["keys"],
                "methods": dict(item["methods"]),
                "suspicious": dict(item["suspicious"]),
                "samples": item["samples"],
                "suspicious_samples": item["suspicious_samples"],
            }
        )

    return {
        "documents": len(rows),
        "by_stage": dict(Counter(row.get("stage") or "UNKNOWN" for row in rows)),
        "objects": sorted({row["object"] for row in rows if row.get("object")}),
        "params_total": len(params),
        "found_anywhere": len(found_codes),
        "found_pd_and_rd": len(both),
        "found_all_stages": len(every),
        "by_data_type": dict(by_type),
        "suspicious_total": dict(suspicious_total),
        "errors": dict(errors),
        "params": report_params,
        "not_found": [code for code in params if code not in per],
    }


def corpus_sources(root: Path) -> dict[str, Source]:
    """sha256 → имя файла и объект для всех PDF корпуса. Нужен только для подписей в отчёте."""
    from inspector_ml.precompute import pdf_files
    from inspector_ml.storage.files import sha256_of

    sources: dict[str, Source] = {}
    for path in pdf_files(root):
        try:
            sha = sha256_of(path)
        except OSError:
            continue
        relative = path.relative_to(root)
        sources.setdefault(sha, Source(file=path.name, object=object_of(relative)))
    return sources


def _measure_file(task: tuple[str, str | None, Source | None, int]) -> dict[str, Any]:
    """Работа одного процесса: прочитать разобранный документ и померить его."""
    path, matrix, source, samples = task
    parsed = json.loads(Path(path).read_text(encoding="utf-8"))
    params = load_params(Path(matrix) if matrix else None)
    return document_coverage(parsed, params, source, samples=samples)


def measure(
    parsed_files: Iterable[Path],
    *,
    matrix: Path | None = None,
    sources: Mapping[str, Source] | None = None,
    workers: int = 1,
    samples: int = DOC_SAMPLES,
    on_progress: Callable[[int, int], None] | None = None,
) -> list[dict[str, Any]]:
    """Строки замера по всем документам. `workers > 1` — в отдельных процессах.

    Прогон по корпусу идёт десятки минут, поэтому `on_progress(сделано, всего)` зовётся по мере
    готовности — иначе всё это время снаружи ничего не видно.
    """
    tasks = [
        (str(path), str(matrix) if matrix else None, (sources or {}).get(path.parent.name), samples)
        for path in parsed_files
    ]
    rows: list[dict[str, Any]] = []
    if workers <= 1:
        results: Iterable[dict[str, Any]] = map(_measure_file, tasks)
        for row in results:
            rows.append(row)
            if on_progress is not None:
                on_progress(len(rows), len(tasks))
        return rows
    with ProcessPoolExecutor(max_workers=workers) as pool:
        for row in pool.map(_measure_file, tasks, chunksize=4):
            rows.append(row)
            if on_progress is not None:
                on_progress(len(rows), len(tasks))
    return rows


def parsed_files(storage_dir: Path, parser_version: str) -> list[Path]:
    """Файлы разбора одной версии: `parsed/<sha256>/<версия>.json`."""
    root = storage_dir / "parsed"
    return sorted(root.glob(f"*/{parser_version}.json")) if root.is_dir() else []


def _plain(value: object) -> Any:
    return getattr(value, "root", value)
