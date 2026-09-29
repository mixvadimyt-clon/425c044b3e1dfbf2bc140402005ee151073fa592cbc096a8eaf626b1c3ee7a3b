"""Прогоны оценки в MLflow: что уходит на сервер и что бывает, когда сервера нет.

Сервер подменён `httpx.MockTransport`: он записывает запросы и отвечает так, как отвечает
MLflow 3 из compose (`--serve-artifacts`, адреса артефактов `mlflow-artifacts:/…`).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from inspector_ml.cli import main
from inspector_ml.eval import tracking
from inspector_ml.eval.extract_metrics import _same_value
from inspector_ml.eval.tracking import EXPERIMENT, EvalRun, Mlflow, coverage_run, extract_run, ocr_run
from inspector_ml.extract.base import Found

BASE = "http://mlflow:5000/mlflow"


class FakeMlflow:
    """Запоминает запросы и отвечает как MLflow. `experiment` — есть ли уже эксперимент."""

    def __init__(self, *, experiment: bool = True, artifact_uri: str = "mlflow-artifacts:/7/run1/artifacts") -> None:
        self.experiment = experiment
        self.artifact_uri = artifact_uri
        self.requests: list[tuple[str, str, Any]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/mlflow")
        body = json.loads(request.content) if request.content else None
        self.requests.append((request.method, path, body))
        if path.endswith("experiments/get-by-name"):
            if not self.experiment:
                return httpx.Response(404, json={"error_code": "RESOURCE_DOES_NOT_EXIST"})
            return httpx.Response(200, json={"experiment": {"experiment_id": "7", "name": EXPERIMENT}})
        if path.endswith("experiments/create"):
            return httpx.Response(200, json={"experiment_id": "8"})
        if path.endswith("runs/create"):
            return httpx.Response(200, json={"run": {"info": {"run_id": "run1", "artifact_uri": self.artifact_uri}}})
        return httpx.Response(200, json={})

    def paths(self) -> list[str]:
        return [f"{method} {path}" for method, path, _ in self.requests]

    def body(self, suffix: str) -> Any:
        return next(body for _, path, body in self.requests if path.endswith(suffix))


def client(fake: FakeMlflow, base: str = BASE) -> Mlflow:
    return Mlflow(base, client=httpx.Client(transport=httpx.MockTransport(fake)))


RUN = EvalRun(
    "coverage",
    "coverage 22/132",
    params={"target": "coverage", "parser_version": "0.4.0"},
    metrics={"params_found": 22, "params_total": 132},
    tags={"inspector.target": "coverage"},
    report={"found_anywhere": 22, "фрагмент": "Толщина фундаментной плиты 600 мм"},
)


class TestLog:
    def test_whole_run_in_order(self) -> None:
        fake = FakeMlflow()

        assert client(fake).log(RUN) == "run1"
        assert fake.paths() == [
            "GET /api/2.0/mlflow/experiments/get-by-name",
            "POST /api/2.0/mlflow/runs/create",
            "POST /api/2.0/mlflow/runs/log-batch",
            "PUT /api/2.0/mlflow-artifacts/artifacts/7/run1/artifacts/report.json",
            "POST /api/2.0/mlflow/runs/update",
        ]
        created = fake.body("runs/create")
        assert (created["experiment_id"], created["run_name"]) == ("7", "coverage 22/132")
        batch = fake.body("runs/log-batch")
        assert {m["key"]: m["value"] for m in batch["metrics"]} == {"params_found": 22.0, "params_total": 132.0}
        assert {p["key"]: p["value"] for p in batch["params"]} == RUN.params
        assert fake.body("runs/update")["status"] == "FINISHED"

    def test_report_goes_as_utf8_json(self) -> None:
        fake = FakeMlflow()
        client(fake).log(RUN)

        report = fake.body("report.json")
        assert report["фрагмент"] == "Толщина фундаментной плиты 600 мм"

    def test_experiment_is_created_once_missing(self) -> None:
        fake = FakeMlflow(experiment=False)
        client(fake).log(RUN)

        assert fake.body("experiments/create") == {"name": EXPERIMENT}
        assert fake.body("runs/create")["experiment_id"] == "8"

    def test_server_without_served_artifacts(self) -> None:
        """Артефакты на диске сервера — отчёт не отправить, но метрики записаны."""
        fake = FakeMlflow(artifact_uri="/mlflow/artifacts/7/run1/artifacts")

        assert client(fake).log(RUN) == "run1"
        assert not any("mlflow-artifacts" in path for path in fake.paths())

    def test_server_down_is_not_an_error(self) -> None:
        def refuse(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused", request=request)

        mlflow = Mlflow(BASE, client=httpx.Client(transport=httpx.MockTransport(refuse)))

        assert mlflow.log(RUN) is None

    def test_server_error_is_not_an_error(self) -> None:
        mlflow = Mlflow(BASE, client=httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(500))))

        assert mlflow.log(RUN) is None

    @pytest.mark.parametrize("url", ["https://mlflow.example.com/mlflow", "http://8.8.8.8:5000"])
    def test_remote_address_is_refused_without_a_request(self, url: str) -> None:
        """В отчёте фрагменты документов госнадзора — наружу ни одного запроса."""
        fake = FakeMlflow()

        assert client(fake, url).log(RUN) is None
        assert fake.requests == []


class TestRuns:
    def test_coverage(self, tmp_path: Path) -> None:
        matrix = tmp_path / "params.csv"
        matrix.write_text("code\nM-055\n", encoding="utf-8")
        report = {
            "parser_version": "0.4.0",
            "documents": 423,
            "by_stage": {"PD": 205, "RD": 88},
            "objects": ["Новослободская", "Алтуфьевское, 79Б"],
            "params_total": 132,
            "found_anywhere": 22,
            "found_pd_and_rd": 18,
            "found_all_stages": 2,
            "by_data_type": {"number": {"total": 75, "found": 16}},
            "suspicious_total": {"out_of_range": 9},
            "params": [{"code": "M-055", "documents": {"PD": 17, "RD": 28, "ID": 39}, "suspicious": {}}],
        }
        run = coverage_run(report, matrix=matrix, workers=3)

        assert run.name == "coverage 22/132"
        assert run.metrics["params_found"] == 22
        assert run.metrics["param.M-055.documents"] == 84
        assert run.metrics["documents.PD"] == 205
        assert run.metrics["found.number"] == 16
        assert run.metrics["suspicious"] == 9
        assert run.params["matrix_sha256"] and run.params["workers"] == "3"
        assert "22 из 132" in run.tags["mlflow.note.content"]

    def test_ocr(self) -> None:
        report = {"file": "scan.pdf", "engine": "paddle", "dpi": 300, "pages": 5, "character_accuracy": 0.97}
        run = ocr_run({**report, "cer": 0.03, "seconds_per_page": 2.4, "by_page": []})

        assert run.metrics == {"character_accuracy": 0.97, "cer": 0.03, "seconds_per_page": 2.4, "pages": 5.0}
        assert run.params["engine"] == "paddle"

    def test_extract_by_parameter(self) -> None:
        point = {"found_key": True, "found_value": True, "found_page": False}
        report = {
            "split": "TRAIN_PUBLIC",
            "totals": {"points": 3, "recall_value": 0.6667},
            "points": [
                {**point, "parameter_code": "KR-058"},
                {**point, "parameter_code": "PZ-009", "found_page": True},
                {**point, "parameter_code": "PZ-009", "found_value": False},
            ],
        }
        run = extract_run(report)

        assert run.metrics["KR-058.recall_value"] == 1.0
        assert run.metrics["PZ-009.recall_value"] == 0.5
        assert run.metrics["PZ-009.recall_page"] == 0.5
        assert run.params["parameters"] == "KR-058, PZ-009"


class TestGoldValue:
    """KR-058 в эталоне — «1000/1200 мм»: толщины зон, а мы отдаём самую тонкую."""

    @staticmethod
    def found(value: float | str) -> Found:
        return Found(
            rule_key="Фундаментная плита", raw_value=str(value), value=value, page=1, bbox=[0, 0, 1, 1], snippet=""
        )

    @pytest.mark.parametrize(
        ("value", "expected"), [(1000.0, "1000/1200 мм"), (1200.0, "1200/1500 мм"), (159.95, 159.95)]
    )
    def test_number_matches(self, value: float, expected: object) -> None:
        assert _same_value(self.found(value), expected)

    @pytest.mark.parametrize(("value", "expected"), [(900.0, "1000/1200 мм"), (159.0, 159.95)])
    def test_number_does_not_match(self, value: float, expected: object) -> None:
        assert not _same_value(self.found(value), expected)

    def test_grade_by_string(self) -> None:
        assert _same_value(self.found("B40"), "b40")


class TestCommand:
    def test_coverage_with_mlflow(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        from test_coverage import MATRIX_ROW, document, write_cache, write_matrix

        write_cache(tmp_path, [document("PD", "Общая площадь 3009,4")])
        matrix = write_matrix(tmp_path / "params.csv", [MATRIX_ROW])
        logged: list[tuple[str, EvalRun]] = []

        def fake_log(self: Mlflow, run: EvalRun, experiment: str = EXPERIMENT) -> str:
            logged.append((self.base_url, run))
            return "run1"

        monkeypatch.setattr(tracking.Mlflow, "log", fake_log)
        args = ["eval", "coverage", str(tmp_path), "--parser-version", "0.4.0", "--matrix", str(matrix)]
        code = main([*args, "--mlflow", "http://localhost:5000/mlflow"])

        assert code == 0
        assert [(url, run.target) for url, run in logged] == [("http://localhost:5000/mlflow", "coverage")]
        output = capsys.readouterr()
        assert json.loads(output.out)["found_anywhere"] == 1  # отчёт напечатан как раньше
        assert "run1" in output.err

    def test_mlflow_without_address(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        from test_coverage import MATRIX_ROW, document, write_cache, write_matrix

        monkeypatch.setenv("MLFLOW_URL", "")
        write_cache(tmp_path, [document("PD", "Общая площадь 3009,4")])
        matrix = write_matrix(tmp_path / "params.csv", [MATRIX_ROW])
        args = ["eval", "coverage", str(tmp_path), "--parser-version", "0.4.0", "--matrix", str(matrix), "--mlflow"]

        assert main(args) == 0
        assert "адрес не задан" in capsys.readouterr().err
