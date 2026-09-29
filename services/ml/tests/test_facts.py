"""Дополнительные сведения о документе (`metadata/facts.py`): язык, шифр проекта, доля сканов, файл PDF."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest

from inspector_ml.metadata.facts import describe, document_facts, file_facts, language, project_code


def page(text: str, *, source: str = "TEXT_LAYER", number: int = 1) -> dict:
    return {
        "page": number,
        "source": source,
        "blocks": [{"id": "b0", "type": "text", "text": text, "bbox": [0, 0, 1, 1]}],
    }


@pytest.mark.parametrize(
    ("code", "expected"),
    [
        ("ЖС-РД-270121-П-АР", "ЖС-РД-270121"),  # «РД» — часть номера проекта, стадия — «П» перед маркой
        ("П-2025-04-266-КЖ02", "П-2025-04-266"),
        ("НВС-2025.03-4.2-КР2", "НВС-2025.03"),  # «4.2» — том
        ("НСЛ-17-02.2026-1_2-КЖ1.1.1", "НСЛ-17-02.2026"),  # «1_2» — корпуса
        ("01-07.22-14-П-ПЗУ-кор.3", "01-07.22-14"),
        ("23-14-РД-КЖ0", "23-14"),
        ("1-П-ИОС5.3.4", None),  # «1» — не шифр проекта
        ("J2-3vd-er", None),  # распознанный мусор: марки нет — не гадаем
        (None, None),
    ],
)
def test_project_code(code: str | None, expected: str | None) -> None:
    assert project_code(code) == expected


class TestLanguage:
    def test_russian_with_latin_marks(self) -> None:
        text = "Фундаментная плита из бетона класса B40 W6 F150, арматура A500C. " * 3

        assert language([page(text)]) == "ru"

    def test_no_letters_on_scan(self) -> None:
        assert language([page("", source="OCR")]) is None

    def test_mixed(self) -> None:
        text = "Specification of materials — спецификация материалов. " * 5

        assert language([page(text)]) == "mixed"


def test_scan_share() -> None:
    pages = [page("текст", number=1), page("скан", source="OCR", number=2), page("скан", source="OCR", number=3)]

    assert document_facts(pages)["scan_share"] == pytest.approx(0.667)


def test_file_facts(make_pdf: Callable[..., Path]) -> None:
    path = make_pdf(pages=2)
    facts = file_facts(path)

    assert facts["file_size"] == path.stat().st_size
    assert str(facts["pdf_version"]).startswith("PDF")
    assert facts["encrypted"] is False


def test_file_facts_of_a_missing_file(tmp_path: Path) -> None:
    assert file_facts(tmp_path / "нет.pdf") == {}


def test_describe_keeps_contract_fields_and_adds_facts() -> None:
    pages = [page("Проектная документация. Раздел 4. Конструктивные решения " * 3)]
    metadata = describe(pages, file_name="ЖС-РД-270121-П-КР 2024.pdf")

    assert metadata["doc_stage"] == "PD"
    assert metadata["discipline"] == "КР"
    assert metadata["language"] == "ru"
    assert "file_size" not in metadata  # без пути к файлу свойств PDF нет
