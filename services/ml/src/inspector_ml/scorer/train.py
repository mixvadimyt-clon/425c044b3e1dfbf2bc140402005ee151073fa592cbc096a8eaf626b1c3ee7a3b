"""Обучение скорера и метрики §14 (`inspector-ml train`).

- обучаем на `TRAIN`, меряем на `VALIDATION`; `HIDDEN_TEST` не трогаем ни для чего (REQ-ML-03);
- метка — решение инспектора: `POSITIVE` (подтвердил нарушение) или `NEGATIVE` (отклонил);
- порог — самый высокий, при котором на `TRAIN` сохраняется 95 % подтверждённых: скорер должен
  срезать пустых кандидатов, а не спорить с инспектором;
- метрики системы «правила + скорер» на `VALIDATION`: кандидат с вероятностью ниже порога считается
  отклонённым. Precision, recall, F1, FPR, по разделам и с 95 % интервалом (bootstrap).

Мало данных — не обучаем: модель на десятке записей выглядит работающей и ничего не значит.
"""

from __future__ import annotations

import random
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from inspector_ml.contracts.events import MatrixParam
from inspector_ml.scorer.dataset import Export
from inspector_ml.scorer.features import FeatureSpace, from_gold
from inspector_ml.scorer.model import L2, LogisticModel, fit, threshold_for_recall

#: Сколько записей каждого класса нужно в `TRAIN`, чтобы обучение имело смысл. Для первой итерации на
#: настоящих объектах порог опускается флагом `train --min-per-class` — значение
#: попадает в `training_params` и в метаданные модели, так что видно, на скольких решениях она обучена.
MIN_PER_CLASS = 10
#: Доля подтверждённых нарушений, которую порог обязан сохранить на `TRAIN`.
KEEP_RECALL = 0.95
#: Меньше стольких подтверждённых в `TRAIN` — порог по сохранённой полноте ничего не значит: по одной записи он
#: равен её вероятности на собственных данных, то есть упирается в потолок 0,5 и понижает почти всех кандидатов
#: (`scorer-ds-2026.09.2`). Тогда порог не выше `FEW_POSITIVES_THRESHOLD`:
#: скорер понижает только почти наверняка пустых кандидатов и не спорит с правилами.
FEW_POSITIVES = 5
FEW_POSITIVES_THRESHOLD = 0.2
#: Признаки модели при малом числе подтверждённых. На 31 признаке и девяти решениях модель ловила случайное —
#: раздел, «строки разные», пару стадий — и понижала внесённые ошибки контрольного комплекта 3 (23 из 86 при
#: пороге 0,2). Держится только один сигнал: во сколько раз разошлись значения. Ошибка извлечения — это числа в
#: разы и на порядки (41,7 → 3793,1), нарушение — проценты. Кандидатов без отношения — марки (С0, КМ2), текст с
#: цифрой, ноль — такая модель не трогает: сигнала для них в данных нет (`numeric_only` в метаданных модели,
#: `apply`; признак `ratio_defined`).
FEW_DATA_FEATURES = ("log_ratio",)
BOOTSTRAP = 1000


class NotEnoughData(ValueError):
    """Обучать не на чем: мало записей одного из классов или нет части для замера."""


@dataclass(frozen=True)
class Trained:
    model: LogisticModel
    metrics: dict[str, Any]
    report: dict[str, Any]


def train(
    export: Export,
    params: Mapping[str, MatrixParam],
    *,
    dataset_version: str,
    model_version: str,
    code_version: str | None = None,
    min_per_class: int = MIN_PER_CLASS,
    threshold: float | None = None,
) -> Trained:
    """Обучить модель на `TRAIN` и померить на `VALIDATION`.

    `threshold` — порог понижения, заданный явно (`train --threshold`); без него — по сохранённой полноте на
    `TRAIN`, а при малом числе подтверждённых — не выше `FEW_POSITIVES_THRESHOLD`. Откуда порог, пишется в
    `training_params.threshold_source`.
    """
    section_of = {code: str(param.section or "") for code, param in params.items()}
    space = FeatureSpace(section_of.values())
    train_x, train_y, _ = _matrix(export.part("TRAIN"), space, section_of)
    valid_x, valid_y, valid_sections = _matrix(export.part("VALIDATION"), space, section_of)

    positives, negatives = sum(train_y), len(train_y) - sum(train_y)
    if min(positives, negatives) < min_per_class:
        raise NotEnoughData(
            f"В TRAIN подтверждённых {positives}, отклонённых {negatives}: нужно не меньше {min_per_class} "
            "каждого — модель на меньшем выглядит работающей и ничего не значит"
        )
    if not valid_y:
        raise NotEnoughData("В VALIDATION нет записей: мерить модель не на чем, а на TRAIN — нечестно")

    few = positives < FEW_POSITIVES
    names = list(FEW_DATA_FEATURES) if few else space.names
    columns = [space.names.index(name) for name in names]
    defined = space.names.index("ratio_defined")

    def usable(row: Sequence[float]) -> bool:
        return not few or bool(row[defined])

    fit_rows = [([row[i] for i in columns], y) for row, y in zip(train_x, train_y, strict=True) if usable(row)]
    fit_x, fit_y = [x for x, _ in fit_rows], [y for _, y in fit_rows]
    if len(set(fit_y)) < 2:
        raise NotEnoughData("Среди числовых записей TRAIN нет обоих классов: модели «мало данных» учиться не на чем")

    weights, bias, mean, scale = fit(fit_x, fit_y)
    model = LogisticModel(
        model_version=model_version,
        features=names,
        sections=space.sections,
        weights=weights,
        bias=bias,
        mean=mean,
        scale=scale,
        threshold=0.0,
    )
    train_scores = [model.proba(x) for x in fit_x]
    model.threshold = threshold_for_recall([s for s, y in zip(train_scores, fit_y, strict=True) if y], KEEP_RECALL)
    source = "keep_recall"
    if threshold is not None:
        model.threshold, source = threshold, "manual"
    elif positives < FEW_POSITIVES and model.threshold > FEW_POSITIVES_THRESHOLD:
        model.threshold, source = FEW_POSITIVES_THRESHOLD, "few_positives"

    # кандидат без отношения в режиме «мало данных» не оценивается и остаётся кандидатом
    predicted = [int(not usable(x) or model.proba([x[i] for i in columns]) >= model.threshold) for x in valid_x]
    metrics: dict[str, Any] = dict(_metrics(valid_y, predicted))
    metrics["sample_size"] = len(valid_y)
    metrics["ci95"] = _bootstrap(valid_y, predicted)
    metrics["per_category"] = _per_category(valid_y, predicted, valid_sections)

    model.meta = {
        "dataset_version": dataset_version,
        "split_hashes": export.split_hashes,
        "code_version": code_version,
        "trained_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "train": {"positives": positives, "negatives": negatives},
        "min_per_class": min_per_class,
        "threshold_source": source,
        "mode": "few_data" if few else "full",
        "numeric_only": few,
        "metrics": metrics,
    }
    report = {
        "model_version": model_version,
        "dataset_version": dataset_version,
        "threshold": round(model.threshold, 4),
        "threshold_source": source,
        "mode": "few_data" if few else "full",
        "min_per_class": min_per_class,
        "train": {"records": len(train_y), "positives": positives, "negatives": negatives},
        "validation": {"records": len(valid_y), "positives": sum(valid_y)},
        "metrics": metrics,
        "weights": _strongest(names, weights),
    }
    return Trained(model, metrics, report)


def registration(trained: Trained, artifact_hash: str, split_hashes: Mapping[str, str]) -> dict[str, Any]:
    """`ModelRegistration` для `POST /api/v1/ml/models`: пороги и регрессию api считает сам."""
    meta = trained.model.meta
    return {
        "model_version": trained.model.model_version,
        "artifact_hash": artifact_hash,
        "dataset_version": meta["dataset_version"],
        "split_hashes": dict(split_hashes),
        "metrics": trained.metrics,
        "training_params": {
            "kind": trained.model.kind,
            "l2": L2,
            "keep_recall": KEEP_RECALL,
            "threshold": trained.model.threshold,
            "threshold_source": meta.get("threshold_source", "keep_recall"),
            "mode": meta.get("mode", "full"),
            "features": len(trained.model.features),
            "min_per_class": meta.get("min_per_class", MIN_PER_CLASS),
            "train_positives": meta["train"]["positives"],
            "train_negatives": meta["train"]["negatives"],
        },
        "code_version": meta.get("code_version"),
    }


def _matrix(
    records: Sequence[Mapping[str, Any]], space: FeatureSpace, section_of: Mapping[str, str]
) -> tuple[list[list[float]], list[int], list[str]]:
    rows: list[list[float]] = []
    labels: list[int] = []
    sections: list[str] = []
    for record in records:
        label = record.get("gold_label")
        if label not in ("POSITIVE", "NEGATIVE"):
            continue
        candidate = from_gold(record.get("record") or {})
        rows.append(space.vector(candidate, section_of))
        labels.append(int(label == "POSITIVE"))
        sections.append(section_of.get(candidate.param_code or "", "") or "?")
    return rows, labels, sections


def _metrics(truth: Sequence[int], predicted: Sequence[int]) -> dict[str, float]:
    tp = sum(1 for t, p in zip(truth, predicted, strict=True) if t and p)
    fp = sum(1 for t, p in zip(truth, predicted, strict=True) if not t and p)
    fn = sum(1 for t, p in zip(truth, predicted, strict=True) if t and not p)
    tn = sum(1 for t, p in zip(truth, predicted, strict=True) if not t and not p)
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    fpr = fp / (fp + tn) if fp + tn else 0.0
    return {
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "false_positive_rate": round(fpr, 4),
    }


def _bootstrap(truth: Sequence[int], predicted: Sequence[int]) -> dict[str, list[float]]:
    """95 % интервал по выборкам с возвращением; зерно фиксировано — отчёт воспроизводим."""
    rng = random.Random(0)
    pairs = list(zip(truth, predicted, strict=True))
    samples: dict[str, list[float]] = {"precision": [], "recall": [], "f1": [], "false_positive_rate": []}
    for _ in range(BOOTSTRAP):
        drawn = [pairs[rng.randrange(len(pairs))] for _ in pairs]
        for name, value in _metrics([t for t, _ in drawn], [p for _, p in drawn]).items():
            samples[name].append(value)
    return {name: [_quantile(values, 0.025), _quantile(values, 0.975)] for name, values in samples.items()}


def _strongest(names: Sequence[str], weights: Sequence[float]) -> dict[str, float]:
    """Веса по убыванию силы: по ним видно, на что модель смотрит."""
    pairs = sorted(zip(names, weights, strict=True), key=lambda pair: -abs(pair[1]))
    return {name: round(weight, 4) for name, weight in pairs}


def _per_category(
    truth: Sequence[int], predicted: Sequence[int], sections: Sequence[str]
) -> dict[str, dict[str, float]]:
    """Метрики по разделам: по ним api проверяет регрессию (падение recall и рост FPR ≤ 2 п.п.)."""
    result: dict[str, dict[str, float]] = {}
    for section in sorted(set(sections)):
        index = [i for i, s in enumerate(sections) if s == section]
        metrics: dict[str, float] = dict(_metrics([truth[i] for i in index], [predicted[i] for i in index]))
        metrics["sample_size"] = len(index)
        result[section] = metrics
    return result


def _quantile(values: Sequence[float], q: float) -> float:
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, int(q * len(ordered)))], 4)
