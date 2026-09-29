"""Sentence-BERT — запасной путь извлечения числовых параметров (extract/sbert.py).

Настоящая модель в тестах не грузится (в CI нет extra embeddings): эмбеддинг заменён мешком основ слов из
словаря. Близость — доля общих основ, незнакомые слова не весят ничего. Этого хватает, чтобы проверить всё,
что делает модуль вокруг модели: кандидатов, единицы, фильтры, порог, «одна подпись — один параметр»,
запасной путь только при молчании правил, бюджет и потолок уверенности.
"""

from __future__ import annotations

import sys
import types
from collections.abc import Callable
from itertools import chain, repeat
from typing import Any
from uuid import uuid4

import numpy as np
import pytest

from inspector_ml.config import Settings
from inspector_ml.contracts.events import DocumentMetadata, MatrixParam
from inspector_ml.extract import api, sbert
from inspector_ml.extract.api import LoadedDocument, extract_param
from inspector_ml.extract.base import Found
from inspector_ml.jobs import handlers


class Encoder:
    """Эмбеддинг — мешок основ из словаря, нормированный: близость равна доле общих основ."""

    def __init__(self, vocabulary: str) -> None:
        self.index = {stem: i for i, stem in enumerate(sorted(sbert.stems(vocabulary)))}
        self.calls: list[list[str]] = []

    def __call__(self, texts: list[str]) -> np.ndarray:
        self.calls.append(list(texts))
        vectors = np.zeros((len(texts), len(self.index) + 1), dtype=np.float32)
        for row, text in enumerate(texts):
            for stem in sbert.stems(text):
                if stem in self.index:
                    vectors[row, self.index[stem]] = 1.0
            norm = np.linalg.norm(vectors[row])
            if norm:
                vectors[row] /= norm
        return vectors


def param(code: str, name: str, unit: str | None = "м²", **fields: Any) -> MatrixParam:
    return MatrixParam.model_validate(
        {
            "id": 1,
            "created_at": "2026-09-28T10:00:00Z",
            "updated_at": "2026-09-28T10:00:00Z",
            "code": code,
            "section": "ПЗ",
            "parameter_name": name,
            "unit": unit,
            "review_priority": "HIGH",
            "data_type": fields.pop("data_type", "number"),
            **fields,
        }
    )


def page(*texts: str, number: int = 1, kind: str = "text") -> dict[str, Any]:
    blocks = [
        {"id": f"b{i}", "type": kind, "text": text, "bbox": [0.1, 0.1 * i, 0.9, 0.1 * i + 0.05]}
        for i, text in enumerate(texts)
    ]
    return {"page": number, "source": "TEXT_LAYER", "quality": "OK", "blocks": blocks}


def document(*pages: dict[str, Any], stage: str = "PD") -> LoadedDocument:
    return LoadedDocument(
        file_id=uuid4(),
        sha256=uuid4().hex * 2,
        metadata=DocumentMetadata.model_validate({"doc_stage": stage}),
        parsed={"pages": list(pages)},
    )


AREA = param("M-004", "Площадь застройки")
VOCABULARY = (
    "Площадь застройки общественного назначения Строительный объём подземной части Высота помещения "
    "участка благоустройства проекта"
)


def clock(*moments: float) -> Callable[[], float]:
    """Часы задачи: отдают моменты по очереди, потом стоят на последнем."""
    ticks = chain(map(float, moments), repeat(float(moments[-1])))
    return lambda: next(ticks)


def fallback(*params: MatrixParam, threshold: float = 0.9, **fields: Any) -> tuple[sbert.Fallback, Encoder]:
    encoder = Encoder(fields.pop("vocabulary", VOCABULARY))
    chosen = {p.code: p for p in (params or (AREA,))}
    return sbert.Fallback(params=chosen, encode=encoder, threshold=threshold, **fields), encoder


class TestFallbackInExtraction:
    def test_value_where_rules_are_silent(self) -> None:
        rules_only = extract_param(AREA, [document(page("Площадь застройки — 1 250,5 м²"))])
        path, _ = fallback()

        found = extract_param(AREA, [document(page("Площадь застройки — 1 250,5 м²"))], fallback=path)

        assert rules_only == []
        assert len(found) == 1
        item = found[0]
        assert (item.method, item.value, item.raw_value, item.rule_key, item.unit) == (
            "sbert",
            1250.5,
            "1 250,5",
            None,
            "м²",
        )
        assert item.fragment.extraction_method.root == "SBERT"  # пометка для инспектора и скорера (контракт 0.23.0)
        assert item.fragment.confidence is None  # уверенность распознавания текстового слоя — её нет
        assert item.fragment.page == 1

    def test_rules_win_and_the_model_is_not_asked(self, monkeypatch: pytest.MonkeyPatch) -> None:
        by_rule = Found(rule_key=None, raw_value="900", value=900.0, page=1, bbox=[0, 0, 1, 1], snippet="900")
        monkeypatch.setitem(api.EXTRACTORS, AREA.code, lambda _param, _pages: [by_rule])
        path, encoder = fallback()

        found = extract_param(AREA, [document(page("Площадь застройки — 1 250,5 м²"))], fallback=path)

        assert [(f.method, f.value) for f in found] == [("table", 900.0)]
        assert len(encoder.calls) == 1  # только названия параметров при создании, документ не кодировался

    def test_rules_fragment_is_not_marked(self) -> None:
        by_rules = extract_param(
            param("M-004", "Площадь застройки", semantic_anchors=["Площадь застройки"]),
            [
                document(
                    {
                        "page": 1,
                        "blocks": [],
                        "tables": [
                            {
                                "id": "t",
                                "bbox": [0, 0, 1, 1],
                                "cells": [
                                    {"text": "Площадь застройки", "bbox": [0.1, 0.5, 0.5, 0.54], "row": 0, "col": 0},
                                    {"text": "1 250,5", "bbox": [0.6, 0.5, 0.9, 0.54], "row": 0, "col": 1},
                                ],
                            }
                        ],
                    }
                )
            ],
        )
        assert [f.fragment.extraction_method for f in by_rules] == [None]  # null — правила

    def test_ocr_confidence_is_kept(self) -> None:
        scanned = page("Площадь застройки — 1 250,5 м²")
        scanned["blocks"][0]["confidence"] = 0.31
        path, _ = fallback()

        (item,) = extract_param(AREA, [document(scanned)], fallback=path)

        assert item.fragment.confidence == 0.31

    def test_executive_documentation_is_not_searched(self) -> None:
        path, _ = fallback()
        assert extract_param(AREA, [document(page("Площадь застройки — 1 250,5 м²"), stage="ID")], fallback=path) == []


class TestCandidates:
    def test_table_row_with_unit_in_a_neighbour_cell(self) -> None:
        cells = [
            {"text": "Площадь застройки", "bbox": [0.1, 0.5, 0.5, 0.54], "row": 0, "col": 0},
            {"text": "м²", "bbox": [0.5, 0.5, 0.6, 0.54], "row": 0, "col": 1},
            {"text": "1 250,5", "bbox": [0.6, 0.5, 0.9, 0.54], "row": 0, "col": 2},
        ]
        table_page = {"page": 3, "blocks": [], "tables": [{"id": "t1", "bbox": [0, 0.5, 1, 0.54], "cells": cells}]}
        path, _ = fallback()

        (item,) = path.find(AREA, document(table_page))

        assert (item.value, item.page, item.bbox) == (1250.5, 3, [0.6, 0.5, 0.9, 0.54])

    def test_title_block_is_ignored(self) -> None:
        path, _ = fallback()
        assert path.find(AREA, document(page("Площадь застройки 1 250,5 м²", kind="title_block"))) == []

    def test_only_labels_sharing_a_word_with_parameters_are_encoded(self) -> None:
        """Кодирование — единственное дорогое место: подпись без общей основы с параметрами и из одного слова
        до модели не доходит."""
        path, encoder = fallback()

        path.find(AREA, document(page("Площадь застройки 1 250,5 м²", "Прочие показатели участка 17 м²", "Итого 5 м²")))

        assert encoder.calls[-1] == ["Площадь застройки"]

    def test_year_is_not_a_value(self) -> None:
        assert sbert.candidates(page("Площадь застройки уточнена в 2024")) == []

    def test_unit_must_fit_the_parameter(self) -> None:
        path, _ = fallback()
        assert path.find(AREA, document(page("Площадь застройки 12 м"))) == []

    def test_millimetres_are_converted_to_metres(self) -> None:
        height = param("M-040", "Высота помещения", unit="м")
        path, _ = fallback(height)

        (item,) = path.find(height, document(page("Высота помещения 2700 мм")))

        assert (item.value, item.raw_value, item.unit) == (2.7, "2700", "м")


class TestFilters:
    @pytest.mark.parametrize(
        ("target", "text"),
        [
            pytest.param(param("M-004", "Площадь застройки", max_value=1000), "Площадь застройки 5 000 м²", id="range"),
            pytest.param(param("M-120", "Количество лифтов", unit="шт."), "Количество лифтов 2,5 шт.", id="integer"),
            pytest.param(param("M-005", "Площадь"), "Площадь 31 969,9 м²", id="generic"),
            pytest.param(AREA, "Площадь застройки существующего 1 250,5 м²", id="stops"),
        ],
    )
    def test_candidate_is_rejected(self, target: MatrixParam, text: str) -> None:
        path, _ = fallback(target, vocabulary=VOCABULARY + " Количество лифтов")
        assert path.find(target, document(page(text))) == []

    def test_rejected_candidate_gives_way_to_the_next(self) -> None:
        """Первый кандидат отсеян — прогнозом становится следующий, а не пустота."""
        path, _ = fallback()

        (item,) = path.find(
            AREA, document(page("Площадь застройки существующего 90 м²", "Площадь застройки 1 250,5 м²"))
        )

        assert item.value == 1250.5

    def test_stops_file_is_packaged(self) -> None:
        stops = sbert.load_stops()
        assert "этаж" in stops and "сущест" in stops and len(stops) == 42


class TestChoice:
    def test_similarity_below_threshold_gives_nothing(self) -> None:
        path, _ = fallback()
        assert path.find(AREA, document(page("Площадь застройки общественного назначения 1 250,5 м²"))) == []

    def test_one_label_goes_to_the_closest_parameter(self) -> None:
        total = param("M-010", "Строительный объём", unit="м³")
        underground = param("M-011", "Строительный объём подземной части", unit="м³")
        text = page("Строительный объём 48 200 м³")

        both, _ = fallback(total, underground, threshold=0.6)
        alone, _ = fallback(underground, threshold=0.6)

        assert [f.value for f in both.find(total, document(text))] == [48200.0]
        assert both.find(underground, document(text)) == []  # подпись ближе к общему объёму
        assert [f.value for f in alone.find(underground, document(text))] == [48200.0]  # без соперника — берёт

    def test_document_is_encoded_once_for_all_parameters(self) -> None:
        total = param("M-010", "Строительный объём", unit="м³")
        path, encoder = fallback(AREA, total)
        doc = document(page("Площадь застройки 1 250,5 м²", "Строительный объём 48 200 м³"))

        assert [f.value for f in path.find(AREA, doc)] == [1250.5]
        assert [f.value for f in path.find(total, doc)] == [48200.0]
        assert len(encoder.calls) == 2  # названия параметров и подписи документа — по разу

    def test_budget_stops_new_documents(self) -> None:
        # начало документа, проверка перед пачкой, конец документа: на документ ушло 15 с при бюджете 10
        path, _ = fallback(budget_s=10.0, clock=clock(0, 0, 15))
        text = page("Площадь застройки 1 250,5 м²")

        assert len(path.find(AREA, document(text))) == 1
        assert path.find(AREA, document(text)) == []  # бюджет задачи кончился — дальше одни правила

    def test_budget_cuts_a_large_document_between_batches(self) -> None:
        """Большой документ не должен съесть таймаут задачи: бюджет проверяется перед каждой пачкой подписей."""
        path, encoder = fallback(budget_s=10.0, clock=clock(0, 11))

        assert path.find(AREA, document(page("Площадь застройки 1 250,5 м²"))) == []
        assert len(encoder.calls) == 1  # только названия параметров: до подписей документа дело не дошло


class TestSwitch:
    def test_disabled_by_default(self) -> None:
        assert Settings(_env_file=None).sbert_enabled is False
        assert sbert.Fallback.create([AREA], Settings(_env_file=None)) is None

    def test_no_model_means_rules_only(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(sbert, "load_encoder", lambda _model: None)
        assert sbert.Fallback.create([AREA], Settings(_env_file=None, sbert_enabled=True)) is None

    def test_only_numeric_parameters(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(sbert, "load_encoder", lambda _model: Encoder(VOCABULARY))
        grade = param("M-055", "Класс бетона", unit=None, data_type="enum")
        settings = Settings(_env_file=None, sbert_enabled=True, sbert_threshold=0.95, sbert_budget_s=30)

        assert sbert.Fallback.create([grade], settings) is None
        path = sbert.Fallback.create([AREA, grade], settings)
        assert path is not None
        assert (list(path.params), path.threshold, path.budget_s) == (["M-004"], 0.95, 30)

    def test_compare_handler_gets_the_fallback_only_when_enabled(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(sbert, "load_encoder", lambda _model: Encoder(VOCABULARY))
        request = type("Request", (), {"matrix": type("Matrix", (), {"params": [AREA]})()})()

        assert handlers._extractor(request, Settings(_env_file=None)) is extract_param
        extractor = handlers._extractor(request, Settings(_env_file=None, sbert_enabled=True))
        found = extractor(AREA, [document(page("Площадь застройки — 1 250,5 м²"))])
        assert [(f.method, f.value) for f in found] == [("sbert", 1250.5)]


class TestReview239:
    """Правки по ревью: стадия, ключ места, ближайший параметр, таблицы, «а», загрузка, лимит."""

    def test_stage_with_a_rule_value_is_left_to_rules(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """В ПД площадь нашло правило (ПЗ) — Sentence-BERT в другом документе ПД не спрашиваем; в РД правила молчат."""

        def rules(_param: MatrixParam, pages: list[dict[str, Any]]) -> list[Found]:
            if "ПЗ" not in pages[0]["blocks"][0]["text"]:
                return []
            return [Found(rule_key=None, raw_value="900", value=900.0, page=1, bbox=[0, 0, 1, 1], snippet="ПЗ")]

        monkeypatch.setitem(api.EXTRACTORS, AREA.code, rules)
        path, _ = fallback()
        docs = [
            document(page("ПЗ: площадь застройки 900 м²")),
            document(page("Площадь застройки 1 250,5 м²")),
            document(page("Площадь застройки 1 300 м²"), stage="RD"),
        ]

        found = extract_param(AREA, docs, fallback=path)

        assert [(f.stage, f.method, f.value) for f in found] == [("PD", "table", 900.0), ("RD", "sbert", 1300.0)]

    def test_one_value_per_stage_the_closest(self) -> None:
        path, _ = fallback(threshold=0.6)
        docs = [
            document(page("Площадь застройки общественного назначения 1 300 м²"), stage="RD"),
            document(page("Площадь застройки 1 250,5 м²"), stage="RD"),
        ]

        found = extract_param(AREA, docs, fallback=path)

        assert [(f.method, f.value) for f in found] == [("sbert", 1250.5)]  # 1,0 против 0,82 — одна цифра на стадию

    def test_parameter_with_a_location_key_is_left_to_rules(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(sbert, "load_encoder", lambda _model: Encoder(VOCABULARY))
        rooms = param("M-002", "Общая площадь здания")
        settings = Settings(_env_file=None, sbert_enabled=True)

        path = sbert.Fallback.create([AREA, rooms], settings, keyed=api.KEYED)

        assert path is not None
        assert list(path.params) == ["M-004"] and "M-002" in path.rivals
        assert "M-002" in api.KEYED and "M-003" not in api.KEYED
        found = extract_param(rooms, [document(page("Общая площадь здания 11 905,3 м²"))], fallback=path)
        assert all(f.method != "sbert" for f in found)

    def test_label_closer_to_another_parameter_is_not_taken(self) -> None:
        """Подпись ближе к другому параметру матрицы — тому и достаётся, а проигравший берёт следующего кандидата."""
        plot = param("M-004", "Площадь участка")
        landscaping = param("M-002", "Площадь участка благоустройства")
        text = page("Площадь участка благоустройства 900 м²", "Площадь участка проекта 1 250,5 м²")

        with_rival, _ = fallback(plot, threshold=0.6, rivals={landscaping.code: landscaping})
        alone, _ = fallback(plot, threshold=0.6)

        assert [f.value for f in with_rival.find(plot, document(text))] == [1250.5]
        assert [f.value for f in alone.find(plot, document(text))] == [900.0]  # без соперника брал бы чужую подпись

    def test_table_label_restarts_after_a_number(self) -> None:
        """«Площадь застройки | м² | 1 250,5 | Процент застройки | 12 | %» — 12 это процент, а не площадь."""
        texts = ["Площадь застройки", "м²", "1 250,5", "Процент застройки", "12", "%"]
        cells = [
            {"text": text, "bbox": [0.1 * i, 0.5, 0.1 * i + 0.09, 0.54], "row": 0, "col": i}
            for i, text in enumerate(texts)
        ]
        table_page = {"page": 1, "blocks": [], "tables": [{"id": "t", "bbox": [0, 0.5, 1, 0.54], "cells": cells}]}

        found = [(c.label, c.raw, c.unit) for c in sbert.candidates(table_page)]

        assert found == [("Площадь застройки м²", "1 250,5", "area"), ("Процент застройки", "12", "pct")]

    def test_capital_a_is_amperes_but_the_conjunction_is_not(self) -> None:
        assert sbert.unit_after(" А") == "amp"
        assert sbert.unit_after(" а также") is None

    def test_model_is_loaded_from_disk_only_and_a_failure_is_not_remembered(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls: list[dict[str, Any]] = []

        class Missing:
            def __init__(self, _model: str, **options: Any) -> None:
                calls.append(options)
                raise OSError("весов нет")

        class Present:
            def __init__(self, _model: str, **options: Any) -> None:
                calls.append(options)

            def get_embedding_dimension(self) -> int:
                return 3

            def encode(self, texts: list[str], **_options: Any) -> np.ndarray:
                return np.ones((len(texts), 3))

        module = types.ModuleType("sentence_transformers")
        module.SentenceTransformer = Missing  # type: ignore[attr-defined]
        monkeypatch.setitem(sys.modules, "sentence_transformers", module)
        monkeypatch.setattr(sbert, "_ENCODERS", {})

        assert sbert.load_encoder("minilm") is None
        module.SentenceTransformer = Present  # type: ignore[attr-defined]  # веса положили — без перезапуска ml
        encode = sbert.load_encoder("minilm")

        assert encode is not None and encode(["подпись"]).shape == (1, 3)
        assert [options.get("local_files_only") for options in calls] == [True, True]  # на huggingface.co не ходим

    def test_label_limit_is_deterministic(self) -> None:
        """Лимит — число подписей, а не секунды: тот же комплект даёт те же значения при любой загрузке процессора."""
        path, _ = fallback(max_labels=1)
        first = document(page("Площадь застройки 1 250,5 м²"))
        second = document(page("Площадь застройки общественного назначения 1 300 м²"))

        assert [f.value for f in path.find(AREA, first)] == [1250.5]
        assert path.find(AREA, second) == []  # вторая подпись уже сверх лимита
        assert path.find(AREA, document(page("Площадь застройки 1 250,5 м²"))) == []  # дальше — одни правила
