"""Основная надпись (штамп) — правый нижний угол листа, ГОСТ Р 21.101.

Оттуда берутся шифр документа, стадия, марка, номер листа, изменение и дата. Работаем
по нормализованным координатам блоков: у чертежей штамп занимает правый нижний угол,
у текстовых томов — нижнюю часть титульного листа и колонтитул.

В разметке организаторов эти же поля размечены как `META-DOC-CODE`, `META-SHEET`,
`META-REVISION`, `META-DATE`, `META-MARK` — по ним и сверяемся
(`inspector-ml dataset validate-metadata`).
"""

from __future__ import annotations

import re
from typing import Any

# Прямоугольник основной надписи в долях листа: правый нижний угол.
TITLE_BLOCK_REGION = (0.50, 0.68, 1.0, 1.0)
# Для книжных листов штамп часто шире — берём всю нижнюю полосу.
BOTTOM_STRIP_REGION = (0.0, 0.85, 1.0, 1.0)


def _inside(bbox: list[float], region: tuple[float, float, float, float]) -> bool:
    """Центр блока попадает в область."""
    cx = (bbox[0] + bbox[2]) / 2
    cy = (bbox[1] + bbox[3]) / 2
    x0, y0, x1, y1 = region
    return x0 <= cx <= x1 and y0 <= cy <= y1


def title_block_blocks(blocks: list[dict[str, Any]]) -> list[str]:
    """Идентификаторы блоков, попавших в основную надпись."""
    return [b["id"] for b in blocks if _inside(b["bbox"], TITLE_BLOCK_REGION)]


def title_block_text(page: dict[str, Any]) -> str:
    """Текст основной надписи страницы (пустая строка, если её не видно)."""
    return "\n".join(b["text"] for b in page.get("blocks", []) if _inside(b["bbox"], TITLE_BLOCK_REGION))


def bottom_text(page: dict[str, Any]) -> str:
    """Нижняя полоса листа — запасной источник, когда штамп сдвинут или лист книжный."""
    return "\n".join(b["text"] for b in page.get("blocks", []) if _inside(b["bbox"], BOTTOM_STRIP_REGION))


def page_text(page: dict[str, Any]) -> str:
    return "\n".join(b["text"] for b in page.get("blocks", []))


# Графа 4 ГОСТ Р 21.101 — «наименование изображённого на листе». В штампе она у самого низа
# листа и правее середины: у КЖ это y 0.97–0.98, у АР 0.96–0.97, x от 0.80. Берём с запасом.
SHEET_NAME_REGION = (0.72, 0.92, 1.0, 1.0)
# Шапка штампа: подписи граф, а не содержание. Их в графу 4 не пускаем.
STAMP_LABELS = (
    "изм",
    "кол.уч",
    "кол. уч",
    "№док",
    "№ док",
    "подп",
    "дата",
    "стадия",
    "листов",
    "формат",
    "копировал",
    "разраб",
    "проверил",
    "н.контр",
    "нормоконтр",
    "гип",
    "гап",
    "инв. №",
    "взамен инв",
)
# Название объекта и реквизиты — они одинаковы на всех листах комплекта и лист не различают.
OBJECT_MARKERS = ("расположенн", "адресу", "кадастров", "заказчик", "шифр", 'ооо "', "ооо «")
#: Меньше этого числа кириллических букв — это обозначение узла или номер, а не наименование.
MIN_TITLE_LETTERS = 12
_CYRILLIC = re.compile(r"[а-яё]", re.IGNORECASE)


def sheet_title(page: dict[str, Any]) -> str | None:
    """Наименование листа из основной надписи — «План -3-го этажа», «Схема армирования».

    Именно оно различает листы внутри комплекта: номера листов идут по каждому документу
    заново, а название объекта одинаково на всех. Поэтому из правого нижнего угла отбрасываем
    подписи граф штампа и реквизиты объекта, а из оставшегося берём самый содержательный блок.

    Возвращает `None`, если ничего осмысленного не нашлось: на сканах штамп часто не
    распознаётся, и лучше честно сказать «не знаю», чем отдать шапку графы.
    """
    best: tuple[int, str] | None = None
    for block in page.get("blocks", []):
        if not _inside(block["bbox"], SHEET_NAME_REGION):
            continue
        text = " ".join(block["text"].split())
        lowered = text.lower()
        if any(marker in lowered for marker in STAMP_LABELS) or any(m in lowered for m in OBJECT_MARKERS):
            continue
        letters = len(_CYRILLIC.findall(text))
        if letters < MIN_TITLE_LETTERS:
            continue
        if best is None or letters > best[0]:
            best = (letters, text)
    return best[1] if best else None
