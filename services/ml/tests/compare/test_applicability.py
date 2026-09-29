"""Применимость параметра к объекту (верхний узел дерева статусов).

Признаков объекта во входных данных нет, поэтому неприменимость утверждается только по реестру:
раздела нет ни среди загруженных файлов, ни в ожидаемом составе. Без реестра — параметр применим.
"""

from __future__ import annotations

import pytest

from inspector_ml import contracts

if not contracts.is_generated():  # pragma: no cover — CI всегда выполняет uv run gen
    pytest.skip("сначала выполните uv run gen", allow_module_level=True)

from fixtures import file, param, request

from inspector_ml.compare.applicability import doc_marks, marks, reason, sections_of

PZ_NAME = "1. П-2025-04.266-ПЗ.pdf"
KR_NAME = "4. П-2025-04-266-КР.pdf"


def test_marks_are_read_from_code_and_name() -> None:
    assert {"КР", "КР1"} <= marks("НВС-2025.03-4.1-КР1")
    assert "КЖ" in marks(None, "НСЛ-17-02.2026-1_2-КЖ1.1.1.pdf")
    assert marks("") == set()


def test_explanatory_note_is_recognised_by_its_real_code() -> None:
    """«ОПЗ» в шифре — та же пояснительная записка, что и «ПЗ».

    У «Речников ул. 7-7» записка называется «01-07-22-14-П-ОПЗ Изм 2.pdf». «ОПЗ» не было
    в таблице марок, поэтому фильтр `KNOWN_MARKS` отбрасывал её вместе с мусором из имени файла,
    раздел ПЗ выглядел отсутствующим, и M-002 уходил в `NOT_APPLICABLE` на объекте с запиской.
    """
    name = "01-07-22-14-П-ОПЗ Изм 2.pdf"
    assert "ОПЗ" in doc_marks(None, None, name)

    registry = [{"doc_stage": "PD", "file_name": name}]
    sections = sections_of(request([file(1, "PD", name)], registry))
    assert reason(param("M-002", "ПЗ"), sections, has_sources=True) is None


def test_param_without_sources_is_not_applicable() -> None:
    sections = sections_of(request([file(1, "PD", PZ_NAME, discipline="ПЗ")]))
    assert reason(param("M-099", "ПЗ"), sections, has_sources=False) == (
        "В матрице не указаны источники параметра ни в одной стадии"
    )


def test_section_absent_from_registry_makes_param_not_applicable() -> None:
    registry = [{"doc_stage": "PD", "file_name": PZ_NAME, "discipline": "ПЗ"}]
    sections = sections_of(request([file(1, "PD", PZ_NAME, discipline="ПЗ")], registry))
    assert sections.can_judge
    text = reason(param("M-055", "КР"), sections, has_sources=True)
    assert text is not None
    assert text.startswith("Раздел «КР» не представлен в комплекте и не ожидается по реестру")


def test_section_expected_by_registry_keeps_param_applicable() -> None:
    """Раздел КР по реестру ожидается, но файл не загружен — это нехватка источника, не неприменимость."""
    registry = [
        {"doc_stage": "PD", "file_name": PZ_NAME, "discipline": "ПЗ"},
        {"doc_stage": "PD", "discipline": "КР"},
    ]
    sections = sections_of(request([file(1, "PD", PZ_NAME, discipline="ПЗ")], registry))
    assert reason(param("M-055", "КР"), sections, has_sources=True) is None


def test_without_registry_applicability_is_not_claimed() -> None:
    sections = sections_of(request([file(1, "PD", PZ_NAME, discipline="ПЗ")]))
    assert not sections.can_judge
    assert reason(param("M-055", "КР"), sections, has_sources=True) is None


def test_registry_presence_comes_from_api_not_from_the_list() -> None:
    """Реестр загружен, но ожидаемых документов в нём нет, и реестра нет вовсе, — разные случаи."""
    files = [file(1, "PD", PZ_NAME, discipline="ПЗ")]
    empty = sections_of(request(files, [], registry_status="PRESENT"))
    assert empty.can_judge
    assert reason(param("M-055", "КР"), empty, has_sources=True) is not None

    absent = sections_of(request(files, [], registry_status="ABSENT"))
    assert not absent.can_judge
    assert reason(param("M-055", "КР"), absent, has_sources=True) is None


def test_working_marks_count_as_the_design_section() -> None:
    """В РД раздел КР представлен марками КЖ и КМ — параметр раздела КР применим."""
    registry = [{"doc_stage": "RD", "discipline": "КЖ"}]
    sections = sections_of(request([file(2, "RD", "П-2025-04-266-КЖ01.pdf", discipline="КЖ")], registry))
    assert reason(param("M-055", "КР"), sections, has_sources=True) is None


def test_unknown_section_is_never_declared_inapplicable() -> None:
    registry = [{"doc_stage": "PD", "file_name": KR_NAME, "discipline": "КР"}]
    sections = sections_of(request([file(1, "PD", KR_NAME, discipline="КР")], registry))
    assert reason(param("M-900", "НЕТ-В-ТАБЛИЦЕ"), sections, has_sources=True) is None


@pytest.mark.parametrize(
    ("section", "mark", "foreign"),
    [
        ("ИОС1", "ЭОМ", "ОВ"),  # электроснабжение
        ("ИОС2", "ВК", "ЭОМ"),  # водоснабжение
        ("ИОС3", "НВК", "ЭОМ"),  # водоотведение
        ("ИОС4", "ОВ", "ВК"),  # отопление и вентиляция
        ("ИОС5", "СС", "ВК"),  # сети связи
    ],
)
def test_ios_subsections_know_their_own_marks(section: str, mark: str, foreign: str) -> None:
    """Подразделы ИОС нумеруются по 87-ПП: 1 — электроснабжение, не водоснабжение.

    Я сдвинул эту шкалу на единицу (ИОС1 → ВК, ИОС3 → ОВ, ИОС4 → ЭОМ), и ошибка была не
    косметической: раздел «не найден» превращает параметр в `NOT_APPLICABLE`, то есть он молча
    исчезает из проверки. Нашлось на внешнем ревью 2026-09-20.
    """
    own = [{"doc_stage": "RD", "discipline": mark}]
    sections = sections_of(request([file(3, "RD", f"РД-{mark}01.pdf", discipline=mark)], own))
    assert reason(param("M-070", section), sections, has_sources=True) is None

    other = [{"doc_stage": "RD", "discipline": foreign}]
    sections = sections_of(request([file(4, "RD", f"РД-{foreign}01.pdf", discipline=foreign)], other))
    text = reason(param("M-070", section), sections, has_sources=True)
    assert text is not None and text.startswith(f"Раздел «{section}» не представлен")


def test_section_marks_are_taken_from_the_real_matrix() -> None:
    """Марки раздела берутся из матрицы, а не из второго ручного справочника.

    Ручная таблица разошлась с матрицей на все пять подразделов ИОС; чтобы это не повторилось,
    проверяем на настоящем файле: у параметра ИОС1 из матрицы РД описан марками ЭОМ/ЭМ/ЭГ.
    """
    from inspector_ml.matrix import load_params

    matrix = load_params()
    ios1 = [p for p in matrix.values() if (p.section or "").upper() == "ИОС1"]
    assert ios1, "в матрице нет параметров раздела ИОС1 — проверьте data/matrix/params.csv"

    registry = [{"doc_stage": "RD", "discipline": "ЭОМ"}]
    sections = sections_of(request([file(5, "RD", "РД-ЭОМ1.pdf", discipline="ЭОМ")], registry, params=ios1))
    assert "ЭОМ" in sections.allowed("ИОС1")
    assert reason(ios1[0], sections, has_sources=True) is None
