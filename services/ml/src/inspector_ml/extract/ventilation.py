"""Вентиляция по помещениям: системы на схемах ПД и планах РД (IOS4-078 и IOS4-079).

Значение точки — какие системы обслуживают помещение, ключ — `пом. 140`. Сравнивает их правило движка: вытяжка
есть в ПД и пропала в РД, конфигурация систем или приточных установок иная.

- **M-078** (IOS4-078) — системы помещения: «В2.7, В2.8, В2.9». Все помещения, кроме венткамер.
- **M-079** (IOS4-079) — приточные установки в венткамере: «П2, П2.1, П3, …».

Подписи берутся из `cad_words` и `cad_ocr` (их кладёт [cad_labels.py](cad_labels.py) перед сравнением), без них
извлекатель молчит: по блокам разбора помещения на схеме не разделить. Два вида листа:

- **план** (есть экспликация помещений): номер помещения — отдельный блок текстового слоя, номер которого есть в
  экспликации (так кружок помещения не путается с размером); подпись системы — ближайшему кружку не дальше
  `PLAN_RADIUS_PT`. Подписи на планах РД нарисованы шрифтом САПР и читаются OCR;
- **принципиальная схема** (подписи «140 Физического эксперимента»): подпись системы — помещению в ближайшем ряду
  ниже и ближайшему по горизонтали. Приточная установка без такого помещения — ближайшей по горизонтали венткамере.

Замер 17.10 на «Тюменской 5» (схемы ПД `F0171`, планы РД `F0201`, `F0202`): все пять помещений IOS4-078 и венткамера
012 (IOS4-079) из открытой разметки получают значения в обеих стадиях, и значения у всех шести расходятся. Расходятся
ещё пять помещений вне разметки (168, 246, 247, 338, венткамера 006). На «Новослободской» и «Алтуфьевском» значений
нет: в РД нет планов ОВ с экспликацией, которые узнавались бы по шифру.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any

from inspector_ml.contracts.events import MatrixParam
from inspector_ml.extract.base import Found

#: Параметры этого извлекателя: их значения по помещению сводятся по всем документам стадии (`api._union_by_room`).
CODES = frozenset({"M-078", "M-079"})
METHOD = "cad"
METHOD_OCR = "cad_ocr"

ROOM = re.compile(r"^(\d{3}(?:\.\d)?)$")
#: Строка экспликации: «140\nФизического эксперимента\n50.4\nВ3» — номер первой строкой блока, дальше наименование
#: и площадь. Без площади это подпись помещения на схеме: «001\nТехническое подполье».
SCHEDULE_ROW = re.compile(r"^(\d{3}(?:\.\d)?)\n\S")
AREA = re.compile(r"^\d{1,4}[.,]\d{1,2}$")
#: Шрифт САПР распознаётся латиницей: «B2.7», «BE16», «M.O.».
LATIN = str.maketrans({"B": "В", "E": "Е", "P": "Р", "H": "Н", "M": "М", "O": "О", "K": "К", "C": "С", "T": "Т"})
SYSTEM = re.compile(r"^(В|П|ВЕ|ПЕ)(\d+(?:\.\d+)?)((?:,\d+)*)$")
VENT_CHAMBER = re.compile(r"(?i)венткамер")
#: Столько строк экспликации на листе — это план с номерами помещений, а не случайные числа.
MIN_SCHEDULE_ROWS = 5
#: Подпись системы дальше от кружка помещения — уже не его (около 10 см на листе).
PLAN_RADIUS_PT = 300.0
#: Уверенность OCR ниже — подпись не берём: «В2.8» с уверенностью 0,4 бывает и «82.8», и «В2.6».
MIN_OCR_CONFIDENCE = 0.6
#: Схема: ряд помещений одного этажа — номера двухстрочных подписей стоят ниже первой строки ряда.
ROW_BAND = 0.025
#: Схема: подпись системы над помещением — не дальше стольких долей листа по горизонтали и вертикали.
SCHEME_DX = 0.03
SCHEME_DY = 0.12


@dataclass
class Room:
    number: str
    page: int
    bbox: list[float]
    chamber: bool = False
    systems: set[str] = field(default_factory=set)
    labels: list[list[float]] = field(default_factory=list)
    ocr: bool = False


def extract_systems(param: MatrixParam, pages: list[dict[str, Any]]) -> list[Found]:
    """M-078: системы вентиляции каждого помещения, кроме венткамер."""
    return _found(rooms(pages), chambers=False)


def extract_units(param: MatrixParam, pages: list[dict[str, Any]]) -> list[Found]:
    """M-079: приточные установки в венткамерах."""
    return _found(rooms(pages), chambers=True)


def rooms(pages: list[dict[str, Any]]) -> dict[str, Room]:
    """Помещения документа с системами со всех его листов ОВ; лист без подписей САПР пропускается."""
    found: dict[str, Room] = {}
    for page in pages:
        if "cad_words" not in page:
            continue
        number = int(page.get("page") or 0)
        width, height = float(page.get("width_pt") or 0), float(page.get("height_pt") or 0)
        if not width or not height:
            continue
        rows = schedule(page)
        on_page = _plan(page, number, rows, width, height) if rows else _scheme(page, number)
        for room in on_page.values():
            if not room.systems:
                continue
            # помещение бывает на нескольких листах (продолжения схемы): системы объединяются, доказательство —
            # лист, где их больше
            known = found.get(room.number)
            if known is not None:
                if len(room.systems) <= len(known.systems):
                    known.systems |= room.systems
                    continue
                room.systems |= known.systems
            found[room.number] = room
    return found


def systems_in(text: str) -> list[str]:
    """«B2.7,8,9» → В2.7, В2.8, В2.9; «П2/ВЕ» → П2, ВЕ; «П17.1, 17.2» → П17.1, П17.2; «BE16» → ВЕ16."""
    out: list[str] = []
    prefix, head = "", ""
    for token in re.split(r"[\s/|;]+", text.translate(LATIN)):
        token = token.strip(" ,.")
        if token in ("ВЕ", "ПЕ"):
            out.append(token)
            continue
        match = SYSTEM.match(token)
        if match:
            prefix, first, rest = match.groups()
            head = first.rsplit(".", 1)[0] if "." in first else ""
            out.append(prefix + first)
            for tail in rest.strip(",").split(",") if rest else []:
                out.append(f"{prefix}{head}.{tail}" if head else prefix + tail)
        elif prefix and head and re.fullmatch(rf"{re.escape(head)}\.\d+", token):
            out.append(prefix + token)  # «П17.1, 17.2»: второй номер без буквы
        else:
            prefix, head = "", ""
    return out


def labels(page: dict[str, Any]) -> list[tuple[list[str], list[float], bool]]:
    """Подписи систем листа: из текстового слоя и из OCR, с рамкой и пометкой «распознано».

    Слова внутри экспликации не берутся: «В3», «В4» в ней — категория помещения по пожарной опасности, а не система.
    """
    table = [block["bbox"] for block in _schedule_blocks(page)]
    items = [(word, False) for word in page.get("cad_words") or []]
    items += [(line, True) for line in page.get("cad_ocr") or [] if line.get("conf", 0.0) >= MIN_OCR_CONFIDENCE]
    found = []
    for item, ocr in items:
        systems = systems_in(item["text"])
        if systems and not any(_inside(_center(item["bbox"]), box) for box in table):
            found.append((systems, item["bbox"], ocr))
    return found


def schedule(page: dict[str, Any]) -> dict[str, str]:
    """Экспликация помещений листа: номер → наименование. Меньше `MIN_SCHEDULE_ROWS` строк — экспликации нет."""
    rows = {}
    for block in _schedule_blocks(page):
        lines = block["text"].strip().split("\n")
        rows[lines[0]] = lines[1]
    return rows if len(rows) >= MIN_SCHEDULE_ROWS else {}


def _schedule_blocks(page: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for block in page.get("blocks") or []:
        lines = (block.get("text") or "").strip().split("\n")
        if (
            SCHEDULE_ROW.match("\n".join(lines))
            and any(AREA.match(line.strip()) for line in lines[2:])
            and len(block.get("bbox") or []) == 4
        ):
            rows.append(block)
    return rows


def _plan(page: dict[str, Any], number: int, rows: dict[str, str], width: float, height: float) -> dict[str, Room]:
    """План: кружки помещений — отдельные блоки с номером из экспликации; подпись — ближайшему кружку."""
    circles: dict[str, Room] = {}
    for block in page.get("blocks") or []:
        text = (block.get("text") or "").strip()
        if ROOM.match(text) and text in rows and len(block.get("bbox") or []) == 4:
            circles.setdefault(text, Room(text, number, list(block["bbox"]), bool(VENT_CHAMBER.search(rows[text]))))
    if not circles:
        return {}
    centers = {key: _center(room.bbox) for key, room in circles.items()}
    for systems, bbox, ocr in labels(page):
        cx, cy = _center(bbox)
        key, distance = min(
            ((key, math.hypot((x - cx) * width, (y - cy) * height)) for key, (x, y) in centers.items()),
            key=lambda item: item[1],
        )
        if distance <= PLAN_RADIUS_PT:
            room = circles[key]
            room.systems.update(systems)
            room.labels.append(bbox)
            room.ocr |= ocr
    return circles


def _scheme(page: dict[str, Any], number: int) -> dict[str, Room]:
    """Принципиальная схема: подписи «140 Физического эксперимента»; система — помещению в ряду под ней."""
    words = page.get("cad_words") or []
    found: dict[str, Room] = {}
    for i, word in enumerate(words):
        if not ROOM.match(word["text"]):
            continue
        name = _name_after(words, i)
        if name:
            found.setdefault(
                word["text"], Room(word["text"], number, list(word["bbox"]), bool(VENT_CHAMBER.search(name)))
            )
    if not found:
        return {}
    rooms_list = list(found.values())
    chambers = [room for room in rooms_list if room.chamber]
    for systems, bbox, ocr in labels(page):
        cx, cy = _center(bbox)
        room = _room_below(rooms_list, cx, cy)
        if room is None and chambers and all(s.startswith("П") for s in systems):
            room = min(chambers, key=lambda r: abs(_center(r.bbox)[0] - cx))
        if room is not None:
            room.systems.update(systems)
            room.labels.append(bbox)
            room.ocr |= ocr
    return found


def _name_after(words: list[dict[str, Any]], index: int) -> str:
    """Наименование помещения после номера: следующие слова той же подписи (блока), если они — слова, а не числа."""
    word = words[index]
    tail = [
        w["text"]
        for w in words[index + 1 : index + 4]
        if w.get("block") == word.get("block") and not ROOM.match(w["text"])
    ]
    return " ".join(tail) if tail and re.match(r"^[А-ЯЁа-яё]{3,}", tail[0]) else ""


def _room_below(rooms_list: list[Room], cx: float, cy: float) -> Room | None:
    below = [room for room in rooms_list if _center(room.bbox)[1] > cy]
    if not below:
        return None
    row = min(_center(room.bbox)[1] for room in below)
    if row - cy > SCHEME_DY:
        return None
    candidates = [room for room in below if _center(room.bbox)[1] - row < ROW_BAND]
    room = min(candidates, key=lambda r: abs(_center(r.bbox)[0] - cx))
    return room if abs(_center(room.bbox)[0] - cx) < SCHEME_DX else None


def _found(found: dict[str, Room], *, chambers: bool) -> list[Found]:
    result = []
    for room in sorted(found.values(), key=lambda r: r.number):
        if room.chamber != chambers:
            continue
        systems = sorted(s for s in room.systems if not chambers or s.startswith("П"))
        if not systems:
            continue
        value = ", ".join(systems)
        bbox = _union([room.bbox, *room.labels])
        result.append(
            Found(
                rule_key=f"пом. {room.number}",
                raw_value=value,
                value=value,
                page=room.page,
                bbox=bbox,
                snippet=f"пом. {room.number}: {value}",
                method=METHOD_OCR if room.ocr else METHOD,
            )
        )
    return result


def _inside(point: tuple[float, float], box: list[float]) -> bool:
    return box[0] <= point[0] <= box[2] and box[1] <= point[1] <= box[3]


def _center(bbox: list[float]) -> tuple[float, float]:
    return (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2


def _union(boxes: list[list[float]]) -> list[float]:
    return [
        round(min(b[0] for b in boxes), 5),
        round(min(b[1] for b in boxes), 5),
        round(max(b[2] for b in boxes), 5),
        round(max(b[3] for b in boxes), 5),
    ]
