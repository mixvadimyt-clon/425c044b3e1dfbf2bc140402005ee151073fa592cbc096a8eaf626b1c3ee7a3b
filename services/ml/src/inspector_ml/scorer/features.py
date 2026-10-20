"""Признаки кандидата — одни и те же для записи GOLD (обучение) и результата сравнения (применение).

Берём только то, что есть **с обеих сторон**: в `GoldRecord` нет уверенности фрагмента, поэтому и при
применении на неё не опираемся — иначе модель училась бы на одном, а судила по другому. Метод извлечения
есть с обеих сторон с контракта 0.23.0 (`extraction_method` во фрагменте и в `GoldSource`); в записях
раньше 0.23.0 ключа нет — это правила.

| Признак | Откуда | Зачем |
|---|---|---|
| раздел параметра | матрица по `param_code` | в разных разделах разная доля ложных срабатываний |
| есть ключ точки | `rule_key` | параметр целиком без ключа чаще складывает разные элементы |
| число и относительное расхождение | `expected_value`, `actual_value` | расхождение в 0,1 % и в 40 % — разные истории |
| строки разные | те же поля | для марок и классов |
| приоритет | `review_priority` | |
| пара стадий | стадии эталона и факта | ПД ↔ РД и РД ↔ ИД расходятся по-разному |
| утверждённость источников | `approval` эталона и факта | черновик чаще даёт ложное расхождение |
| OCR | источник текста фрагментов | распознанный текст ошибается чаще |
| Sentence-BERT | `extraction_method` фрагментов | найденное по смыслу подписи ошибается чаще правил |
| во сколько раз разошлись | `expected_value`, `actual_value` | ошибка извлечения — числа в разы: 41,7 → 3793,1 |
| определено ли отношение | те же поля | у марок (С0, КМ2, B25), текста с цифрой и нуля отношения нет |
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from inspector_ml.contracts.events import CheckResult
from inspector_ml.extract.normalize import key, number, only_number

#: Статусы утверждения, при которых источник считается утверждённым.
APPROVED = frozenset({"APPROVED", "FOR_CONSTRUCTION"})
PRIORITIES = ("HIGH", "MEDIUM", "LOW")
STAGE_PAIRS = ("PD-RD", "PD-ID", "RD-ID")
#: Относительное расхождение больше этого — уже «сильно», дальше модель не различает.
MAX_DELTA = 5.0
#: Потолок признака `log_ratio`: в 400 раз и больше — уже всё равно, насколько больше.
MAX_LOG_RATIO = 6.0
#: Раздел параметра, которого нет в матрице модели.
OTHER_SECTION = "?"
#: Метод извлечения Sentence-BERT во фрагменте (`ExtractionMethod`, контракт 0.23.0); пусто и RULES — правила.
SBERT = "SBERT"


@dataclass(frozen=True)
class Candidate:
    """Кандидат в нарушения в виде, общем для обучения и применения."""

    param_code: str | None
    rule_key: str | None
    expected_value: str | None
    actual_value: str | None
    review_priority: str | None
    expected_stage: str | None
    actual_stage: str | None
    expected_approval: str | None
    actual_approval: str | None
    ocr: bool
    sbert: bool = False


def from_gold(record: Mapping[str, Any]) -> Candidate:
    """Кандидат из записи GOLD (`DatasetRecord.record`)."""
    sources = [*(record.get("source_expected") or []), *(record.get("source_actual") or [])]
    return Candidate(
        param_code=record.get("matrix_code"),
        rule_key=record.get("rule_key"),
        expected_value=record.get("expected_value"),
        actual_value=record.get("actual_value"),
        review_priority=record.get("review_priority"),
        expected_stage=record.get("source_expected_stage"),
        actual_stage=record.get("source_actual_stage"),
        expected_approval=record.get("source_expected_approval"),
        actual_approval=record.get("source_actual_approval"),
        ocr=any(source.get("source") == "OCR" for source in sources),
        sbert=any(source.get("extraction_method") == SBERT for source in sources),
    )


def from_check(check: CheckResult) -> Candidate:
    """Кандидат из результата движка сравнения — того, что увидит инспектор."""
    expected = [f for f in check.fragments if _plain(f.role) == "EXPECTED"]
    actual = [f for f in check.fragments if _plain(f.role) == "ACTUAL"]
    return Candidate(
        param_code=check.param_code,
        rule_key=check.rule_key,
        expected_value=check.expected_value,
        actual_value=check.actual_value,
        review_priority=_plain(check.review_priority),
        expected_stage=_plain(expected[0].stage) if expected else None,
        actual_stage=_plain(actual[0].stage) if actual else None,
        expected_approval=_plain(expected[0].approval_status) if expected else None,
        actual_approval=_plain(actual[0].approval_status) if actual else None,
        ocr=any(_plain(f.source) == "OCR" for f in check.fragments),
        sbert=any(_plain(f.extraction_method) == SBERT for f in check.fragments),
    )


class FeatureSpace:
    """Порядок и имена признаков. Сохраняется в файле модели: при применении — тот же порядок."""

    def __init__(self, sections: Sequence[str]) -> None:
        self.sections = [*sorted(set(sections) - {OTHER_SECTION}), OTHER_SECTION]
        self.names = [
            *(f"section={s}" for s in self.sections),
            "has_rule_key",
            "numeric",
            "relative_delta",
            "text_differs",
            *(f"priority={p}" for p in PRIORITIES),
            *(f"stages={p}" for p in STAGE_PAIRS),
            "expected_approved",
            "actual_approved",
            "ocr",
            "sbert",
            "log_ratio",
            "ratio_defined",
        ]

    def vector(self, candidate: Candidate, section_of: Mapping[str, str]) -> list[float]:
        section = section_of.get(candidate.param_code or "", OTHER_SECTION)
        if section not in self.sections:
            section = OTHER_SECTION
        expected, actual = number(candidate.expected_value or ""), number(candidate.actual_value or "")
        numeric, delta = False, 0.0
        if expected is not None and actual is not None:
            numeric, delta = True, min(abs(actual - expected) / max(abs(expected), 1e-9), MAX_DELTA)
        differs = not numeric and key(candidate.expected_value or "") != key(candidate.actual_value or "")
        ratio = log_ratio(only_number(candidate.expected_value or ""), only_number(candidate.actual_value or ""))
        pair = "-".join(sorted({s for s in (candidate.expected_stage, candidate.actual_stage) if s}, key=_order))
        return [
            *(float(section == s) for s in self.sections),
            float(bool(candidate.rule_key)),
            float(numeric),
            float(delta),
            float(differs),
            *(float(candidate.review_priority == p) for p in PRIORITIES),
            *(float(pair == p) for p in STAGE_PAIRS),
            float(candidate.expected_approval in APPROVED),
            float(candidate.actual_approval in APPROVED),
            float(candidate.ocr),
            float(candidate.sbert),
            ratio or 0.0,
            float(ratio is not None),
        ]


def log_ratio(expected: float | None, actual: float | None) -> float | None:
    """|ln(факт / эталон)| — во сколько раз разошлись значения; `None`, если отношения нет.

    Относительное расхождение `relative_delta` упирается в потолок уже на пятикратном расхождении, а ошибку
    извлечения от нарушения отличает именно порядок: 14,9 → 15,2 — нарушение, 41,7 → 3793,1 — чужое число.

    Отношения нет, если одно из значений не число, равно нулю или у значений разные знаки. Значения берутся
    `only_number` — число целиком, с единицей, но без прочих слов. `number` взял бы цифру из марки, и на стенде
    С0 → С1, КМ0 → КМ3 и 0 → 24 давали ноль против числа и потолок признака: скорер понижал
    внесённые ошибки. Марка, текст с цифрой и «было ноль — стало сколько-то» — не порядок величины.
    """
    if expected is None or actual is None or expected == 0 or actual == 0 or (expected < 0) != (actual < 0):
        return None
    return min(abs(math.log(actual / expected)), MAX_LOG_RATIO)


def _order(stage: str) -> int:
    return {"PD": 0, "RD": 1, "ID": 2}.get(stage, 3)


def _plain(value: Any) -> Any:
    """Значение перечисления контракта: у `RootModel` оно лежит в `root`."""
    return getattr(value, "root", value)
