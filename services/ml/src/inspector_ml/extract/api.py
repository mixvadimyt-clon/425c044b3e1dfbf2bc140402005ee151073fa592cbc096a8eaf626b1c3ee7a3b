"""Граница «extract ↔ compare» (см. `docs/services/ml.md`).

Здесь объявлены типы, на которые опирается движок сравнения (`compare/ports.py`),
и диспетчер извлечения: по коду параметра выбирается свой разбор, а для всех остальных
параметров работает общий поиск по `regex_pattern` и якорям матрицы. Где правила в документе
ничего не нашли, числовой параметр может найти Sentence-BERT ([sbert.py](sbert.py)), если он включён.

Роль фрагмента: значение из ПД — `EXPECTED` (эталон прошёл экспертизу), из РД и ИД — `ACTUAL`.
Движок всё равно проставит роль сам, но фрагмент должен быть корректным и в отрыве от него —
его читают выгрузка и интерфейс инспектора.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from inspector_ml.contracts.events import DocumentMetadata, EvidenceFragment, MatrixParam
from inspector_ml.extract import (
    concrete,
    doors,
    elevation,
    foundation,
    regex,
    rooms,
    sbert,
    sewer_outlets,
    useful_area,
    water_flow,
)
from inspector_ml.extract.base import Found
from inspector_ml.logging import get_logger

log = get_logger(__name__)

#: Параметры со своим разбором. Остальные идут через общий поиск по матрице.
#:
#: Интерфейс извлекателя — `(param, pages) -> list[Found]`: `regex_pattern`, `semantic_anchors`
#: и `enum_values` живут в матрице, а не в коде, поэтому параметр нужен и предметному разбору.
EXTRACTORS: dict[str, Callable[[MatrixParam, list[dict[str, Any]]], list[Found]]] = {
    "M-002": rooms.extract,
    "M-003": useful_area.extract,
    "M-009": elevation.extract,
    "M-016": water_flow.extract,
    "M-041": doors.extract,
    "M-055": concrete.extract,
    "M-058": foundation.extract,
    "M-074": sewer_outlets.extract,
}

#: Параметры, чей свой разбор ставит ключ места: помещение, конструкция, выпуск, дверь, отметка. Значение
#: Sentence-BERT без ключа с их точками не сводится (`compare/matching` не сливает группу `None` с группами с
#: ключом), и вместо заполнения точки вышла бы отдельная проверка «на весь параметр». Поэтому запасной путь им
#: значений не ищет. M-003 (полезная площадь) ключа не ставит.
KEYED = frozenset(EXTRACTORS) - {"M-003"}


@dataclass(frozen=True)
class LoadedDocument:
    """Документ актуальной редакции: метаданные из `CompareFile` и разобранный JSON."""

    file_id: Any
    sha256: str
    metadata: DocumentMetadata
    parsed: dict[str, Any]

    @property
    def pages(self) -> list[dict[str, Any]]:
        return self.parsed.get("pages") or []

    @property
    def stage(self) -> str:
        return _plain(self.metadata.doc_stage) or "PD"


@dataclass(frozen=True)
class Extraction:
    """Одно найденное значение параметра в одном документе."""

    param_code: str
    stage: str
    file_id: Any
    rule_key: str | None
    raw_value: str
    value: float | str | bool | None
    unit: str | None
    fragment: EvidenceFragment
    method: str = "regex"


def extractor_for(code: str) -> Callable[[MatrixParam, list[dict[str, Any]]], list[Found]]:
    """Извлекатель параметра: свой разбор, если он есть, иначе общий поиск по матрице.

    Одна точка выбора и для сравнения, и для офлайн-замера (`eval coverage`): иначе замер мерил бы
    не тот код, что работает на стенде.
    """
    return EXTRACTORS.get(code, regex.extract)


def extract_param(
    param: MatrixParam, docs: Sequence[LoadedDocument], *, fallback: sbert.Fallback | None = None
) -> list[Extraction]:
    """Все найденные значения параметра во всех переданных документах.

    `fallback` — запасной путь Sentence-BERT на задачу сравнения (`jobs/handlers.py`), см. `_with_fallback`.
    """
    extractor = extractor_for(param.code)
    found = [(doc, extractor(param, doc.pages)) for doc in docs]
    if fallback is not None and fallback.applies(param):
        found = _with_fallback(param, found, fallback)
    result = [_extraction(param, doc, item) for doc, items in found for item in items]
    log.debug("extract_param", param=param.code, docs=len(docs), found=len(result))
    return result


def _with_fallback(
    param: MatrixParam, found: list[tuple[LoadedDocument, list[Found]]], fallback: sbert.Fallback
) -> list[tuple[LoadedDocument, list[Found]]]:
    """Sentence-BERT — только для стадии, где правила молчат **во всех** её документах, и одно значение на стадию.

    Иначе значение по смыслу из одного документа встало бы рядом со значением правил из другого документа той же
    стадии, и вместо сравнения вышло бы «требуется уточнение»: площадь застройки из ПЗ правилом и «площадь
    застройки жилого дома» из АР по смыслу.
    """
    covered = {doc.stage for doc, items in found if items}
    for stage in dict.fromkeys(doc.stage for doc, _ in found):
        if stage in covered:
            continue
        pick = fallback.best(param, [doc for doc, _ in found if doc.stage == stage])
        if pick is not None:
            chosen, item = pick
            found = [(doc, [item] if doc is chosen else items) for doc, items in found]
    return found


def _extraction(param: MatrixParam, doc: LoadedDocument, found: Found) -> Extraction:
    return Extraction(
        param_code=param.code,
        stage=doc.stage,
        file_id=doc.file_id,
        rule_key=found.rule_key,
        raw_value=found.raw_value,
        value=found.value,
        unit=found.unit or param.unit,
        fragment=_fragment(doc, found),
        method=found.method,
    )


def _fragment(doc: LoadedDocument, found: Found) -> EvidenceFragment:
    page = next((p for p in doc.pages if p.get("page") == found.page), {})
    return EvidenceFragment.model_validate(
        {
            "role": "EXPECTED" if doc.stage == "PD" else "ACTUAL",
            "file_id": str(doc.file_id),
            "sha256": doc.sha256,
            "stage": doc.stage,
            "document_code": doc.metadata.document_code,
            "revision": doc.metadata.revision,
            "approval_status": _plain(doc.metadata.approval_status) or "UNKNOWN",
            "page": found.page,
            "bbox": found.bbox,
            "extracted_value": found.raw_value,
            "normalized_value": None if found.value is None else str(found.value),
            "text_snippet": found.snippet,
            "source": page.get("source") or "TEXT_LAYER",
            # как найдено значение (контракт 0.23.0): пусто — правила, SBERT — запасной путь по смыслу подписи.
            # Инспектор видит пометку в карточке, скорер — признаком `sbert`
            "extraction_method": "SBERT" if found.method == sbert.METHOD else None,
            "quality": page.get("quality") or "OK",
            "confidence": _confidence(page, found.bbox),
        }
    )


#: Какую долю доказательства блок должен перекрыть, чтобы считаться источником его текста.
#: Ячейка таблицы собирается из строк OCR, и её рамка чуть шире их объединения, поэтому порог
#: невысокий: важно не пропустить блок, а не отсечь соседний.
EVIDENCE_OVERLAP = 0.3


def _confidence(page: dict[str, Any], bbox: list[float]) -> float | None:
    """Уверенность распознавания **того самого текста**, из которого взято значение.

    Раньше сюда шла средняя по странице (`ocr_confidence`), и это вводило в заблуждение: на
    странице, где всё распознано чисто, а нужное число — на 0.45, инспектор видел бы 0.88 и
    доверял бы значению больше, чем следует. Надзорная задача этого не прощает.

    Берём минимум по блокам, накрывающим рамку доказательства: ячейка таблицы склеивается из
    нескольких строк OCR, и она не надёжнее худшей из них. Если подходящих блоков нет —
    например, значение пришло из текстового слоя, — остаётся прежнее поведение.
    """
    found = [
        block["confidence"]
        for block in page.get("blocks") or []
        if block.get("confidence") is not None and _covers(block.get("bbox"), bbox)
    ]
    return round(min(found), 4) if found else page.get("ocr_confidence")


def _covers(block: list[float] | None, bbox: list[float]) -> bool:
    """Блок перекрывает заметную долю рамки доказательства."""
    if not block or len(block) != 4 or len(bbox) != 4:
        return False
    width = min(block[2], bbox[2]) - max(block[0], bbox[0])
    height = min(block[3], bbox[3]) - max(block[1], bbox[1])
    if width <= 0 or height <= 0:
        return False
    area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
    return area > 0 and width * height / area >= EVIDENCE_OVERLAP


def _plain(value: object) -> Any:
    """Значение перечисления сгенерированной модели как обычная строка."""
    return getattr(value, "root", value)
