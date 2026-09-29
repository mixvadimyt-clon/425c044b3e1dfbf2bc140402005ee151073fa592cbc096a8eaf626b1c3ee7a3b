"""Дополнительные сведения о документе: язык, шифр проекта, доля сканов, свойства файла PDF,
организация-разработчик.

Считаются рядом с `DocumentMetadata` и лежат в том же словаре метаданных. Восемь из них контракт
принял в 0.6.0 , `developer_org` — в 0.7.0 .
Число страниц и страницы с текстовым слоем уже идут в `FileQuality` — их здесь не повторяем.

Дата загрузки и источник — свойства **загрузки**, а не содержимого: кеш разбора общий для
одинаковых файлов (ключ — sha256), и один файл могут загрузить дважды из разных мест. Им место
в api. Фамилии из штампа — персональные данные, их не собираем.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from inspector_ml.layout.title_block import page_text
from inspector_ml.metadata.classify import DISCIPLINES, STAGE_TOKENS
from inspector_ml.metadata.document import document_metadata
from inspector_ml.metadata.organization import developer_org

#: Меньше стольких букв — язык не определяем: скан без распознавания, пустой лист.
MIN_LETTERS = 50
#: Доля букв одного алфавита, начиная с которой документ считается одноязычным.
LANGUAGE_SHARE = 0.8

_CYRILLIC = re.compile(r"[а-яё]", re.IGNORECASE)
_LATIN = re.compile(r"[a-z]", re.IGNORECASE)
#: Короче — не шифр проекта, а номер тома или книги.
MIN_PROJECT_CODE = 3
#: Номер тома или корпусов перед маркой: «4.2», «1_2», «5.3.4» — но не «2025.03» и не «266».
_VOLUME = re.compile(r"^\d{1,2}(?:[._]\d{1,2})+$")


def describe(pages: list[dict[str, Any]], *, file_name: str | None = None, path: Path | None = None) -> dict[str, Any]:
    """Метаданные документа целиком: поля контракта (`document_metadata`) и сведения отсюда.

    Считаются по страницам кеша за доли секунды, поэтому при попадании в кеш их пересчитывают,
    а не берут сохранённые: правки классификатора доходят до кеша без повторного разбора, а имя
    файла берётся из этой загрузки, а не из предрасчёта.
    """
    metadata = document_metadata(pages, file_name=file_name)
    organization, confidence = developer_org(pages, metadata.get("doc_stage"))
    return {
        **metadata,
        **document_facts(pages, document_code=metadata.get("document_code"), path=path),
        "developer_org": organization,
        "field_confidence": {**metadata.get("field_confidence", {}), "developer_org": confidence},
    }


def document_facts(
    pages: list[dict[str, Any]], *, document_code: str | None = None, path: Path | None = None
) -> dict[str, Any]:
    """Сведения, которые не требуют разбора заново: по страницам кеша и по заголовку файла."""
    recognized = sum(1 for page in pages if page.get("source") == "OCR")
    facts: dict[str, Any] = {
        "language": language(pages),
        "project_code": project_code(document_code),
        "scan_share": round(recognized / len(pages), 3) if pages else None,
    }
    if path is not None:
        facts.update(file_facts(path))
    return facts


def language(pages: list[dict[str, Any]]) -> str | None:
    """`ru`, `en` или `mixed` по буквам текста; `None`, если букв почти нет.

    Латиница в наших документах — марки и обозначения (B25, W6, A500C), поэтому документ
    считается русским, пока кириллицы не меньше 80 % букв.
    """
    text = "\n".join(page_text(page) for page in pages)
    cyrillic, latin = len(_CYRILLIC.findall(text)), len(_LATIN.findall(text))
    total = cyrillic + latin
    if total < MIN_LETTERS:
        return None
    if cyrillic >= LANGUAGE_SHARE * total:
        return "ru"
    if latin >= LANGUAGE_SHARE * total:
        return "en"
    return "mixed"


def project_code(document_code: str | None) -> str | None:
    """Шифр проекта — начало шифра документа до стадии и марки раздела.

    «ЖС-РД-270121-П-АР» → «ЖС-РД-270121», «П-2025-04-266-КЖ02» → «П-2025-04-266»,
    «НВС-2025.03-4.2-КР2» → «НВС-2025.03» (номер тома «4.2» — часть шифра документа, не проекта).
    Не нашлось ни стадии перед маркой, ни марки — `None`: гадать шифр проекта хуже, чем не дать.
    """
    if not document_code:
        return None
    parts = document_code.split("-")
    marks = [re.sub(r"[\d.]+$", "", part.upper()) for part in parts]
    for index, mark in enumerate(marks):
        if mark not in DISCIPLINES:
            continue
        if index and parts[index - 1].upper() in STAGE_TOKENS:
            head = parts[: index - 1]  # стадия отделяет проект от документа: «…-270121-П-АР»
        else:
            head = parts[:index]
            if head and _VOLUME.match(head[-1]):
                head.pop()  # «НВС-2025.03-4.2-КР2»: «4.2» — том, а не проект
        code = "-".join(head)
        # «1-П-ИОС5.3.4» → «1»: такой шифр проекта ничего не говорит
        return code if len(code) >= MIN_PROJECT_CODE else None
    return None


def file_facts(path: Path) -> dict[str, Any]:
    """Свойства файла из заголовка PDF: размер, версия, программа, шифрование. Страниц не читаем.

    У DOCX и XML — только размер: свойства PDF у них пустые, а не выдуманные (файл в хранилище лежит
    без расширения, поэтому PDF узнаём по сигнатуре `%PDF-` в первом килобайте).
    """
    try:
        size = path.stat().st_size
        with path.open("rb") as handle:
            is_pdf = b"%PDF-" in handle.read(1024)  # сигнатура может стоять не с первого байта
    except OSError:
        return {}
    facts: dict[str, Any] = {"file_size": size}
    if not is_pdf:
        return facts
    try:
        import pymupdf

        with pymupdf.open(path) as document:
            info = document.metadata or {}
            facts.update(
                {
                    "pdf_version": info.get("format") or None,
                    "pdf_producer": info.get("producer") or None,
                    "pdf_creator": info.get("creator") or None,
                    "encrypted": bool(document.is_encrypted or document.needs_pass),
                }
            )
    except Exception:  # битый заголовок не должен ронять попадание в кеш
        pass
    return facts
