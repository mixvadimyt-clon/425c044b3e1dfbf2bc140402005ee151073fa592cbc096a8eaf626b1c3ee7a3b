"""M-003 «Полезная / Расчётная площадь» здания.

Значение — площадь здания в м² из ТЭП или из текста записки: «Расчётная площадь здания — 8010,1»,
«Расчетная площадь 8 526,1 м2», «- расчетная площадь 5559,7 м2;» (раздел энергоэффективности РД).

Общая регулярка матрицы брала любое «расчётная / полезная площадь … число», и на обучающих
объектах (замер 25.09) больше половины значений было чужими:

- **удельные показатели** — «Расчётная площадь на 1 место, м²/место 13,3», «на 1-го учащегося»;
- **пожаротушение** — «минимальная расчётная площадь — 45 м²» у спринклерной секции;
- **технология** — «принята расчётная площадь розлива: 0,25 м²»;
- **формулы** — «F — полезная площадь склада, м²»;
- **единица, прочитанная как число** — «Ар, м2 8 526,1» давало 2 из «м2».

Здесь площадь засчитывается, только если перед числом не названо ничего из этого, число стоит
после слов «расчётная / полезная площадь» (а не цифра из «м2») и похоже на площадь здания — не меньше
`MIN_AREA`. Строка ТЭП (таблица) надёжнее текста: если площадь нашлась в таблице, текст документа
не смотрим. Одинаковые значения внутри документа сводятся к одному.
"""

from __future__ import annotations

import re
from typing import Any

from inspector_ml.contracts.events import MatrixParam
from inspector_ml.extract.base import Found
from inspector_ml.extract.normalize import collapse, number
from inspector_ml.extract.tables import bands, page_cells

UNIT = "м²"
#: Меньше — не площадь здания: розлив, секция пожаротушения, удельная площадь на место.
MIN_AREA = 100.0

#: «расчётная площадь», «полезная площадь» — с возможным уточнением «здания», «(общественных помещений)».
# «площадка» — не площадь: «расчётная площадка» в моделировании рассеивания (ООС)
NAME = re.compile(r"(?:расч[её]тн\w*|полезн\w*)\s+площад(?:ь|и|ью|ей|ям|ями|ях)(?![а-яё])", re.IGNORECASE)
#: Не площадь здания, если это слово стоит в названии показателя или рядом с числом.
FOREIGN = re.compile(
    r"\bна\s+1\b|\bна\s+одн\w*|мест\w*|уч[ае]щ\w*|минимальн\w*|орош\w*|тушен\w*|пожар\w*|спринклер\w*|"
    r"розлив\w*|склад\w*|возгоран\w*|защищаем\w*|секци\w*|помещени\w*\s+№|квартир\w*|\bF\b\s*[-–—]|"
    r"расход\w*|=",
    re.IGNORECASE,
)
#: Число площади: «8 526,1», «8010.1», «5559,7» — не цифра из «м2» и не часть шифра.
AREA = re.compile(r"(?<![\w.,])(\d{1,3}(?:[  ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(?![\d.,]*\d)(?!\s*[-–/]\d)")
#: Между названием и числом — не дальше стольких символов («Расчетная площадь (общественных помещений)
#: Ар, м2 8 526,1» — 40 символов).
GAP = 60


def extract(param: MatrixParam, pages: list[dict[str, Any]]) -> list[Found]:
    """Площадь здания: сначала строки ТЭП во всём документе, если их нет — текст."""
    from_tables = [found for page in pages for found in _from_tables(page)]
    found = from_tables or [found for page in pages for found in _from_text(page)]
    unique: dict[float, Found] = {}
    for item in found:
        unique.setdefault(float(item.value or 0), item)
    return list(unique.values())


def _from_tables(page: dict[str, Any]) -> list[Found]:
    found: list[Found] = []
    for row in bands(page_cells(page)):
        name_cell = next((cell for cell in row if NAME.search(cell.text)), None)
        if name_cell is None or FOREIGN.search(name_cell.text):
            continue
        values = [cell for cell in row if cell.left > name_cell.left and _building_area(cell.text)]
        if not values:
            continue
        value_cell = values[-1]  # показатель проекта — самая правая колонка ТЭП
        found.append(
            Found(
                rule_key=None,
                raw_value=value_cell.text,
                value=_area(value_cell.text),
                page=page["page"],
                bbox=value_cell.bbox,
                snippet=f"{name_cell.text} — {value_cell.text}",
                unit=UNIT,
                method="table",
            )
        )
    return found


def _from_text(page: dict[str, Any]) -> list[Found]:
    found: list[Found] = []
    for block in page.get("blocks") or []:
        if block.get("type") == "title_block":
            continue
        text = collapse(block["text"])
        for name in NAME.finditer(text):
            head = text[max(0, name.start() - 30) : name.end()]
            window = text[name.end() : name.end() + GAP]
            cut = re.search(r"[.;]\s|\n", window)
            window = window[: cut.start()] if cut else window
            if FOREIGN.search(head) or FOREIGN.search(window):
                continue
            area = _first_area(window)
            if area is None:
                continue
            value, raw = area
            found.append(
                Found(
                    rule_key=None,
                    raw_value=raw,
                    value=value,
                    page=page["page"],
                    bbox=block["bbox"],
                    snippet=text[max(0, name.start() - 40) : name.end() + GAP],
                    unit=UNIT,
                    method="text",
                )
            )
    return found


def _first_area(window: str) -> tuple[float, str] | None:
    """Первое число-площадь после названия. Цифру из «м2» граница слова в `AREA` не пропустит."""
    for match in AREA.finditer(window):
        value = _area(match.group(1))
        if value is not None and value >= MIN_AREA:
            return value, match.group(1)
    return None


def _building_area(text: str) -> bool:
    area = _area(text)
    return area is not None and area >= MIN_AREA


def _area(text: str) -> float | None:
    cleaned = text.strip().replace(" ", " ")
    if not re.fullmatch(r"\d{1,3}(?: \d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?", cleaned):
        return None
    return number(cleaned)
