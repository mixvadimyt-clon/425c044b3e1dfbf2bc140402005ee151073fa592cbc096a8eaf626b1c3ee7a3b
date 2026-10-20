"""Скорер кандидатов: выгрузка набора, обучение, метрики, файл модели, применение, команда.

Данные синтетические: решений инспектора на стенде ещё нет, а публичные проверки организаторов
(10 штук, все — нарушения) для классификатора не годятся. Правило в данных простое и честное:
инспектор подтверждает расхождение больше 10 % и отклоняет мелкие, — модель должна его выучить.
"""

from __future__ import annotations

import hashlib
import json
import random
from dataclasses import asdict
from pathlib import Path
from typing import Any
from uuid import uuid4

import httpx
import pytest

from inspector_ml import matrix
from inspector_ml.cli import main
from inspector_ml.contracts.events import CompareResult
from inspector_ml.jobs import handlers
from inspector_ml.scorer.api_client import ApiError, InspectorApi
from inspector_ml.scorer.apply import apply, model_path
from inspector_ml.scorer.dataset import check_hashes, read_export
from inspector_ml.scorer.features import FeatureSpace, from_gold
from inspector_ml.scorer.model import KIND, LogisticModel, threshold_for_recall
from inspector_ml.scorer.train import NotEnoughData, registration, train

PARAMS = ("M-001", "M-002", "M-055")


def gold(split: str, expected: float, actual: float, *, code: str = "M-002", ocr: bool = False) -> dict[str, Any]:
    """Строка выгрузки: решение инспектора по кандидату «эталон / факт»."""
    label = "POSITIVE" if abs(actual - expected) / expected > 0.1 else "NEGATIVE"
    source = {"file_id": "F1", "sha256": "0" * 64, "stage": "RD", "page": 1, "bbox_polygon": [0, 0, 1, 1]}
    return {
        "item_id": str(uuid4()),
        "split": split,
        "gold_label": label,
        "released_in": "gold-1",
        "param_code": code,
        "record": {
            "matrix_code": code,
            "rule_key": None,
            "expected_value": f"{expected:.1f}",
            "actual_value": f"{actual:.1f}",
            "review_priority": "HIGH",
            "source_expected_stage": "PD",
            "source_actual_stage": "RD",
            "source_expected_approval": "APPROVED",
            "source_actual_approval": "APPROVED",
            "source_expected": [{**source, "stage": "PD"}],
            "source_actual": [{**source, "source": "OCR" if ocr else "TEXT_LAYER"}],
        },
    }


def export_text(train: int = 60, validation: int = 30, hidden: int = 10, seed: int = 1) -> str:
    rng = random.Random(seed)
    lines = []
    for split, count in (("TRAIN", train), ("VALIDATION", validation), ("HIDDEN_TEST", hidden)):
        for index in range(count):
            expected = rng.uniform(100, 5000)
            # половина — мелкие расхождения до 3 %, половина — крупные от 20 до 60 %
            change = rng.uniform(0, 0.03) if index % 2 else rng.uniform(0.2, 0.6)
            record = gold(split, expected, expected * (1 + change), code=PARAMS[index % len(PARAMS)])
            lines.append(json.dumps(record, ensure_ascii=False))
    return "\n".join(lines) + "\n"


@pytest.fixture
def params() -> dict:
    loaded = matrix.load_params()
    if not loaded:  # pragma: no cover — матрица лежит в репозитории рядом
        pytest.skip("нет матрицы")
    return loaded


class TestExport:
    def test_split_hash_is_over_raw_lines(self) -> None:
        text = export_text(train=3, validation=2, hidden=1)
        lines = text.splitlines()
        expected = hashlib.sha256("".join(line + "\n" for line in lines[:3]).encode("utf-8")).hexdigest()

        export = read_export(text)

        assert export.split_hashes["TRAIN"] == expected
        assert len(export.part("VALIDATION")) == 2

    def test_reserialized_json_would_not_match(self) -> None:
        """Хеш — по строкам как пришли: переписанный JSON дал бы другой хеш, и api не принял бы модель."""
        text = export_text(train=2, validation=1, hidden=0)
        compact = [json.dumps(json.loads(line), separators=(",", ":")) for line in text.splitlines()]
        rewritten = "\n".join(compact) + "\n"

        assert read_export(text).split_hashes != read_export(rewritten).split_hashes

    def test_mismatch_is_reported(self) -> None:
        export = read_export(export_text(train=2, validation=1, hidden=0))

        assert check_hashes(export, dict(export.split_hashes)) == []
        assert check_hashes(export, {**export.split_hashes, "TRAIN": "0" * 64})

    def test_empty_part_has_the_hash_of_an_empty_set(self) -> None:
        """Как в `ds-2026.09.1` на стенде: в HIDDEN_TEST ноль записей, api отдаёт для неё хеш пустого набора."""
        export = read_export(export_text(hidden=0))
        empty = hashlib.sha256(b"").hexdigest()

        assert export.split_hashes["HIDDEN_TEST"] == empty
        assert check_hashes(export, {**export.split_hashes, "HIDDEN_TEST": empty}) == []


class TestTrain:
    def test_learns_the_inspector_rule(self, params: dict) -> None:
        trained = train(read_export(export_text()), params, dataset_version="gold-1", model_version="scorer-t")

        assert trained.metrics["recall"] >= 0.9
        assert trained.metrics["precision"] >= 0.9
        assert trained.metrics["sample_size"] == 30
        assert 0.0 < trained.model.threshold <= 0.5
        assert set(trained.metrics["ci95"]) == {"precision", "recall", "f1", "false_positive_rate"}
        assert trained.metrics["per_category"]  # по разделам — для проверки регрессии в api

    def test_hidden_test_is_never_used(self, params: dict) -> None:
        """HIDDEN_TEST не влияет ни на веса, ни на метрики — даже с перевёрнутыми метками."""
        text = export_text()
        flipped = []
        for line in text.splitlines():
            record = json.loads(line)
            if record["split"] == "HIDDEN_TEST":
                record["gold_label"] = "NEGATIVE" if record["gold_label"] == "POSITIVE" else "POSITIVE"
            flipped.append(json.dumps(record, ensure_ascii=False))
        a = train(read_export(text), params, dataset_version="g", model_version="a")
        b = train(read_export("\n".join(flipped) + "\n"), params, dataset_version="g", model_version="a")

        assert a.model.weights == b.model.weights
        assert a.metrics == b.metrics

    def test_too_few_decisions_is_refused(self, params: dict) -> None:
        with pytest.raises(NotEnoughData, match="нужно не меньше"):
            train(read_export(export_text(train=8)), params, dataset_version="g", model_version="m")

    def test_lower_threshold_is_recorded(self, params: dict) -> None:
        """Порог ниже 10 (первая итерация на настоящих объектах) разрешён, но виден в модели и в регистрации."""
        trained = train(
            read_export(export_text(train=8)), params, dataset_version="g", model_version="m", min_per_class=3
        )
        payload = registration(trained, "a" * 64, {"TRAIN": "h1"})

        assert trained.model.meta["min_per_class"] == 3
        assert trained.report["min_per_class"] == 3
        assert payload["training_params"]["min_per_class"] == 3
        assert payload["training_params"]["train_positives"] == 4
        assert payload["training_params"]["train_negatives"] == 4

    def test_no_validation_is_refused(self, params: dict) -> None:
        with pytest.raises(NotEnoughData, match="VALIDATION"):
            train(read_export(export_text(validation=0)), params, dataset_version="g", model_version="m")

    def test_registration_matches_the_contract(self, params: dict) -> None:
        trained = train(read_export(export_text()), params, dataset_version="gold-1", model_version="scorer-t")
        payload = registration(trained, "a" * 64, {"TRAIN": "h1"})

        assert {"model_version", "artifact_hash", "dataset_version", "split_hashes", "metrics"} <= set(payload)
        assert {"precision", "recall", "f1", "false_positive_rate"} <= set(payload["metrics"])


class TestModelFile:
    def test_round_trip_and_hash(self, params: dict, tmp_path: Path) -> None:
        trained = train(read_export(export_text()), params, dataset_version="g", model_version="scorer-t")
        path = tmp_path / "scorer-t.json"
        artifact_hash = trained.model.save(path)

        assert artifact_hash == hashlib.sha256(path.read_bytes()).hexdigest()
        assert LogisticModel.load(path).weights == trained.model.weights

    def test_other_json_is_not_a_model(self, tmp_path: Path) -> None:
        path = tmp_path / "x.json"
        path.write_text(json.dumps({"kind": "something"}), encoding="utf-8")

        with pytest.raises(ValueError, match="не модель скорера"):
            LogisticModel.load(path)

    def test_threshold_keeps_recall(self) -> None:
        assert threshold_for_recall([0.1, 0.6, 0.7, 0.8], 0.75) == pytest.approx(0.5)  # не выше 0.5
        assert threshold_for_recall([0.1, 0.2, 0.3, 0.4], 0.75) == pytest.approx(0.2)  # выше порога 3 из 4
        assert threshold_for_recall([], 0.95) == 0.0


def check(expected: str, actual: str, status: str = "CANDIDATE") -> dict[str, Any]:
    fragment = {
        "file_id": str(uuid4()),
        "sha256": "0" * 64,
        "page": 1,
        "bbox": [0, 0, 1, 1],
        "approval_status": "APPROVED",
    }
    return {
        "finding_key": str(uuid4()),
        "param_code": "M-002",
        "finding_status": status,
        "completeness_status": "COMPLETE",
        "expected_value": expected,
        "actual_value": actual,
        "review_priority": "HIGH",
        "rationale": "ПД: X; РД: Y.",
        "fragments": [
            {**fragment, "role": "EXPECTED", "stage": "PD", "source": "TEXT_LAYER"},
            {**fragment, "role": "ACTUAL", "stage": "RD", "source": "TEXT_LAYER"},
        ],
    }


def compare_result(*checks: dict[str, Any]) -> CompareResult:
    return CompareResult.model_validate(
        {
            "process_id": str(uuid4()),
            "protocol_version": 1,
            "status": "OK",
            "checks": list(checks),
            "versions": {
                "matrix_version": "m",
                "model_version": "rules-0.1.0",
                "dataset_version": "none",
                "input_manifest_hash": "0" * 64,
            },
        }
    )


class TestApply:
    @pytest.fixture
    def model(self, params: dict) -> LogisticModel:
        return train(read_export(export_text()), params, dataset_version="g", model_version="scorer-t").model

    def test_lowers_only_empty_candidates(self, model: LogisticModel, params: dict) -> None:
        result = compare_result(
            check("3009.4", "3010.1"), check("3009.4", "4500.0"), check("1", "1", "NEGATIVE_VERIFIED")
        )
        scored = apply(result, model, params)
        statuses = [c.finding_status for c in scored.checks]

        assert statuses == ["NEGATIVE_VERIFIED", "CANDIDATE", "NEGATIVE_VERIFIED"]
        assert "Скорер scorer-t" in scored.checks[0].rationale
        assert scored.checks[0].rationale.startswith("ПД: X; РД: Y.")  # объяснение правил сохранено
        assert scored.checks[1] == result.checks[1]
        assert scored.versions.model_version == "scorer-t"

    def test_features_must_match_the_code(self, model: LogisticModel, params: dict) -> None:
        model.features = [*model.features[:-1], "другой признак"]

        with pytest.raises(ValueError, match="переобучите"):
            apply(compare_result(check("1", "2")), model, params)

    def test_same_features_for_gold_and_check(self, params: dict) -> None:
        """Признаки при обучении и при применении считаются одинаково — иначе модель судит не по тому."""
        from inspector_ml.scorer.features import from_check

        record = gold("TRAIN", 3009.4, 4500.0)["record"]
        result = compare_result(check("3009.4", "4500.0"))
        section_of = {code: str(p.section or "") for code, p in params.items()}
        space = FeatureSpace(section_of.values())

        assert space.vector(from_gold(record), section_of) == space.vector(from_check(result.checks[0]), section_of)


class TestSbertFeature:
    """Пометка Sentence-BERT во фрагменте (контракт 0.23.0) — признак скорера с обеих сторон."""

    def test_gold_without_the_key_is_rules(self) -> None:
        record = gold("TRAIN", 3009.4, 4500.0)["record"]
        assert from_gold(record).sbert is False  # снимки GOLD до 0.23.0 (ds-2026.09.1) — ключа нет вовсе

        record["source_actual"][0]["extraction_method"] = "RULES"
        assert from_gold(record).sbert is False

        record["source_actual"][0]["extraction_method"] = "SBERT"
        assert from_gold(record).sbert is True

    def test_check_with_a_fragment_found_by_sbert(self) -> None:
        from inspector_ml.scorer.features import from_check

        marked = check("3009.4", "4500.0")
        marked["fragments"][1]["extraction_method"] = "SBERT"

        assert from_check(compare_result(marked).checks[0]).sbert is True
        assert from_check(compare_result(check("3009.4", "4500.0")).checks[0]).sbert is False

    def test_constant_feature_does_not_break_training(self, params: dict) -> None:
        """В ds-2026.09.2 пометок SBERT не будет: признак постоянный, его вес должен остаться нулевым."""
        model = train(read_export(export_text()), params, dataset_version="g", model_version="scorer-t").model

        assert abs(model.weights[model.features.index("sbert")]) < 1e-9

    def test_model_trained_before_the_feature_still_applies(self, params: dict) -> None:
        model = train(read_export(export_text()), params, dataset_version="g", model_version="scorer-t").model
        i = model.features.index("sbert")
        old = LogisticModel(
            **{
                **asdict(model),
                **{name: [*getattr(model, name)[:i], *getattr(model, name)[i + 1 :]] for name in _PER_FEATURE},
            }
        )
        result = compare_result(check("3009.4", "3010.1"), check("3009.4", "4500.0"))

        assert "sbert" not in old.features
        assert [c.finding_status for c in apply(result, old, params).checks] == [
            c.finding_status for c in apply(result, model, params).checks
        ]


#: Списки модели, по одному значению на признак.
_PER_FEATURE = ("features", "weights", "mean", "scale")


class TestHandler:
    def request(self, model_version: str | None) -> Any:
        from inspector_ml.contracts.events import CompareRequest

        return CompareRequest.model_construct(versions=type("V", (), {"model_version": model_version})())

    def test_no_model_means_rules_only(self, settings: Any) -> None:
        result = compare_result(check("3009.4", "3010.1"))

        assert handlers._with_scorer(result, settings, self.request(None)) is result
        assert handlers._with_scorer(result, settings, self.request("scorer-нет")) is result

    def test_broken_model_does_not_break_the_check(self, settings: Any) -> None:
        path = model_path(settings.storage_dir, "scorer-bad")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{битый json", encoding="utf-8")
        result = compare_result(check("3009.4", "3010.1"))

        assert handlers._with_scorer(result, settings, self.request("scorer-bad")) is result

    def test_model_from_storage_is_applied(self, settings: Any, params: dict) -> None:
        trained = train(read_export(export_text()), params, dataset_version="g", model_version="scorer-t")
        trained.model.save(model_path(settings.storage_dir, "scorer-t"))
        result = compare_result(check("3009.4", "3010.1"))

        scored = handlers._with_scorer(result, settings, self.request("scorer-t"))

        assert scored.checks[0].finding_status == "NEGATIVE_VERIFIED"

    def test_sections_come_from_the_request_matrix(
        self, settings: Any, params: dict, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """В образе ML нет `data/matrix`: раздел параметра берётся из матрицы запроса."""
        from inspector_ml.contracts.events import CompareRequest
        from inspector_ml.scorer import apply as apply_module

        trained = train(read_export(export_text()), params, dataset_version="g", model_version="scorer-t")
        trained.model.save(model_path(settings.storage_dir, "scorer-t"))
        monkeypatch.setattr(matrix, "load_params", lambda *_args, **_kwargs: {})  # как в образе
        seen: dict = {}
        original = apply_module.apply

        def spy(result: Any, model: Any, used: Any) -> Any:
            seen.update(used)
            return original(result, model, used)

        monkeypatch.setattr(apply_module, "apply", spy)
        request = CompareRequest.model_construct(
            versions=type("V", (), {"model_version": "scorer-t"})(),
            matrix=type("M", (), {"params": list(params.values())})(),
        )

        handlers._with_scorer(compare_result(check("3009.4", "3010.1")), settings, request)

        assert set(seen) == set(params)
        assert {str(p.section) for p in seen.values()} != {""}


class TestThreshold:
    """Порог понижения при малом числе подтверждённых.

    По одной подтверждённой записи порог «сохранить 95 % подтверждённых» равен её вероятности на собственных
    данных и упирался в потолок 0,5: `scorer-ds-2026.09.2` понизила бы почти всех кандидатов.
    """

    @staticmethod
    def export(positives: int) -> str:
        rows = [gold("TRAIN", 1000.0, 1500.0 + 10 * i) for i in range(positives)]
        rows += [gold("TRAIN", 1000.0, 1005.0 + i) for i in range(20)]
        rows += [gold("VALIDATION", 1000.0, 1400.0), gold("VALIDATION", 1000.0, 1002.0)]
        return "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows)

    def test_few_positives_cap_the_threshold(self, params: dict) -> None:
        trained = train(read_export(self.export(2)), params, dataset_version="g", model_version="s", min_per_class=1)

        assert trained.model.threshold == 0.2
        assert trained.model.meta["threshold_source"] == "few_positives"
        assert registration(trained, "0" * 64, {})["training_params"]["threshold_source"] == "few_positives"

    def test_explicit_threshold_wins(self, params: dict) -> None:
        trained = train(
            read_export(self.export(2)), params, dataset_version="g", model_version="s", min_per_class=1, threshold=0.05
        )

        assert (trained.model.threshold, trained.model.meta["threshold_source"]) == (0.05, "manual")

    def test_enough_positives_keep_the_recall_threshold(self, params: dict) -> None:
        trained = train(read_export(export_text()), params, dataset_version="g", model_version="s")

        assert trained.model.meta["threshold_source"] == "keep_recall"

    def test_threshold_above_half_is_rejected(self) -> None:
        with pytest.raises(SystemExit):
            main(["train", "--dataset", "g", "--threshold", "0.7"])


def decided(split: str, expected: str, actual: str, label: str) -> dict[str, Any]:
    """Строка выгрузки с решением инспектора как есть — не по правилу «больше 10 %»."""
    row = gold(split, 1.0, 1.0)
    row["gold_label"] = label
    row["record"].update(expected_value=expected, actual_value=actual)
    return row


class TestFewData:
    """Режим «мало данных»: меньше 5 подтверждённых — модель только на `log_ratio`, только числовые кандидаты.

    Как в `ds-2026.09.2` на стенде: подтверждено расхождение в проценты, отклонены ошибки извлечения — числа в разы
    и на порядки. На всех признаках такая модель понижала внесённые ошибки контрольного комплекта 3.
    """

    @staticmethod
    def export() -> str:
        rows = [
            decided("TRAIN", "1000.0", "1300.0", "POSITIVE"),
            decided("TRAIN", "14.9", "15.2", "POSITIVE"),
            decided("TRAIN", "41.7", "3793.1", "NEGATIVE"),
            decided("TRAIN", "520.2", "15.8", "NEGATIVE"),
            decided("TRAIN", "10.8", "2192.9", "NEGATIVE"),
            decided("TRAIN", "кирпич", "бетон", "NEGATIVE"),  # нечисловая — в обучение не идёт
            decided("VALIDATION", "3009.4", "3400.0", "POSITIVE"),
            decided("VALIDATION", "9.6", "9600.0", "NEGATIVE"),
            decided("VALIDATION", "кирпич", "бетон", "POSITIVE"),  # не оценивается — остаётся кандидатом
        ]
        return "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows)

    @pytest.fixture
    def trained(self, params: dict) -> Any:
        return train(read_export(self.export()), params, dataset_version="g", model_version="few", min_per_class=1)

    def test_only_the_ratio_feature(self, trained: Any) -> None:
        assert trained.model.features == ["log_ratio"]
        assert trained.model.meta["mode"] == "few_data"
        assert trained.model.meta["numeric_only"] is True
        assert trained.model.weights[0] < 0  # чем больше разошлись в разах, тем меньше шансов на нарушение
        assert trained.metrics["recall"] == 1.0  # нечисловой подтверждённый не понижен
        assert trained.metrics["false_positive_rate"] == 0.0
        assert registration(trained, "0" * 64, {})["training_params"]["mode"] == "few_data"

    def test_lowers_gross_ratios_and_keeps_the_rest(self, trained: Any, params: dict) -> None:
        result = compare_result(check("4.2", "3793.1"), check("1000.0", "1350.0"), check("кирпич", "бетон"))

        statuses = [c.finding_status for c in apply(result, trained.model, params).checks]

        assert statuses == ["NEGATIVE_VERIFIED", "CANDIDATE", "CANDIDATE"]

    @pytest.mark.parametrize(
        ("code", "expected", "actual"),
        [
            ("M-023", "С0", "С1"),
            ("M-107", "КМ0", "КМ3"),
            ("M-012", "0", "24"),
            ("M-029", "исполнение 1 по проекту", "исполнение 2, изменено"),
            ("M-009", "-2.950", "3.000"),
        ],
    )
    def test_no_ratio_no_score(self, trained: Any, params: dict, code: str, expected: str, actual: str) -> None:
        """На стенде: `number` брал цифру из марки, ноль против числа давал потолок `log_ratio`, и
        скорер понижал внесённые ошибки С0 → С1, КМ0 → КМ3, 0 → 24. У марки, текста с цифрой, нуля и значений
        разных знаков отношения нет — модель «мало данных» таких кандидатов не оценивает."""
        candidate = check(expected, actual)
        candidate["param_code"] = code

        assert apply(compare_result(candidate), trained.model, params).checks[0].finding_status == "CANDIDATE"

    def test_ratio_is_defined_only_for_plain_numbers(self, params: dict) -> None:
        from inspector_ml.scorer.features import from_check, log_ratio

        section_of = {code: str(p.section or "") for code, p in params.items()}
        space = FeatureSpace(section_of.values())
        defined = space.names.index("ratio_defined")

        def vector(expected: str, actual: str) -> list[float]:
            return space.vector(from_check(compare_result(check(expected, actual)).checks[0]), section_of)

        assert vector("41.7", "3793.1")[defined] == 1.0
        assert vector("12 480,6", "11 905,3 м²")[defined] == 1.0
        assert vector("С0", "С1")[defined] == 0.0
        assert vector("B25", "B30")[defined] == 0.0
        assert vector("0", "24")[defined] == 0.0
        assert log_ratio(0.0, 24.0) is None
        assert log_ratio(-2.95, 3.0) is None
        assert log_ratio(1.0, 10_000.0) == 6.0  # потолок

    def test_saved_model_keeps_the_mode(self, trained: Any, params: dict, tmp_path: Path) -> None:
        path = tmp_path / "few.json"
        trained.model.save(path)
        result = compare_result(check("кирпич", "бетон"))

        assert apply(result, LogisticModel.load(path), params).checks[0].finding_status == "CANDIDATE"

    def test_numeric_records_of_one_class_are_refused(self, params: dict) -> None:
        rows = [
            decided("TRAIN", "1000.0", "1300.0", "POSITIVE"),
            decided("TRAIN", "кирпич", "бетон", "NEGATIVE"),
            decided("VALIDATION", "3009.4", "3400.0", "POSITIVE"),
        ]
        text = "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows)

        with pytest.raises(NotEnoughData, match="числовых"):
            train(read_export(text), params, dataset_version="g", model_version="few", min_per_class=1)

    def test_full_mode_with_enough_positives(self, params: dict) -> None:
        model = train(read_export(export_text()), params, dataset_version="g", model_version="scorer-t").model

        assert model.meta["mode"] == "full"
        assert model.meta["numeric_only"] is False
        assert "log_ratio" in model.features


class TestCommand:
    def test_train_from_export_file(
        self, tmp_path: Path, settings: Any, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        export = tmp_path / "gold-1.jsonl"
        export.write_text(export_text(), encoding="utf-8")
        monkeypatch.setenv("STORAGE_DIR", str(settings.storage_dir))

        code = main(["train", "--dataset", "gold-1", "--export", str(export), "--model-version", "scorer-t"])

        assert code == 0
        report = json.loads(capsys.readouterr().out)
        assert Path(report["model_path"]).is_file()
        assert report["artifact_hash"] == hashlib.sha256(Path(report["model_path"]).read_bytes()).hexdigest()
        assert json.loads(Path(report["model_path"]).read_text(encoding="utf-8"))["kind"] == KIND

    def test_register_sends_the_contract_payload(
        self, tmp_path: Path, settings: Any, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        export = tmp_path / "gold-1.jsonl"
        export.write_text(export_text(), encoding="utf-8")
        monkeypatch.setenv("STORAGE_DIR", str(settings.storage_dir))
        sent: list[dict] = []
        monkeypatch.setattr(InspectorApi, "register", lambda self, payload: sent.append(payload) or {"ok": True})

        code = main(
            ["train", "--dataset", "gold-1", "--export", str(export), "--model-version", "scorer-r", "--register"]
        )

        assert code == 0
        assert sent[0]["model_version"] == "scorer-r"
        assert sent[0]["split_hashes"] == read_export(export.read_text(encoding="utf-8")).split_hashes

    def test_too_little_data_is_an_error_with_a_reason(
        self, tmp_path: Path, settings: Any, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        export = tmp_path / "gold-1.jsonl"
        export.write_text(export_text(train=6), encoding="utf-8")
        monkeypatch.setenv("STORAGE_DIR", str(settings.storage_dir))

        assert main(["train", "--dataset", "gold-1", "--export", str(export)]) == 1
        assert "Обучать не на чем" in capsys.readouterr().err

    def test_min_per_class_flag(
        self, tmp_path: Path, settings: Any, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        export = tmp_path / "gold-1.jsonl"
        export.write_text(export_text(train=6), encoding="utf-8")
        monkeypatch.setenv("STORAGE_DIR", str(settings.storage_dir))

        code = main(
            ["train", "--dataset", "gold-1", "--export", str(export), "--model-version", "s", "--min-per-class", "3"]
        )

        assert code == 0
        report = json.loads(capsys.readouterr().out)
        assert report["min_per_class"] == 3
        assert json.loads(Path(report["model_path"]).read_text(encoding="utf-8"))["meta"]["min_per_class"] == 3


class TestApiClient:
    def test_logs_in_once_and_sends_the_token(self) -> None:
        seen: list[tuple[str, str | None]] = []

        def server(request: httpx.Request) -> httpx.Response:
            seen.append((request.url.path, request.headers.get("Authorization")))
            if request.url.path.endswith("/auth/login"):
                return httpx.Response(200, json={"access_token": "t1", "expires_in": 60, "user": {}})
            if request.url.path.endswith("/export"):
                return httpx.Response(200, text='{"split": "TRAIN"}\n')
            return httpx.Response(200, json=[{"version": "gold-1", "split_hashes": {"TRAIN": "h"}}])

        api = InspectorApi(
            "http://api:3000", "ml", "secret", client=httpx.Client(transport=httpx.MockTransport(server))
        )

        assert api.export("gold-1") == '{"split": "TRAIN"}\n'
        assert api.dataset_version("gold-1") == {"version": "gold-1", "split_hashes": {"TRAIN": "h"}}
        assert [path for path, _ in seen].count("/api/v1/auth/login") == 1
        assert seen[-1][1] == "Bearer t1"

    def test_without_credentials(self) -> None:
        api = InspectorApi("http://api:3000", "", "")

        with pytest.raises(ApiError, match="ML_API_LOGIN"):
            api.export("gold-1")

    def test_api_error_carries_the_reason(self) -> None:
        def server(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/auth/login"):
                return httpx.Response(200, json={"access_token": "t1"})
            return httpx.Response(404, json={"message": "Нет такой версии"})

        api = InspectorApi(
            "http://api:3000", "ml", "secret", client=httpx.Client(transport=httpx.MockTransport(server))
        )

        with pytest.raises(ApiError, match="Нет такой версии"):
            api.export("gold-9")
