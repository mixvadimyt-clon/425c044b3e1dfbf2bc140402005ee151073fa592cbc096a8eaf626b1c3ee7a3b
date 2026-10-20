"""Объекты листа — подписи с координатами: что именно изменилось на совмещённой паре листов (шаг 2).

Зачем. Графика (`visual.py`) находит области, где на одном листе есть линии, которых нет на другом, но не говорит,
что изменилось, и не видит другую подпись на том же месте: буквы ближе 9 px друг к другу для неё общие. На
«Алтуфьевском, 79Б» разрез КР стр. 49 и тот же разрез в КЖ02 стр. 17 совмещаются, а подписи на тех же местах разные:
слой 280 → 300 мм, отметки −0.365 → −0.385 и −0.465 → −0.485; в ведомости деталей у стержня Л-8 размеры 300 и 150 стали
298 и 146.

Как:

1. **Объекты** — слова текстового слоя листа (PyMuPDF) вне штампа, вид которых узнаётся по записи (`KINDS`): отметка,
   класс бетона или арматуры, диаметр, сечение, размер (от трёх цифр), марка («Л-8», «СВВ-3»), система вентиляции и
   сетей. Подписи шрифтом САПР нарисованы линиями, в текстовом слое их нет: для них — строки OCR листа целиком из
   кеша (`cad_labels.cached`, 18.10), если лист распознавали.
2. **Сопоставление** — один к одному, в три прохода. Объекты правого листа переносятся на левый гомографией
   совмещения. Сначала пары с той же записью рядом (`RADIUS`, у отметок шире — `ELEVATION_RADIUS`: отметка уезжает
   вместе с изменённым слоем) — общие. Из оставшихся — пары с той же записью подальше (`MOVED_RADIUS`): подпись
   передвинули, это не изменение. Из оставшихся — тот же вид рядом с другой записью: изменение.
3. **Когда сравнивать.** Только если текст есть на обоих листах и в основном общий (`MIN_OBJECTS`, `MIN_COMMON`):
   растровая копия листа без текстового слоя против векторного оригинала дала бы сплошные «пропажи». Изменений больше
   `MAX_CHANGED` от общих — это другая редакция листа или съехавшая таблица, а не правка подписей.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np
import pymupdf

Box = tuple[float, float, float, float]

#: Шрифт и OCR пишут кириллицу латиницей («B25», «A500C»), минус бывает типографским.
_NORMALIZE = str.maketrans(
    {
        "A": "А",
        "B": "В",
        "C": "С",
        "E": "Е",
        "H": "Н",
        "K": "К",
        "M": "М",
        "O": "О",
        "P": "Р",
        "T": "Т",
        "X": "Х",
        "x": "х",
        "×": "х",
        "−": "-",
        "–": "-",
    }
)
#: Вид объекта по записи; порядок важен: «В25» — класс бетона, а не система.
KINDS = (
    ("отметка", re.compile(r"^[+±-]?\d{1,3}[.,]\d{3}$")),
    ("класс", re.compile(r"^(?:В\d{2}(?:[.,]5)?|А\d{3}С?|С\d{3}|F\d{2,3}|W\d{1,2})$")),
    ("диаметр", re.compile(r"^(?:[ØøФ⌀∅]|Ду|d=?)\d{1,4}$")),
    ("сечение", re.compile(r"^\d{2,4}х\d{1,4}$")),
    ("размер", re.compile(r"^\d{3,5}$")),
    ("марка", re.compile(r"^[А-ЯЁ]{1,4}-\d{1,3}(?:[.-]\d{1,2})?$")),
    ("система", re.compile(r"^(?:П|В|ПЕ|ВЕ|К|Т)\d{1,2}(?:\.\d{1,2})?$")),
)
#: Скобки и знаки препинания вокруг подписи: «(В25)», «Ø110,» — объект без них.
STRIP = "()[]{},;:«»\"'"
#: Рядом — не дальше стольких долей листа по каждой оси (около 5 мм на A1).
RADIUS = 0.006
#: Отметка уровня стоит у линии и уезжает вместе с ней: на «Алтуфьевском» слой стал толще на 20 мм, и подпись
#: «−0.385» в РД на 0,009 листа ниже «−0.365» в ПД.
ELEVATION_RADIUS = 0.015
#: Та же запись дальше `RADIUS`, но не дальше этого — подпись передвинули, а не изменили.
MOVED_RADIUS = 0.03
#: Меньше объектов на листе — сравнивать нечего: подписи нарисованы линиями или лист — растр без текста.
MIN_OBJECTS = 10
#: Общих объектов не меньше этой доли от меньшего листа — текст на обоих листах один и тот же по происхождению.
MIN_COMMON = 0.5
#: Изменений больше этой доли от общих — другая редакция листа или съехавшая таблица.
MAX_CHANGED = 0.2
#: Строка OCR с уверенностью ниже не берётся — как подписи систем вентиляции (`ventilation.MIN_OCR_CONFIDENCE`).
MIN_OCR_CONFIDENCE = 0.6
#: Слово текстового слоя и то же слово из OCR ближе этого (доли листа) — один объект.
SAME_PLACE = 0.003


@dataclass(frozen=True)
class SheetObject:
    kind: str
    text: str
    box: Box
    """Рамка на своём листе, в долях страницы."""

    @property
    def center(self) -> tuple[float, float]:
        return (self.box[0] + self.box[2]) / 2, (self.box[1] + self.box[3]) / 2


@dataclass(frozen=True)
class Change:
    """Подпись на том же месте совмещённой пары листов, но с другой записью."""

    kind: str
    left: SheetObject
    right: SheetObject

    @property
    def text(self) -> str:
        return f"{self.left.text} → {self.right.text}"


def kind_of(text: str) -> str | None:
    for kind, pattern in KINDS:
        if pattern.match(text):
            return kind
    return None


def read(
    page: pymupdf.Page, exclude: Sequence[Box] = (), ocr: Sequence[dict[str, Any]] | None = None
) -> list[SheetObject]:
    """Объекты листа: слова текстового слоя и строки OCR листа (`ocr`, рамки в долях); вне `exclude` (штампа)."""
    width, height = page.rect.width, page.rect.height
    if not width or not height:
        return []
    words = [
        (word, (x0 / width, y0 / height, x1 / width, y1 / height))
        for x0, y0, x1, y1, word, *_ in page.get_text("words")
    ]
    for line in ocr or ():
        bbox, text = line.get("bbox") or [], str(line.get("text") or "")
        if len(bbox) != 4 or not text or float(line.get("conf") or 0.0) < MIN_OCR_CONFIDENCE:
            continue
        # OCR даёт рамку строки целиком: место слова в ней — по доле символов
        for match in re.finditer(r"\S+", text):
            start, end = match.start() / len(text), match.end() / len(text)
            x0, x1 = bbox[0] + start * (bbox[2] - bbox[0]), bbox[0] + end * (bbox[2] - bbox[0])
            words.append((match.group(0), (x0, bbox[1], x1, bbox[3])))
    found: dict[tuple[str, str, int, int], SheetObject] = {}
    for word, box in words:
        text = word.strip(STRIP).translate(_NORMALIZE)
        kind = kind_of(text)
        if kind is None:
            continue
        center = ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)
        if any(_inside(center, area) for area in exclude):
            continue
        # слово текстового слоя OCR читает ещё раз — одно место, один объект
        key = (kind, text, round(center[0] / SAME_PLACE), round(center[1] / SAME_PLACE))
        found.setdefault(key, SheetObject(kind, text, box))
    return list(found.values())


def changes(
    left: Sequence[SheetObject],
    right: Sequence[SheetObject],
    homography: Sequence[float],
    left_area: Box = (0.0, 0.0, 1.0, 1.0),
    right_area: Box = (0.0, 0.0, 1.0, 1.0),
) -> list[Change]:
    """Изменённые подписи пары; `homography` — 3×3 построчно, нормализованные координаты правой страницы → левой.

    `left_area` и `right_area` — где на страницах лежит совмещённое изображение (растр или лист целиком): объекты вне
    общей части не сравниваются.
    """
    forward = np.array(homography, dtype=float).reshape(3, 3)
    backward = np.linalg.inv(forward)
    # правые объекты в координатах левого листа; и те и другие — только в общей части листов
    moved = [(obj, _apply(forward, obj.center)) for obj in right]
    moved = [(obj, point) for obj, point in moved if _inside(point, left_area)]
    ours = [obj for obj in left if _inside(_apply(backward, obj.center), right_area)]
    if min(len(ours), len(moved)) < MIN_OBJECTS:
        return []

    left_free = set(range(len(ours)))
    right_free = set(range(len(moved)))
    points = np.array([point for _obj, point in moved])

    def pair(same_text: bool, radius_of: Callable[[str], float]) -> list[tuple[int, int]]:
        """Жадно по расстоянию: свободные объекты того же вида рядом, с той же записью или с другой."""
        options = []
        for i in left_free:
            obj = ours[i]
            radius = radius_of(obj.kind)
            offset = np.abs(points - obj.center)
            for j in np.flatnonzero((offset[:, 0] <= radius) & (offset[:, 1] <= radius)):
                other = moved[j][0]
                if j in right_free and other.kind == obj.kind and (other.text == obj.text) == same_text:
                    options.append((float(offset[j].sum()), i, int(j)))
        chosen = []
        for _distance, i, j in sorted(options):
            if i in left_free and j in right_free:
                left_free.discard(i)
                right_free.discard(j)
                chosen.append((i, j))
        return chosen

    common = len(pair(True, _radius))
    pair(True, lambda _kind: MOVED_RADIUS)  # передвинутые подписи — не изменения
    found = [Change(ours[i].kind, ours[i], moved[j][0]) for i, j in pair(False, _radius)]
    found.sort(key=lambda change: (change.left.center[1], change.left.center[0]))

    if common < MIN_COMMON * min(len(ours), len(moved)) or len(found) > MAX_CHANGED * common:
        return []
    return found


def _radius(kind: str) -> float:
    return ELEVATION_RADIUS if kind == "отметка" else RADIUS


def _apply(matrix: np.ndarray, point: tuple[float, float]) -> tuple[float, float]:
    x, y, w = matrix @ np.array([point[0], point[1], 1.0])
    return float(x / w), float(y / w)


def _inside(point: tuple[float, float], box: Box) -> bool:
    return box[0] <= point[0] <= box[2] and box[1] <= point[1] <= box[3]
