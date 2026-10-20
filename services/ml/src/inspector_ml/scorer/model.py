"""Логистическая регрессия на numpy и файл модели в JSON.

Не `scikit-learn`: он тянет в образ scipy (около 70 МБ) ради одной регрессии на сотни записей.
Не pickle: файл модели — JSON с весами. Его можно прочитать глазами (какой признак за что
отвечает), у него стабильный SHA-256 (`artifact_hash` в реестре api), и при загрузке он не
исполняет код.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

KIND = "candidate-scorer/logistic-regression"
#: Сила L2-регуляризации: на сотнях записей без неё веса редких разделов уходят в бесконечность.
L2 = 1.0
ITERATIONS = 50


@dataclass
class LogisticModel:
    """Веса модели и всё, что нужно для применения: признаки, нормировка, порог."""

    model_version: str
    features: list[str]
    sections: list[str]
    weights: list[float]
    bias: float
    mean: list[float]
    scale: list[float]
    threshold: float
    meta: dict[str, Any] = field(default_factory=dict)
    kind: str = KIND

    def proba(self, vector: Sequence[float]) -> float:
        """Вероятность того, что инспектор подтвердит кандидата."""
        x = (np.asarray(vector, dtype=float) - np.asarray(self.mean)) / np.asarray(self.scale)
        return float(_sigmoid(float(x @ np.asarray(self.weights)) + self.bias))

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False, indent=2, sort_keys=True) + "\n"

    def save(self, path: Path) -> str:
        """Записать файл модели и вернуть его SHA-256 (`artifact_hash`)."""
        path.parent.mkdir(parents=True, exist_ok=True)
        body = self.to_json().encode("utf-8")
        path.write_bytes(body)
        return hashlib.sha256(body).hexdigest()

    @classmethod
    def load(cls, path: Path) -> LogisticModel:
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("kind") != KIND:
            raise ValueError(f"{path.name}: не модель скорера ({data.get('kind')!r})")
        return cls(**data)


def fit(
    rows: Sequence[Sequence[float]], labels: Sequence[int], *, l2: float = L2, iterations: int = ITERATIONS
) -> tuple[list[float], float, list[float], list[float]]:
    """Ньютон с L2 и весами классов поровну: подтверждённых обычно меньше, чем отклонённых.

    Возвращает веса, смещение и нормировку признаков (среднее и разброс).
    """
    x = np.asarray(rows, dtype=float)
    y = np.asarray(labels, dtype=float)
    mean = x.mean(axis=0)
    scale = x.std(axis=0)
    scale[scale == 0] = 1.0
    z = np.hstack([(x - mean) / scale, np.ones((len(x), 1))])

    positives = max(float(y.sum()), 1.0)
    negatives = max(float(len(y) - y.sum()), 1.0)
    sample = np.where(y == 1, len(y) / (2 * positives), len(y) / (2 * negatives))
    penalty = np.full(z.shape[1], l2)
    penalty[-1] = 0.0  # смещение не штрафуем

    theta = np.zeros(z.shape[1])
    for _ in range(iterations):
        p = _sigmoid(z @ theta)
        gradient = z.T @ (sample * (p - y)) + penalty * theta
        hessian = (z * (sample * p * (1 - p))[:, None]).T @ z + np.diag(penalty) + 1e-9 * np.eye(z.shape[1])
        step = np.linalg.solve(hessian, gradient)
        theta -= step
        if np.abs(step).max() < 1e-8:
            break
    return theta[:-1].tolist(), float(theta[-1]), mean.tolist(), scale.tolist()


def threshold_for_recall(positive_scores: Sequence[float], recall: float) -> float:
    """Самый высокий порог, при котором выше него остаётся не меньше доли `recall` подтверждённых.

    Скорер должен срезать заведомо пустых кандидатов, а не спорить с инспектором: поэтому порог
    подбирается по сохранённой полноте, а не по максимуму F1. Больше 0.5 он не бывает.
    """
    scores = sorted(positive_scores)
    if not scores:
        return 0.0
    allowed_misses = int((1.0 - recall) * len(scores))
    return float(min(scores[allowed_misses], 0.5))


def _sigmoid(z: Any) -> Any:
    return 1.0 / (1.0 + np.exp(-np.clip(z, -35, 35)))
