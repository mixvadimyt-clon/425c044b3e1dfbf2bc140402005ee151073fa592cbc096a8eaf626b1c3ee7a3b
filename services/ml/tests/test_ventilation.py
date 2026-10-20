"""Вентиляция по помещениям — системы со схем ПД и планов РД (IOS4-078, IOS4-079).

Листы собраны по образцу «Тюменской 5»: схема ПД — ряды подписей «140 Физического эксперимента» с системами над ними,
план РД — кружки помещений, экспликация и подписи систем шрифтом САПР, которые приходят из OCR.
"""

from __future__ import annotations

import hashlib
import uuid
from pathlib import Path

import numpy as np
import pymupdf
import pytest

from inspector_ml.contracts.events import DocumentMetadata
from inspector_ml.extract import api, cad_labels, ventilation
from inspector_ml.matrix import load_params
from inspector_ml.ocr.base import OcrLine


def word(text: str, x: float, y: float, block: int, line: int = 0) -> dict:
    return {"text": text, "bbox": [x, y, x + 0.01, y + 0.008], "block": block, "line": line}


def scheme_page() -> dict:
    """Ряд первого этажа схемы ПД: у двухстрочной подписи номер второго помещения стоит ниже (147)."""
    words = [
        word("В2.4", 0.166, 0.606, 1),
        word("В2.7", 0.216, 0.606, 2),
        word("В2.8", 0.216, 0.616, 2, 1),
        word("В2.10", 0.319, 0.616, 3),
        word("М.О.", 0.318, 0.636, 4),
        word("поз.169", 0.318, 0.646, 4, 1),
        word("142", 0.168, 0.655, 5),
        word("Астрономии", 0.18, 0.655, 5),
        word("140", 0.218, 0.655, 6),
        word("Физического", 0.23, 0.655, 6),
        word("141", 0.27, 0.655, 7),
        word("Биолого-химического", 0.28, 0.655, 7),
        word("147", 0.319, 0.665, 7, 2),
        word("Лаборантская", 0.33, 0.665, 7, 2),
    ]
    return {"page": 88, "is_drawing": True, "width_pt": 2526, "height_pt": 1191, "blocks": [], "cad_words": words}


def plan_page() -> dict:
    """План РД: экспликация (категория «В3» — не система), кружки помещений, подписи систем из OCR."""
    schedule = [
        {
            "type": "text",
            "text": f"{n}\nКабинет {n}\n{50 + i}.4\nВ3",
            "bbox": [0.19, 0.8 + i * 0.01, 0.34, 0.805 + i * 0.01],
        }
        for i, n in enumerate(("140", "141", "142", "147", "198"))
    ]
    circles = [
        {"type": "text", "text": "142", "bbox": [0.906, 0.139, 0.911, 0.142]},
        {"type": "text", "text": "140", "bbox": [0.922, 0.194, 0.926, 0.197]},
        {"type": "text", "text": "141", "bbox": [0.911, 0.263, 0.915, 0.266]},
    ]
    ocr = [
        {"text": "П2/BE", "conf": 0.74, "bbox": [0.915, 0.12, 0.925, 0.123]},  # табличка в 142
        {"text": "П2/ВЕ", "conf": 0.70, "bbox": [0.925, 0.2, 0.935, 0.203]},  # табличка в 140
        {"text": "B2.7,8,9", "conf": 0.99, "bbox": [0.92, 0.255, 0.93, 0.258]},  # вытяжка ушла в 141
        {"text": "B2.4", "conf": 0.35, "bbox": [0.906, 0.145, 0.91, 0.148]},  # неуверенно — не берём
    ]
    return {
        "page": 18,
        "is_drawing": True,
        "width_pt": 2384,
        "height_pt": 3370,
        "blocks": [*schedule, *circles],
        "cad_words": [word("В3", 0.33, 0.801, 99)],
        "cad_ocr": ocr,
    }


class TestSystems:
    @pytest.mark.parametrize(
        ("text", "systems"),
        [
            ("B2.7,8,9", ["В2.7", "В2.8", "В2.9"]),
            ("П2/BE", ["П2", "ВЕ"]),
            ("П17.1, 17.2", ["П17.1", "П17.2"]),
            ("BE16", ["ВЕ16"]),
            ("B2.3,4", ["В2.3", "В2.4"]),
            ("M.O.", []),
            ("поз.169", []),
            ("AMP-K 400x350", []),
        ],
    )
    def test_labels(self, text, systems) -> None:
        assert ventilation.systems_in(text) == systems


@pytest.mark.parametrize(
    ("stage", "code", "expected"),
    [
        ("PD", "1-П-ИОС5.4.2-СТ", "ОВ"),
        ("PD", "03-ИОС4.1.3.ТЧ", "ОВ"),  # «Новослободская»: подраздел без номера раздела
        ("PD", "П-2025-04.266-ИОС4.1.ТЧ", "ОВ"),
        ("PD", "П-2025-04.266-ИОС5.5.4", "СС"),
        ("RD", "1-PД-ОB1.C", "ОВ"),
        ("RD", "03-ИОС-4.1", "ОВ"),  # РД «Новослободской» с шифром раздела ПД
        ("RD", "1-РД-ВВ.СО", None),
    ],
)
def test_system_by_code(stage, code, expected) -> None:
    from inspector_ml.suspicion.semantic import system

    doc = api.LoadedDocument(uuid.uuid4(), "0" * 64, DocumentMetadata(doc_stage=stage, document_code=code), {})
    assert system(doc) == expected


class TestScheme:
    def test_system_goes_to_the_room_below(self) -> None:
        found = {f.rule_key: f.value for f in ventilation.extract_systems(None, [scheme_page()])}

        assert found == {"пом. 140": "В2.7, В2.8", "пом. 142": "В2.4", "пом. 147": "В2.10"}

    def test_room_label_without_area_is_not_a_schedule(self) -> None:
        """«001\\nТехническое подполье» на схеме — подпись помещения, а не строка экспликации."""
        page = scheme_page()
        page["blocks"] = [
            {"type": "text", "text": f"00{i}\nТехническое подполье", "bbox": [0.1, 0.1, 0.2, 0.2]} for i in range(6)
        ]

        assert ventilation.schedule(page) == {}
        assert len(ventilation.extract_systems(None, [page])) == 3

    def test_supply_units_go_to_the_vent_chamber(self) -> None:
        """Схема теплоснабжения приточных установок: установки в ряд, подпись венткамеры сбоку (лист 26 ПД)."""
        page = {
            "page": 104,
            "is_drawing": True,
            "width_pt": 2384,
            "height_pt": 842,
            "blocks": [],
            "cad_words": [
                word("П2", 0.705, 0.333, 1),
                word("П9", 0.74, 0.333, 2),
                word("012", 0.85, 0.323, 3),
                word("Венткамера", 0.86, 0.333, 3, 1),
                word("006", 0.15, 0.469, 4),
                word("Венткамера", 0.16, 0.479, 4, 1),
            ],
        }

        units = {f.rule_key: f.value for f in ventilation.extract_units(None, [page])}

        assert units == {"пом. 012": "П2, П9"}
        assert ventilation.extract_systems(None, [page]) == []  # венткамера — не помещение для M-078


class TestPlan:
    def test_ocr_labels_go_to_the_nearest_room(self) -> None:
        found = {f.rule_key: (f.value, f.method) for f in ventilation.extract_systems(None, [plan_page()])}

        assert found == {
            "пом. 140": ("ВЕ, П2", "cad_ocr"),
            "пом. 141": ("В2.7, В2.8, В2.9", "cad_ocr"),
            "пом. 142": ("ВЕ, П2", "cad_ocr"),
        }

    def test_without_cad_labels_the_extractor_is_silent(self) -> None:
        page = plan_page()
        del page["cad_words"]

        assert ventilation.extract_systems(None, [page]) == []

    def test_ocr_evidence_is_marked_as_ocr(self) -> None:
        doc = api.LoadedDocument(
            uuid.uuid4(), "0" * 64, DocumentMetadata(doc_stage="RD", document_code="1-РД-ОВ1"), {"pages": [plan_page()]}
        )

        [first, *_] = api.extract_param(load_params()["M-078"], [doc])

        assert first.rule_key == "пом. 140" and first.fragment.page == 18
        assert str(first.fragment.source.root) == "OCR"


def test_room_values_from_several_documents_of_a_stage_are_united() -> None:
    """Венткамера 012 на планах ОВ1 и ОВ2.1 РД: одно значение стадии, иначе движок требует выбрать источник."""

    def chamber(units: list[str]) -> dict:
        words = [word(u, 0.70 + i * 0.03, 0.333, i) for i, u in enumerate(units)]
        words += [word("012", 0.85, 0.323, 50), word("Венткамера", 0.86, 0.333, 50, 1)]
        return {"page": 17, "is_drawing": True, "width_pt": 2384, "height_pt": 842, "blocks": [], "cad_words": words}

    ov1 = api.LoadedDocument(
        uuid.uuid4(), "1" * 64, DocumentMetadata(doc_stage="RD"), {"pages": [chamber(["П2", "П9"])]}
    )
    ov2 = api.LoadedDocument(
        uuid.uuid4(), "2" * 64, DocumentMetadata(doc_stage="RD"), {"pages": [chamber(["П17.1", "П17.2", "П2"])]}
    )

    [one] = api.extract_param(load_params()["M-079"], [ov1, ov2])

    assert (one.rule_key, one.value) == ("пом. 012", "П17.1, П17.2, П2, П9")
    assert one.file_id == ov2.file_id  # доказательство — где установок больше


def note(stage: str, text: str) -> api.LoadedDocument:
    """Записка ИОС4 контрольного комплекта 3: строка параметра в тексте, листов ОВ с помещениями нет."""
    page = {"page": 1, "blocks": [{"type": "text", "text": text, "bbox": [0.1, 0.2, 0.9, 0.25]}]}
    metadata = DocumentMetadata(doc_stage=stage, document_code=f"1-{stage}-ИОС4")
    return api.LoadedDocument(uuid.uuid4(), hashlib.sha256(text.encode()).hexdigest(), metadata, {"pages": [page]})


class TestTextFallback:
    """Без значений по помещениям во всей задаче — поиск в тексте, как без разбора по помещениям."""

    def test_duct_section_from_the_note(self) -> None:
        docs = [
            note("PD", "Сечения и геометрия воздуховодов общеобменной вентиляции — 1 600 мм²"),
            note("RD", "Сечения и геометрия воздуховодов общеобменной вентиляции — 1 280 мм²"),
        ]

        found = {(e.stage, e.rule_key): e.raw_value.strip() for e in api.extract_param(load_params()["M-078"], docs)}

        assert found == {("PD", None): "1 600", ("RD", None): "1 280"}

    def test_fan_characteristics_from_the_note(self) -> None:
        docs = [
            note(stage, "Характеристики вентиляторов общеобменной вентиляции: исполнение 1 по проекту")
            for stage in ("PD", "RD")
        ]

        found = [(e.stage, e.rule_key, e.value) for e in api.extract_param(load_params()["M-079"], docs)]

        assert found == [("PD", None, "исполнение 1 по проекту"), ("RD", None, "исполнение 1 по проекту")]

    def test_rooms_found_somewhere_means_no_keyless_check(self) -> None:
        """«Тюменская 5»: системы по помещениям есть — строка записки не встаёт проверкой «на весь параметр»."""
        scheme = api.LoadedDocument(
            uuid.uuid4(),
            "3" * 64,
            DocumentMetadata(doc_stage="PD", document_code="1-П-ИОС4"),
            {"pages": [scheme_page()]},
        )
        docs = [scheme, note("PD", "Сечения и геометрия воздуховодов общеобменной вентиляции — 1 600 мм²")]

        keys = {e.rule_key for e in api.extract_param(load_params()["M-078"], docs)}

        assert keys and None not in keys


class FakeEngine:
    name = "fake"

    def __init__(self) -> None:
        self.calls = 0

    def recognize(self, image: np.ndarray) -> list[OcrLine]:
        self.calls += 1
        return [OcrLine("B2.7,8,9", (10.0, 10.0, 60.0, 20.0), 0.97)]


def stored(storage: Path, code: str, pages: list[dict]) -> api.LoadedDocument:
    """PDF с листами по числу `pages` в общем хранилище и документ с разбором этих листов."""
    document = pymupdf.open()
    for _ in pages:
        page = document.new_page(width=842, height=595)
        page.insert_text((100, 100), "B2.7 140 141", fontsize=10)
    data = document.tobytes()
    sha = hashlib.sha256(data).hexdigest()
    (storage / "raw").mkdir(parents=True, exist_ok=True)
    (storage / "raw" / sha).write_bytes(data)
    stage = "PD" if "-П-" in code else "RD"
    return api.LoadedDocument(
        uuid.uuid4(), sha, DocumentMetadata(doc_stage=stage, document_code=code), {"pages": pages}
    )


def drawing(number: int, schedule: bool) -> dict:
    rooms = [f"{100 + i}" for i in range(10)]
    blocks = [{"type": "text", "text": r, "bbox": [0.1, 0.1, 0.11, 0.11]} for r in rooms]
    if schedule:
        blocks += [{"type": "text", "text": f"{r}\nКабинет\n20.5", "bbox": [0.5, 0.9, 0.6, 0.91]} for r in rooms[:6]]
    return {"page": number, "is_drawing": True, "width_pt": 842, "height_pt": 595, "blocks": blocks}


class TestCadLabels:
    def test_only_plans_of_ov_documents_are_recognized_and_cached(self, tmp_path) -> None:
        ov = stored(tmp_path, "1-РД-ОВ1", [drawing(1, schedule=True), drawing(2, schedule=False)])
        other = stored(tmp_path, "1-РД-ВК1", [drawing(1, schedule=True)])
        engine = FakeEngine()

        counts = cad_labels.enrich([ov, other], tmp_path, engine)

        assert counts["pages"] == 2 and counts["ocr"] == 1
        plan, scheme = ov.pages
        assert plan["cad_ocr"][0]["text"] == "B2.7,8,9" and "cad_ocr" not in scheme
        assert {w["text"] for w in scheme["cad_words"]} >= {"B2.7", "140"}
        assert "cad_words" not in other.pages[0]  # водопровод — не ОВ

    def test_cache_is_used_without_the_engine(self, tmp_path) -> None:
        first = stored(tmp_path, "1-РД-ОВ1", [drawing(1, schedule=True)])
        cad_labels.enrich([first], tmp_path, FakeEngine())
        again = api.LoadedDocument(uuid.uuid4(), first.sha256, first.metadata, {"pages": [drawing(1, schedule=True)]})

        counts = cad_labels.enrich([again], tmp_path, None)

        assert counts == {"pages": 1, "ocr": 0, "ocr_cached": 1, "ocr_skipped": 0}
        assert again.pages[0]["cad_ocr"][0]["text"] == "B2.7,8,9"

    def test_no_engine_and_no_cache_means_no_ocr(self, tmp_path) -> None:
        doc = stored(tmp_path, "1-РД-ОВ1", [drawing(1, schedule=True)])

        counts = cad_labels.enrich([doc], tmp_path, None)

        assert counts["ocr_skipped"] == 1 and "cad_ocr" not in doc.pages[0]
