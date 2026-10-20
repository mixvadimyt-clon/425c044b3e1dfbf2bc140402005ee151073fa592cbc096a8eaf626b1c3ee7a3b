"""Тёплый пол в ПД есть, в РД не упомянут — гипотеза без модели (FREE-HEATING-001 «Тюменской 5»)."""

from __future__ import annotations

import uuid

from inspector_ml.contracts.events import DocumentMetadata
from inspector_ml.extract.api import LoadedDocument
from inspector_ml.suspicion import heating_gap


def block(text: str, bbox: list[float], kind: str = "text") -> dict:
    return {"type": kind, "text": text, "bbox": bbox}


def pd_scheme() -> dict:
    """Схема отопления ПД (лист 21): регулятор тёплого пола у раздевальных МГН, ряд этажа выше — другой этаж."""
    return {
        "page": 99,
        "is_drawing": True,
        "width_pt": 4212,
        "height_pt": 1191,
        "blocks": [
            block("331 Читальный зал", [0.354, 0.301, 0.371, 0.309]),
            block("266 Коридор", [0.294, 0.381, 0.305, 0.39]),
            block("Регулятор для систы\n“теплый пол”\nMultibox C/RTL", [0.332, 0.382, 0.353, 0.41]),
            block("267, 270\nРаздевальная и\nсанузул для МГН", [0.293, 0.42, 0.307, 0.448]),
            block("271, 272\nРаздевальная и\nсанузул для МГН", [0.313, 0.42, 0.327, 0.448]),
            block("135 Лестница", [0.9, 0.56, 0.95, 0.57]),
        ],
    }


def rd_plan(page: int, rooms: list[str], extra: str = "") -> dict:
    rows = [
        block(f"{room}\nРаздевальная для МГН\n13.7", [0.1, 0.8 + i * 0.01, 0.3, 0.805 + i * 0.01])
        for i, room in enumerate(rooms)
    ]
    if extra:
        rows.append(block(extra, [0.5, 0.5, 0.6, 0.51]))
    return {"page": page, "is_drawing": True, "width_pt": 2384, "height_pt": 3370, "blocks": rows}


def doc(stage: str, code: str, pages: list[dict]) -> LoadedDocument:
    return LoadedDocument(
        uuid.uuid4(), "0" * 64, DocumentMetadata(doc_stage=stage, document_code=code), {"pages": pages}
    )


def test_warm_floor_in_pd_missing_in_rd() -> None:
    pd = doc("PD", "1-П-ИОС5.4.2-СТ", [pd_scheme()])
    ov1 = doc("RD", "1-РД-ОВ1", [rd_plan(19, ["266", "267", "270", "271", "272"])])
    ov2 = doc("RD", "1-РД-ОВ2.1", [rd_plan(17, ["267", "270", "271"]), rd_plan(18, ["267"])])

    [found] = heating_gap.run([pd, ov1, ov2], "obj")

    assert found.confidence >= 0.5  # выше порога выгрузки FREE-* в api
    assert "266, 267, 270, 271, 272" in found.description and "331" not in found.description
    assert [(str(e.stage.root), e.page) for e in found.evidence] == [("PD", 99), ("RD", 19), ("RD", 17)]


def test_rd_mentioning_warm_floor_anywhere_means_no_hypothesis() -> None:
    pd = doc("PD", "1-П-ИОС5.4.2-СТ", [pd_scheme()])
    rd = doc("RD", "1-РД-ОВ2.1", [rd_plan(17, ["267", "270", "271", "272"], extra="Контур теплого пола")])

    assert heating_gap.run([pd, rd], "obj") == []


def test_recognized_plan_label_counts_as_a_mention() -> None:
    pd = doc("PD", "1-П-ИОС5.4.2-СТ", [pd_scheme()])
    plan = rd_plan(17, ["267", "270", "271", "272"])
    plan["cad_ocr"] = [{"text": "Теплые полы", "conf": 0.9, "bbox": [0.4, 0.4, 0.45, 0.41]}]

    assert heating_gap.run([pd, doc("RD", "1-РД-ОВ2.1", [plan])], "obj") == []


def test_heat_carrier_is_not_a_warm_floor() -> None:
    """«Теплоносителя, полученного» в записке — не тёплый пол."""
    assert not heating_gap.WARM_FLOOR.search("о массе и объеме теплоносителя, полученного по подающему трубопроводу")
    assert heating_gap.WARM_FLOOR.search("система подогрева полов (теплые полы)")


def test_other_systems_and_missing_stage_are_silent() -> None:
    pd = doc("PD", "1-П-ИОС5.4.2-СТ", [pd_scheme()])
    water = doc("RD", "1-РД-ВК1", [rd_plan(17, ["267", "270", "271", "272"])])

    assert heating_gap.run([pd, water], "obj") == []
    assert heating_gap.run([pd], "obj") == []


def curtain_scheme() -> dict:
    """Схема ПД: тепловая завеса у входа — тамбур 101 и вестибюль 102; легенда в углу листа далеко от помещений."""
    return {
        "page": 40,
        "is_drawing": True,
        "width_pt": 2384,
        "height_pt": 1684,
        "blocks": [
            block("Воздушно-тепловая завеса А1", [0.30, 0.40, 0.34, 0.41]),
            block("101 Тамбур", [0.30, 0.43, 0.33, 0.44]),
            block("102 Вестибюль", [0.34, 0.43, 0.37, 0.44]),
            block("Фанкойл - условное обозначение", [0.92, 0.05, 0.98, 0.06]),
        ],
    }


def test_other_equipment_types_follow_the_same_scheme() -> None:
    """Тёплый пол в РД упомянут — по нему гипотезы нет, а завеса из ПД в РД пропала — гипотеза о завесе."""
    pd = doc("PD", "1-П-ИОС5.4.2-СТ", [pd_scheme(), curtain_scheme()])
    rd = doc("RD", "1-РД-ОВ1", [rd_plan(17, ["101", "102", "267", "270", "271", "272"], extra="Контур теплого пола")])

    [found] = heating_gap.run([pd, rd], "obj")

    assert found.description.startswith("Тепловые завесы:") and "101, 102" in found.description
    assert [e.page for e in found.evidence] == [40, 17]


def test_legend_far_from_rooms_gives_nothing() -> None:
    """«Фанкойл» в легенде листа: рядом нет помещений — гипотезы нет, хотя в РД фанкойлы не упомянуты."""
    legend_only = curtain_scheme()
    legend_only["blocks"] = [b for b in legend_only["blocks"] if "Фанкойл" in b["text"]] + [
        block("101 Тамбур", [0.30, 0.43, 0.33, 0.44])
    ]
    pd = doc("PD", "1-П-ИОС5.4.2-СТ", [legend_only])
    rd = doc("RD", "1-РД-ОВ1", [rd_plan(17, ["101"])])

    assert heating_gap.run([pd, rd], "obj") == []
