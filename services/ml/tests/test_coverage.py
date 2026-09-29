"""Замер находимости параметров на кеше разбора (`inspector-ml eval coverage`)."""

from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any

import pytest

from inspector_ml.cli import main
from inspector_ml.contracts.events import MatrixParam
from inspector_ml.eval.coverage import (
    Source,
    document_coverage,
    measure,
    object_of,
    parsed_files,
    summarize,
    suspicions,
)
from inspector_ml.extract.base import Found

COLUMNS = ["code", "section", "parameter_name", "unit", "review_priority", "data_type", "min_value",
           "max_value", "regex_pattern", "semantic_anchors", "enum_values", "is_active"]  # fmt: skip


def param(code: str, *, data_type: str = "number", **fields: Any) -> MatrixParam:
    return MatrixParam.model_validate(
        {
            "id": 1,
            "created_at": "2026-09-24T10:00:00Z",
            "updated_at": "2026-09-24T10:00:00Z",
            "code": code,
            "section": "ПЗ",
            "parameter_name": fields.pop("name", "Параметр"),
            "review_priority": "HIGH",
            "data_type": data_type,
            **fields,
        }
    )


def found(raw: str, value: object, *, page: int = 1) -> Found:
    return Found(rule_key=None, raw_value=raw, value=value, page=page, bbox=[0, 0, 1, 1], snippet=raw)


def block(index: int, text: str) -> dict[str, Any]:
    return {"id": f"b{index}", "type": "text", "text": text, "bbox": [0, 0.1 * index, 1, 0.1 * index + 0.05]}


def document(stage: str, *texts: str, sha: str = "a" * 64) -> dict[str, Any]:
    return {
        "sha256": sha,
        "metadata": {"doc_stage": stage, "discipline": "ПЗ", "document_code": "ПЗ-1"},
        "pages": [{"page": 1, "blocks": [block(i, t) for i, t in enumerate(texts)], "tables": []}],
    }


#: Параметр без своего извлекателя: у M-002 и M-055 свой разбор, а замер должен пройти общий путь.
AREA = param("M-010", name="Общая площадь", regex_pattern=r"(?i)общая площадь\s+([\d\s]+[.,]?\d*)")


class TestObjectOfPath:
    """Объект — папка перед первой папкой стадии: так устроены выгрузки организаторов."""

    @pytest.mark.parametrize(
        ("relative", "expected"),
        [
            ("Речников ул. 7-7/ПД/01-ПЗ.pdf", "Речников ул. 7-7"),
            ("Алтуфьевское, 79Б/Проектная документация/3. АР.pdf", "Алтуфьевское, 79Б"),
            ("Новослободская/Новослободская/Стадия П/ПЗ.pdf", "Новослободская"),
            ("01_ДОКУМЕНТАЦИЯ/Речников ул. 7-7/ИД/акт.pdf", "Речников ул. 7-7"),
            ("Пример/Рабочая и исполнительная документация/КЖ.pdf", "Пример"),
        ],
    )
    def test_folder_before_the_stage(self, relative: str, expected: str) -> None:
        assert object_of(Path(relative)) == expected

    def test_without_stage_folder_the_top_folder_is_the_object(self) -> None:
        assert object_of(Path("Объект/разное/файл.pdf")) == "Объект"

    def test_file_in_the_root_has_no_object(self) -> None:
        assert object_of(Path("файл.pdf")) is None


class TestSuspicions:
    """Подозрительное — список для глаз, чтобы ложные значения не прятались за ростом находимости."""

    def test_number_outside_the_matrix_range(self) -> None:
        bounded = param("M-010", min_value=0, max_value=100)

        assert suspicions(found("250", 250.0), bounded) == ["out_of_range"]
        assert suspicions(found("50", 50.0), bounded) == []

    def test_numeric_parameter_without_a_number(self) -> None:
        assert suspicions(found("нет", None), param("M-011")) == ["not_a_number"]

    def test_text_point_of_a_numeric_parameter_is_by_design(self) -> None:
        """«пом. 1.09 (назначение)» у M-002 несёт наименование: на первом замере — 1879 ложных тревог."""
        assert suspicions(found("Вестибюль", "Вестибюль"), param("M-002")) == []

    def test_concrete_class_glued_to_its_marks_is_not_a_fragment(self) -> None:
        """«В50» из «БСТ В50F150W4» — так класс бетона и пишут: 316 ложных тревог у M-055."""
        classes = param("M-055", data_type="enum", enum_values=["B50"])
        glued = Found(
            rule_key=None, raw_value="В50", value="B50", page=1, bbox=[0, 0, 1, 1],
            snippet="Колонны из бетона БСТ В50F150W4 по ГОСТ 26633",
        )  # fmt: skip

        assert suspicions(glued, classes) == []

    def test_letter_torn_from_a_word(self) -> None:
        """«а» из «класс энергоэффективности лифта» — так на замере 24.09 находились M-021 и M-124."""
        text = param("M-021", data_type="string")
        torn = Found(
            rule_key=None, raw_value="а", value="а", page=1, bbox=[0, 0, 1, 1],
            snippet="класс энергетической эффективности лифта",
        )  # fmt: skip

        assert suspicions(torn, text) == ["word_fragment"]

    @pytest.mark.parametrize("value", ["A+", "B", "А"])
    def test_short_class_standing_alone_is_honest(self, value: str) -> None:
        """«A+» и «B» — законные классы энергоэффективности: короткость сама по себе не признак."""
        text = param("M-021", data_type="string")
        alone = Found(
            rule_key=None, raw_value=value, value=value, page=1, bbox=[0, 0, 1, 1],
            snippet=f"Класс энергетической эффективности здания {value}",
        )  # fmt: skip

        assert suspicions(alone, text) == []

    def test_value_outside_the_enum(self) -> None:
        classes = param("M-055", data_type="enum", enum_values=["B25", "B30"])

        assert "not_in_enum" in suspicions(found("B50", "B50"), classes)

    def test_cyrillic_lookalike_is_inside_the_enum(self) -> None:
        """«В30» кириллицей и «B30» латиницей — одно значение, подозревать нечего."""
        classes = param("M-055", data_type="enum", enum_values=["B25", "B30"])

        assert suspicions(found("В30", "B30"), classes) == []


class TestDocumentCoverage:
    def test_value_is_found_with_a_sample(self) -> None:
        row = document_coverage(document("PD", "Общая площадь 3009,4 м2"), {"M-010": AREA})

        hit = row["found"]["M-010"]
        assert hit["values"] == 1
        assert hit["methods"] == {"regex": 1}
        page, raw, _snippet, method, reasons = hit["samples"][0]
        assert (page, raw.strip(), method, reasons) == (1, "3009,4", "regex", [])

    def test_nothing_found_leaves_no_entry(self) -> None:
        row = document_coverage(document("PD", "Пояснительная записка"), {"M-010": AREA})

        assert row["found"] == {}

    def test_source_labels_the_row(self) -> None:
        row = document_coverage(document("RD", "текст"), {"M-010": AREA}, Source(file="ПЗ.pdf", object="Объект"))

        assert (row["file"], row["object"], row["stage"]) == ("ПЗ.pdf", "Объект", "RD")

    def test_number_taken_by_three_parameters_is_shared(self) -> None:
        """Одно число с одной страницы у трёх параметров — так выглядит число из чужой фразы."""
        grab = {code: param(code, regex_pattern=r"(\d{3})") for code in ("M-101", "M-102", "M-103")}

        row = document_coverage(document("PD", "отметка 900"), grab)

        assert all(row["found"][code]["suspicious"] == {"shared_value": 1} for code in grab)

    def test_two_parameters_on_one_number_are_not_yet_suspicious(self) -> None:
        grab = {code: param(code, regex_pattern=r"(\d{3})") for code in ("M-101", "M-102")}

        row = document_coverage(document("PD", "отметка 900"), grab)

        assert all(row["found"][code]["suspicious"] == {} for code in grab)

    def test_broken_parameter_does_not_stop_the_others(self, monkeypatch: pytest.MonkeyPatch) -> None:
        import inspector_ml.eval.coverage as coverage

        real = coverage.extractor_for

        def failing(code: str):
            if code == "M-999":
                return lambda param, pages: 1 / 0
            return real(code)

        monkeypatch.setattr(coverage, "extractor_for", failing)
        row = document_coverage(document("PD", "Общая площадь 3009,4"), {"M-010": AREA, "M-999": param("M-999")})

        assert "M-010" in row["found"]
        assert "ZeroDivisionError" in row["errors"]["M-999"]


class TestSummary:
    def rows(self) -> list[dict[str, Any]]:
        params = {"M-010": AREA, "M-007": param("M-007", regex_pattern=r"(?i)этажность\s+(\d+)")}
        docs = [
            (document("PD", "Общая площадь 3009,4", "Этажность 5"), Source("ПЗ.pdf", "Объект 1")),
            (document("RD", "Общая площадь 3009,4"), Source("АР.pdf", "Объект 1")),
            (document("ID", "Акт скрытых работ"), Source("акт.pdf", "Объект 2")),
        ]
        return [document_coverage(parsed, params, source) for parsed, source in docs]

    def test_counts_by_stage_and_object(self) -> None:
        params = {"M-010": AREA, "M-007": param("M-007"), "M-004": param("M-004")}
        report = summarize(self.rows(), params)

        assert report["documents"] == 3
        assert report["by_stage"] == {"PD": 1, "RD": 1, "ID": 1}
        assert report["objects"] == ["Объект 1", "Объект 2"]

    def test_found_anywhere_both_stages_and_not_found(self) -> None:
        params = {"M-010": AREA, "M-007": param("M-007"), "M-004": param("M-004")}
        report = summarize(self.rows(), params)

        assert report["found_anywhere"] == 2
        assert report["found_pd_and_rd"] == 1
        assert report["found_all_stages"] == 0
        assert report["not_found"] == ["M-004"]

    def test_parameter_entry(self) -> None:
        report = summarize(self.rows(), {"M-010": AREA, "M-007": param("M-007")})
        area = next(p for p in report["params"] if p["code"] == "M-010")

        assert area["documents"] == {"PD": 1, "RD": 1, "ID": 0}
        assert area["objects"] == 1
        assert area["samples"][0]["file"] == "ПЗ.pdf"

    def test_counts_by_data_type(self) -> None:
        params = {"M-010": AREA, "M-007": param("M-007"), "M-040": param("M-040", data_type="string")}
        report = summarize(self.rows(), params)

        assert report["by_data_type"]["number"] == {"total": 2, "found": 2}
        assert report["by_data_type"]["string"] == {"total": 1, "found": 0}


def write_cache(storage: Path, docs: list[dict[str, Any]], version: str = "0.4.0") -> None:
    for doc in docs:
        target = storage / "parsed" / doc["sha256"] / f"{version}.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")


def write_matrix(path: Path, rows: list[dict[str, str]]) -> Path:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=COLUMNS)
        writer.writeheader()
        for row in rows:
            writer.writerow({column: row.get(column, "") for column in COLUMNS})
    return path


MATRIX_ROW = {
    "code": "M-010",
    "section": "ПЗ",
    "parameter_name": "Общая площадь",
    "review_priority": "HIGH",
    "data_type": "number",
    "regex_pattern": r"(?i)общая площадь\s+([\d\s]+[.,]?\d*)",
    "semantic_anchors": "общая площадь здания",
    "is_active": "false",
}


class TestFromCache:
    def test_only_the_asked_version_is_read(self, tmp_path: Path) -> None:
        write_cache(tmp_path, [document("PD", "a", sha="a" * 64)], version="0.3.0")
        write_cache(tmp_path, [document("PD", "b", sha="b" * 64)], version="0.4.0")

        assert [p.parent.name for p in parsed_files(tmp_path, "0.4.0")] == ["b" * 64]

    def test_measure_reads_the_matrix_file(self, tmp_path: Path) -> None:
        write_cache(tmp_path, [document("PD", "Общая площадь 3009,4")])
        matrix = write_matrix(tmp_path / "params.csv", [MATRIX_ROW])

        rows = measure(parsed_files(tmp_path, "0.4.0"), matrix=matrix)

        assert list(rows[0]["found"]) == ["M-010"]


class TestCommand:
    def test_prints_the_summary(self, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
        write_cache(tmp_path, [document("PD", "Общая площадь 3009,4"), document("RD", "текст", sha="c" * 64)])
        matrix = write_matrix(tmp_path / "params.csv", [MATRIX_ROW])
        jsonl = tmp_path / "rows.jsonl"

        args = ["eval", "coverage", str(tmp_path), "--parser-version", "0.4.0"]
        code = main([*args, "--matrix", str(matrix), "--jsonl", str(jsonl)])

        assert code == 0
        report = json.loads(capsys.readouterr().out)
        assert (report["documents"], report["found_anywhere"], report["params_total"]) == (2, 1, 1)
        assert len(jsonl.read_text(encoding="utf-8").splitlines()) == 2

    def test_empty_cache_is_an_error_with_a_reason(self, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
        assert main(["eval", "coverage", str(tmp_path), "--parser-version", "0.4.0"]) == 1
        assert "нет разобранных документов" in capsys.readouterr().err
