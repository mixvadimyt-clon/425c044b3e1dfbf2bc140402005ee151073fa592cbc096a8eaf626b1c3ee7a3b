"""Сборка `DocumentMetadata` по разобранным страницам (REQ-PRS-08).

Поля собираются по всем листам: шифр и марка берутся по большинству (в томе штамп повторяется
на каждом листе), стадия — по титульному листу и лексике, изменение и даты — максимумом.
Уверенность выше, если значение пришло из основной надписи, а не из произвольного места страницы.
"""

from __future__ import annotations

import re
from collections import Counter
from typing import Any

from inspector_ml.layout.title_block import bottom_text, page_text, title_block_text
from inspector_ml.metadata import classify
from inspector_ml.metadata import revision as rev

# Сколько первых листов считаем «титульными» — там стадия, объект и адрес.
COVER_PAGES = 3
ADDRESS_RE = re.compile(
    r"(?:г\.\s*[А-ЯЁ][а-яё\-]+,?\s*)?"
    r"(?:ул(?:\.|ица)|шоссе|проспект|пр-?т|переулок|пер\.|набережная|наб\.|бульвар|б-р)\s*"
    r"[^,\n]{2,40},?\s*(?:д(?:\.|ом)?\s*)?\d+[А-ЯЁа-яё]?(?:\s*к\.?\s*\d+)?",
    re.IGNORECASE,
)


def _mode(values: list[str]) -> str | None:
    """Самое частое непустое значение."""
    counter = Counter(v for v in values if v)
    return counter.most_common(1)[0][0] if counter else None


def document_metadata(pages: list[dict[str, Any]], *, file_name: str | None = None) -> dict[str, Any]:
    """`DocumentMetadata` по контракту: поля, которые не удалось определить, остаются `None`.

    `file_name` — исходное имя файла из запроса: в корпусе марка и стадия часто зашиты именно
    в него («НВС-2025.03-4.3-КР3.pdf»), а в штампе на скане их может не быть вовсе.
    """
    codes: list[str] = []
    codes_from_stamp = 0
    revisions: list[str] = []
    sheets: list[dict[str, Any]] = []
    stamp_texts: list[str] = []
    dates: list[Any] = []

    for page in pages:
        stamp = title_block_text(page)
        near_stamp = stamp or bottom_text(page)
        full = page_text(page)
        stamp_texts.append(near_stamp)

        code = classify.document_code(near_stamp)
        if code:
            codes_from_stamp += 1
        else:
            code = classify.document_code(full)
        if code:
            codes.append(code)

        value = rev.revision(near_stamp) or rev.revision(full)
        if value:
            revisions.append(value)

        found_date = rev.latest_date(near_stamp)
        if found_date:
            dates.append(found_date)

        sheets.append({"page": page["page"], "sheet": rev.sheet(near_stamp), "sheet_title": None})

    stamp_text = "\n".join(stamp_texts)
    cover_text = "\n".join(page_text(page) for page in pages[:COVER_PAGES])

    code = _mode(codes)
    stage = classify.doc_stage(cover_text + "\n" + stamp_text, code, file_name)
    address = ADDRESS_RE.search(cover_text)

    return {
        "doc_stage": stage,
        "doc_kind": classify.doc_kind(cover_text, stage),
        "discipline": classify.discipline(stamp_text or cover_text, code, file_name),
        "document_code": code,
        "revision": max(revisions, key=int) if revisions else None,
        "approval_status": rev.approval_status(stamp_text + "\n" + cover_text),
        "approval_date": max(dates).isoformat() if dates else None,
        "signature_status": rev.signature_status(stamp_text + "\n" + cover_text),
        "object_name": None,  # название объекта берём из реестра: в штампах оно сокращено по-разному
        "object_address": address.group(0).strip(" ,") if address else None,
        "sheets": sheets,
        "stamps": rev.stamps(stamp_text),
        "field_confidence": {
            "document_code": round(0.5 + 0.4 * (codes_from_stamp / len(pages)), 2) if codes else 0.0,
            "doc_stage": 0.8 if stage else 0.0,
            "revision": 0.8 if revisions else 0.0,
        },
    }
