"""Метаданные документа: основная надпись, шифр, стадия, марка, редакция, статусы."""

from __future__ import annotations

from typing import Any

import pytest

from inspector_ml.corpus.names import fix_name, looks_broken
from inspector_ml.layout.title_block import title_block_blocks, title_block_text
from inspector_ml.metadata import classify, revision
from inspector_ml.metadata.document import document_metadata

STAMP = (
    "П-2025-04.266-АР\nСтадия П\nЛист 4\nЛистов 26\nИзм. 2\nВ производство работ\n"
    "Разработал Иванов 12.03.2026\nПроверил Петров 15.03.2026"
)


def block(id_: str, text: str, bbox: list[float]) -> dict[str, Any]:
    return {"id": id_, "type": "text", "text": text, "bbox": bbox}


def page(number: int = 1, *, stamp: str = STAMP, body: str = "Экспликация помещений 1-го этажа") -> dict[str, Any]:
    return {
        "page": number,
        "blocks": [
            block(f"p{number}-b0", body, [0.1, 0.1, 0.6, 0.3]),
            block(f"p{number}-b1", stamp, [0.62, 0.80, 0.98, 0.98]),
        ],
    }


def test_title_block_is_bottom_right() -> None:
    blocks = page()["blocks"]

    assert title_block_blocks(blocks) == ["p1-b1"]
    assert "П-2025-04.266-АР" in title_block_text(page())


def test_document_code_prefers_longest_candidate() -> None:
    assert classify.document_code("Лист 4 П-2025-04.266-АР от 12.03.2026") == "П-2025-04.266-АР"


def test_document_code_ignores_dates_and_short_tokens() -> None:
    assert classify.document_code("12.03.2026 стр. 4") is None


@pytest.mark.parametrize(
    ("code", "expected"),
    [("П-2025-04.266-АР", "АР"), ("НВС-2025.03-4.3-КР3", "КР"), ("01-07.22-14-П-ПЗУ", "ПЗУ"), ("2026-01-02", None)],
)
def test_discipline_from_code(code: str, expected: str | None) -> None:
    assert classify.discipline("", code) == expected


def test_discipline_from_file_name() -> None:
    """В корпусе марка часто есть только в имени файла, а в штампе скана её нет."""
    assert classify.discipline("", None, "НСЛ-17-02.2026-1_2-КЖ1.1.3.pdf") == "КЖ"


def test_short_marks_are_not_taken_from_free_text() -> None:
    """«ПЗ» в «пояснительной записке» не делает документ разделом ПЗ."""
    assert classify.discipline("Пояснительная записка. ПЗ приведена ниже") is None


@pytest.mark.parametrize(
    ("text", "code", "expected"),
    [
        ("Стадия П", None, "PD"),
        ("Стадия Р", None, "RD"),
        ("", "РД-2025-04-266-АР2", "RD"),
        ("Акт освидетельствования скрытых работ. АОСР №1", None, "ID"),
        ("Рабочая документация", None, "RD"),
    ],
)
def test_doc_stage(text: str, code: str | None, expected: str) -> None:
    assert classify.doc_stage(text, code) == expected


@pytest.mark.parametrize(
    ("text", "code", "file_name", "expected"),
    [
        # «РД» в начале — номер проекта, стадия — буква перед маркой (Алтуфьевское, ПД 2024 года)
        ("", "ЖС-РД-270121-П-ИОС5.1", None, "PD"),
        ("", None, "5.1. Раздел 5.1 ЖС-РД-270121-П-ИОС5.1 2024.pdf", "PD"),
        # акт ИД, хотя в имени «_П»
        ("", None, "АОСР №1.1_П от 05.06.2026.pdf", "ID"),
        # «П-2025-04-266» — номер проекта и у рабочей документации: решает текст
        ("Рабочая документация. Основной комплект рабочих чертежей", None, "П-2025-04-266-КЖ02.pdf", "RD"),
        # том ПД, где однажды упомянут основной комплект: перевес признаков ПД
        (
            "Проектная документация. Раздел 4. Проектная документация разработана… основной комплект",
            None,
            "НВС-2025.03-4.2-КР2.pdf",
            "PD",
        ),
    ],
)
def test_doc_stage_order(text: str, code: str | None, file_name: str | None, expected: str) -> None:
    """Замер 25.09 на обучающих объектах: 213 → 246 верных из 259 по стадии из папки."""
    assert classify.doc_stage(text, code, file_name) == expected


def test_single_act_mention_does_not_make_volume_executive() -> None:
    """Том ПД, где однажды упомянут акт освидетельствования, остаётся ПД."""
    text = "Проектная документация. Раздел 7. Работы принимаются по акту освидетельствования."

    assert classify.doc_stage(text) == "PD"


def test_revision_and_sheet() -> None:
    assert revision.revision("Изм. 2 Лист 4") == "2"
    assert revision.revision("Кор.3") == "3"
    assert revision.sheet("Лист 12") == "12"
    assert revision.sheets_total("Листов 26") == 26


def test_approval_status_from_stamp() -> None:
    assert revision.approval_status("В производство работ") == "FOR_CONSTRUCTION"
    assert revision.approval_status("УТВЕРЖДАЮ") == "APPROVED"
    assert revision.approval_status("Аннулирован") == "CANCELLED"
    assert revision.approval_status("обычный текст") == "UNKNOWN"


def test_latest_date_wins() -> None:
    assert revision.latest_date("12.03.2026 и 15.03.2026").isoformat() == "2026-03-15"


def test_document_metadata_collects_fields() -> None:
    metadata = document_metadata([page(1), page(2, stamp=STAMP.replace("Лист 4", "Лист 5"))])

    assert metadata["document_code"] == "П-2025-04.266-АР"
    assert metadata["discipline"] == "АР"
    assert metadata["doc_stage"] == "PD"
    assert metadata["revision"] == "2"
    assert metadata["approval_status"] == "FOR_CONSTRUCTION"
    assert metadata["approval_date"] == "2026-03-15"
    assert metadata["stamps"]["in_production"] is True
    assert metadata["sheets"] == [
        {"page": 1, "sheet": "4", "sheet_title": None},
        {"page": 2, "sheet": "5", "sheet_title": None},
    ]
    assert metadata["field_confidence"]["document_code"] > 0.5


def test_document_metadata_keeps_unknown_fields_empty() -> None:
    """Ничего не выдумываем: пустой документ — пустые поля."""
    metadata = document_metadata([{"page": 1, "blocks": []}])

    assert metadata["document_code"] is None
    assert metadata["doc_stage"] is None
    assert metadata["approval_status"] == "UNKNOWN"


def test_document_metadata_uses_file_name() -> None:
    metadata = document_metadata([{"page": 1, "blocks": []}], file_name="РД-2025-04-266-АР2.pdf")

    assert metadata["discipline"] == "АР"
    assert metadata["doc_stage"] == "RD"


def test_fix_name_restores_broken_encoding() -> None:
    broken = "Проектная документация".encode("cp866").decode("mac_cyrillic")

    assert looks_broken(broken)
    assert fix_name(broken) == "Проектная документация"


def test_fix_name_leaves_correct_names_alone() -> None:
    assert fix_name("3. П-2025-04-266-АР Изм. 1.pdf") == "3. П-2025-04-266-АР Изм. 1.pdf"
    assert fix_name("plain-latin.pdf") == "plain-latin.pdf"
