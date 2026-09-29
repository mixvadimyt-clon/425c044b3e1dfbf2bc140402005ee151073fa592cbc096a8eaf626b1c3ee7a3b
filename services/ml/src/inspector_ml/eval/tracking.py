"""Прогоны оценки в MLflow: находимость, OCR и сверка с эталоном — историей по версиям.

MLflow поднимается профилем compose `mlops`: api пишет туда выпуски эталонного набора
(`inspector-datasets`) и модели с метриками §14 (`inspector-models`). Здесь третий эксперимент —
`inspector-evals`: каждый прогон `inspector-ml eval … --mlflow` становится записью с метриками,
параметрами прогона (версия разбора, матрица, коммит) и полным отчётом файлом. Так на защите видно
не одну цифру, а как она менялась: «находимость 15 → 22 из 132» — два прогона рядом.

**Запись по возможности**, как у api: MLflow выключен или не отвечает — замер отработал и напечатал
отчёт, предупреждение уходит в журнал. Клиент — REST на `httpx`, без пакета `mlflow`: нужно пять
вызовов, а пакет тянет сотни мегабайт.

**Только внутрь контура.** В отчёте находимости лежат фрагменты текста документов госнадзора,
поэтому адрес проверяется тем же правилом, что адрес языковой модели (`llm.client.is_local`):
`http://mlflow:5000/mlflow` в compose и `localhost` — можно, всё остальное — нет.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx

from inspector_ml.llm.client import is_local
from inspector_ml.logging import get_logger

log = get_logger(__name__)

EXPERIMENT = "inspector-evals"
#: Файл отчёта в артефактах прогона.
REPORT_FILE = "report.json"
#: Пределы одного `runs/log-batch` у MLflow: 1000 метрик, 100 параметров, 100 меток.
MAX_METRICS, MAX_PARAMS = 1000, 100
#: Длина значения параметра в MLflow ограничена; длиннее — обрезаем, полное значение есть в отчёте.
MAX_PARAM_CHARS = 500
#: Префикс адреса артефактов, когда сервер сам их хранит (`--serve-artifacts`, как в compose).
SERVED_ARTIFACTS = "mlflow-artifacts:/"


@dataclass(frozen=True)
class EvalRun:
    """Что записать: имя, параметры прогона, метрики, метки и отчёт целиком."""

    target: str
    name: str
    params: dict[str, str] = field(default_factory=dict)
    metrics: dict[str, float] = field(default_factory=dict)
    tags: dict[str, str] = field(default_factory=dict)
    report: Mapping[str, Any] = field(default_factory=dict)


class Mlflow:
    """Клиент к REST MLflow. `base_url` — с префиксом, под которым сервер отдаёт API (`…/mlflow`)."""

    def __init__(self, base_url: str, *, timeout: float = 10.0, client: httpx.Client | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = client or httpx.Client(timeout=timeout)

    def log(self, run: EvalRun, experiment: str = EXPERIMENT) -> str | None:
        """Записать прогон. Возвращает `run_id`, а при любой неудаче — `None` и предупреждение."""
        if not is_local(self.base_url):
            log.error(
                "mlflow_remote_blocked",
                url=self.base_url,
                reason="адрес MLflow не локальный: фрагменты документов госнадзора наружу не уходят",
            )
            return None
        try:
            return self._log(run, experiment)
        except (httpx.HTTPError, KeyError, ValueError) as exc:
            log.warning("mlflow_log_failed", url=self.base_url, error=str(exc))
            return None

    def _log(self, run: EvalRun, experiment: str) -> str:
        experiment_id = self._experiment(experiment)
        now = _now_ms()
        created = self._call(
            "runs/create",
            {"experiment_id": experiment_id, "run_name": run.name, "start_time": now, "tags": _pairs(run.tags)},
        )
        info = created["run"]["info"]
        run_id = str(info["run_id"])
        metrics = [
            {"key": key, "value": float(value), "timestamp": now, "step": 0}
            for key, value in list(run.metrics.items())[:MAX_METRICS]
        ]
        params = [{"key": key, "value": str(value)[:MAX_PARAM_CHARS]} for key, value in run.params.items()]
        self._call("runs/log-batch", {"run_id": run_id, "metrics": metrics, "params": params[:MAX_PARAMS]})
        self._artifact(str(info.get("artifact_uri") or ""), run.report)
        self._call("runs/update", {"run_id": run_id, "status": "FINISHED", "end_time": _now_ms()})
        return run_id

    def _experiment(self, name: str) -> str:
        response = self._client.get(
            f"{self.base_url}/api/2.0/mlflow/experiments/get-by-name", params={"experiment_name": name}
        )
        if response.status_code == 404:
            return str(self._call("experiments/create", {"name": name})["experiment_id"])
        response.raise_for_status()
        return str(response.json()["experiment"]["experiment_id"])

    def _artifact(self, artifact_uri: str, report: Mapping[str, Any]) -> None:
        """Отчёт файлом. Сервер без `--serve-artifacts` хранит артефакты у себя на диске — тогда пропускаем."""
        if not report:
            return
        if not artifact_uri.startswith(SERVED_ARTIFACTS):
            log.warning("mlflow_artifact_skipped", artifact_uri=artifact_uri, reason="сервер не принимает артефакты")
            return
        path = quote(artifact_uri.removeprefix(SERVED_ARTIFACTS).strip("/"))
        body = json.dumps(report, ensure_ascii=False, indent=2).encode("utf-8")
        response = self._client.put(
            f"{self.base_url}/api/2.0/mlflow-artifacts/artifacts/{path}/{REPORT_FILE}",
            content=body,
            headers={"Content-Type": "application/json"},
        )
        response.raise_for_status()

    def _call(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        response = self._client.post(f"{self.base_url}/api/2.0/mlflow/{path}", json=body)
        response.raise_for_status()
        return response.json() if response.content else {}


# ------------------------------------------------------------------ прогоны по видам оценки


def coverage_run(report: Mapping[str, Any], *, matrix: Path, workers: int) -> EvalRun:
    """Находимость: сводные числа, по типам данных, по стадиям и по каждому найденному параметру."""
    suspicious = sum((report.get("suspicious_total") or {}).values())
    metrics: dict[str, float] = {
        "params_total": report.get("params_total", 0),
        "params_found": report.get("found_anywhere", 0),
        "params_pd_and_rd": report.get("found_pd_and_rd", 0),
        "params_all_stages": report.get("found_all_stages", 0),
        "documents": report.get("documents", 0),
        "suspicious": suspicious,
        "duration_s": report.get("duration_s", 0),
    }
    for stage, count in (report.get("by_stage") or {}).items():
        metrics[f"documents.{stage}"] = count
    for data_type, counts in (report.get("by_data_type") or {}).items():
        metrics[f"found.{data_type}"] = counts.get("found", 0)
    for param in report.get("params") or []:
        metrics[f"param.{param['code']}.documents"] = sum((param.get("documents") or {}).values())
        metrics[f"param.{param['code']}.suspicious"] = sum((param.get("suspicious") or {}).values())

    found, total = metrics["params_found"], metrics["params_total"]
    note = (
        f"Находимость: значение найдено у {found:.0f} из {total:.0f} параметров, в ПД и РД — у "
        f"{metrics['params_pd_and_rd']:.0f}, во всех трёх стадиях — у {metrics['params_all_stages']:.0f}. "
        f"Документов {metrics['documents']:.0f}, подозрительных значений {suspicious}."
    )
    params = {
        "target": "coverage",
        "parser_version": str(report.get("parser_version", "")),
        "matrix": matrix.name,
        "matrix_sha256": _file_sha(matrix),
        "workers": str(workers),
        "objects": ", ".join(report.get("objects") or []),
    }
    return EvalRun("coverage", f"coverage {found:.0f}/{total:.0f}", params, metrics, _tags("coverage", note), report)


def ocr_run(report: Mapping[str, Any]) -> EvalRun:
    """OCR одного PDF против его текстового слоя: Character Accuracy, CER, WER, скорость."""
    keys = (
        "character_accuracy",
        "page_character_accuracy",
        "cer",
        "wer",
        "coverage",
        "mean_confidence",
        "seconds_per_page",
        "pages",
    )
    metrics = {key: float(report[key]) for key in keys if isinstance(report.get(key), (int, float))}
    params = {"target": "ocr", "file": str(report.get("file", "")), "engine": str(report.get("engine", ""))}
    params["dpi"] = str(report.get("dpi", ""))
    note = (
        f"OCR «{params['file']}»: Character Accuracy {metrics.get('character_accuracy', 0):.4f} "
        f"на {metrics.get('pages', 0):.0f} стр., {metrics.get('seconds_per_page', 0):.2f} с на страницу."
    )
    return EvalRun("ocr", f"ocr {params['file']}", params, metrics, _tags("ocr", note), report)


def extract_run(report: Mapping[str, Any]) -> EvalRun:
    """Сверка с эталоном организаторов: полнота по ключу, значению и странице — всего и по параметрам."""
    totals = report.get("totals") or {}
    metrics = {key: float(value) for key, value in totals.items() if isinstance(value, (int, float))}
    by_param: dict[str, list[dict[str, Any]]] = {}
    for point in report.get("points") or []:
        by_param.setdefault(str(point["parameter_code"]), []).append(point)
    for code, points in sorted(by_param.items()):
        for what in ("key", "value", "page"):
            metrics[f"{code}.recall_{what}"] = round(sum(1 for p in points if p[f"found_{what}"]) / len(points), 4)
        metrics[f"{code}.points"] = len(points)
    params = {
        "target": "extract",
        "split": str(report.get("split", "")),
        "gold": Path(str(report.get("gold", ""))).name,
        "matrix": Path(str(report.get("matrix", ""))).name,
        "parameters": ", ".join(sorted(by_param)),
    }
    note = (
        f"Сверка с эталоном ({params['split']}): {metrics.get('points', 0):.0f} точек, полнота по значению "
        f"{metrics.get('recall_value', 0):.2%}, по странице {metrics.get('recall_page', 0):.2%}."
    )
    points = metrics.get("points", 0)
    return EvalRun("extract", f"extract {points:.0f} точек", params, metrics, _tags("extract", note), report)


def cv_run(report: Mapping[str, Any]) -> EvalRun:
    """Компьютерное зрение: классификатор страниц, стадия, локализация и (если мерили) OCR."""
    pages = report.get("pages") or {}
    stage = report.get("stage") or {}
    localization = report.get("localization") or {}
    metrics: dict[str, float] = {}
    for key in ("accuracy", "precision", "recall", "f1", "pages"):
        if isinstance(pages.get(key), (int, float)):
            metrics[f"pages.{key}"] = pages[key]
    for key in ("accuracy", "macro_f1", "files"):
        if isinstance(stage.get(key), (int, float)):
            metrics[f"stage.{key}"] = stage[key]
    for name, values in (stage.get("per_stage") or {}).items():
        metrics[f"stage.{name}.f1"] = values.get("f1", 0.0)
    metrics["localization.page_accuracy"] = (localization.get("page") or {}).get("accuracy", 0.0)
    metrics["localization.iou_ge_05"] = (localization.get("bbox") or {}).get("iou_ge_05", 0.0)
    metrics["localization.center_inside"] = (localization.get("bbox") or {}).get("center_inside", 0.0)
    ocr = report.get("ocr") or {}
    for key in ("character_accuracy", "page_character_accuracy", "cer", "wer", "pages", "seconds_per_page"):
        if isinstance(ocr.get(key), (int, float)):
            metrics[f"ocr.{key}"] = ocr[key]
    for kind, values in (ocr.get("by_kind") or {}).items():
        metrics[f"ocr.{kind}.character_accuracy"] = values.get("character_accuracy", 0.0)
        metrics[f"ocr.{kind}.page_character_accuracy"] = values.get("page_character_accuracy", 0.0)

    note = (
        f"Зрение: страницы «нужен OCR» — accuracy {metrics.get('pages.accuracy', 0):.4f}, "
        f"F1 {metrics.get('pages.f1', 0):.4f}; стадия — accuracy {metrics.get('stage.accuracy', 0):.4f}; "
        f"страница доказательства — {metrics['localization.page_accuracy']:.2%}"
        + (
            f"; OCR Character Accuracy {metrics['ocr.character_accuracy']:.4f}"
            if "ocr.character_accuracy" in metrics
            else ""
        )
        + "."
    )
    params = {"target": "cv", "split": str(report.get("split", "")), "ocr_pages": str(ocr.get("pages", 0))}
    return EvalRun("cv", "cv TRAIN_PUBLIC", params, metrics, _tags("cv", note), report)


# ------------------------------------------------------------------ служебное


def _tags(target: str, note: str) -> dict[str, str]:
    tags = {"inspector.target": target, "mlflow.note.content": note, "mlflow.source.name": "inspector-ml eval"}
    if commit := git_commit():
        tags["mlflow.source.git.commit"] = commit
    return tags


def git_commit() -> str | None:
    """Коммит кода, которым меряли: `GIT_COMMIT` из окружения образа, иначе `git rev-parse` рядом с кодом."""
    if commit := os.environ.get("GIT_COMMIT"):
        return commit
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=Path(__file__).resolve().parent,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    commit = result.stdout.strip()
    return commit if result.returncode == 0 and commit else None


def _file_sha(path: Path) -> str:
    """Короткий хеш матрицы: по нему видно, что между прогонами поменялись якоря, а не код."""
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()[:12]
    except OSError:
        return ""


def _pairs(values: Mapping[str, str]) -> list[dict[str, str]]:
    return [{"key": key, "value": value} for key, value in values.items()]


def _now_ms() -> int:
    return int(time.time() * 1000)
