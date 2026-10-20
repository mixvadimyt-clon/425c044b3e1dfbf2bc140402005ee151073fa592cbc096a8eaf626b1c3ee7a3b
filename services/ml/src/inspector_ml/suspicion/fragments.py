"""Что под областью различия на листе-чертеже: таблица, текст, основная надпись или сам чертёж.

Зачем. Рецензия экспертов 17.10, п. 5: в описании графической гипотезы стояло «возможно, на листах разные сети или
изменена трасса — проверьте» без всякого условия. А на их примере («Тюменская 5», ПД стр. 83 ↔ РД стр. 15) рамка стоит
на примечании над штампом («Значение, указанное в скобках…» есть только в РД), на ПД стр. 84 ↔ РД стр. 16 — на таблице
характеристик систем. Текст этих листов нарисован шрифтом САПР, таблиц разбор на них не видит, поэтому тип области
определяется по её изображению:

- **основная надпись** — область больше чем наполовину в зоне штампа (`STAMP_MM` в правом нижнем углу по ГОСТ Р 21.101):
  различия шифра, дат и подписей инспектору не показываем. Если в зону заходит только низ области, её часть в зоне
  отрезается и тип определяется по остатку;
- **таблица** — сетка: не меньше `GRID_LINES` длинных горизонтальных и столько же вертикальных линий. На листе, который
  по названию план, схема или разрез, сетка нужна строже (`STRICT`): стены и размерные линии плана тоже дают длинные
  линии в обе стороны — на «Алтуфьевском» (КР стр. 44) так в таблицы попадал план проёмов;
- **текст** — большая часть чернил в мелких знаках высотой до `TEXT_MM`: примечания, подписи, текстовые требования;
- иначе **чертёж** — что именно (план, схема, разрез), говорит название листа (`sheet_kind`).
"""

from __future__ import annotations

import re
from collections.abc import Iterable

import cv2
import numpy as np

from inspector_ml.cv import sheetdiff

Box = tuple[float, float, float, float]

STAMP, TABLE, TEXT, DRAWING = "stamp", "table", "text", "drawing"
PLAN, SCHEME, SECTION = "plan", "scheme", "section"

#: Как назвать фрагмент в тексте гипотезы и на рамке.
NAME = {
    STAMP: "основная надпись",
    TABLE: "таблица",
    TEXT: "текст",
    PLAN: "план",
    SCHEME: "схема",
    SECTION: "разрез или узел",
    DRAWING: "чертёж",
}
#: «Различаются 3 обл.: в таблице — 1, на плане — 2».
WHERE = {
    TABLE: "в таблице",
    TEXT: "в тексте",
    PLAN: "на плане",
    SCHEME: "на схеме",
    SECTION: "на разрезе или узле",
    DRAWING: "на чертеже",
}
#: Вид листа по названию в штампе; порядок важен: «Схема расположения… План» — схема, «Спецификация к плану» — таблица.
SHEET_KINDS = (
    (TABLE, re.compile(r"(?i)спецификац|ведомост|таблиц|экспликац|характеристик")),
    (SECTION, re.compile(r"(?i)разрез|фасад|сечени|узел|узлы|детал")),
    (SCHEME, re.compile(r"(?i)схем")),
    (PLAN, re.compile(r"(?i)план")),
)
#: Основная надпись по ГОСТ Р 21.101 — 185 × 55 мм в правом нижнем углу, рамка в 5 мм от края; с запасом — эта зона.
STAMP_MM = (195.0, 65.0)
#: Высота знака текста на чертеже — 2,5–3,5 мм; знаки до этой высоты — текст, а не линии чертежа.
TEXT_MM = 4.0
#: Линия длиннее этой доли области — линия сетки таблицы (или стена плана — поэтому нужны оба направления).
LINE_SHARE = 0.5
#: Столько длинных линий в каждом направлении — сетка таблицы.
GRID_LINES = 2
#: На листе-чертеже (план, схема, разрез) сетка таблицы — линии почти во всю область, и их больше.
STRICT = (0.85, 3)
#: Чернила в мелких знаках — не меньше этой доли остальных чернил области: это текст.
TEXT_SHARE = 0.6


def sheet_kind(texts: Iterable[str]) -> str | None:
    """Вид листа по названию: план, схема, разрез, таблица; `None` — по названию не понять."""
    for text in texts:
        for kind, pattern in SHEET_KINDS:
            if pattern.search(text):
                return kind
    return None


def stamp_zone(width_pt: float, height_pt: float) -> Box:
    """Зона основной надписи в долях страницы."""
    width_mm, height_mm = width_pt * 25.4 / 72, height_pt * 25.4 / 72
    return (max(0.0, 1 - STAMP_MM[0] / width_mm), max(0.0, 1 - STAMP_MM[1] / height_mm), 1.0, 1.0)


def outside_stamp(box: Box, zone: Box) -> Box | None:
    """Часть области вне зоны штампа; `None` — область больше чем наполовину в зоне."""
    if _share(box, zone) > 0.5:
        return None
    x0, y0, x1, y1 = box
    # низ области заходит в зону сверху — отрезаем его, если по ширине область над зоной
    if y1 > zone[1] > y0 and _share((x0, y0, x1, y1), (zone[0], 0.0, zone[2], 1.0)) >= 0.5:
        return (x0, y0, x1, zone[1])
    return box


def classify(image: np.ndarray, px_per_mm: float, *, drawing_sheet: bool = False) -> str:
    """Тип области по изображению (BGR): таблица, текст или чертёж.

    `drawing_sheet` — лист по названию план, схема или разрез: таблицей область считается только при строгой сетке.
    """
    if image.size == 0:
        return DRAWING
    mask = sheetdiff.ink(image).astype(np.uint8)
    height, width = mask.shape
    share, need = STRICT if drawing_sheet else (LINE_SHARE, GRID_LINES)
    horizontal = _lines(mask, (max(3, int(width * share)), 1))
    vertical = _lines(mask, (1, max(3, int(height * share))))
    if horizontal >= need and vertical >= need:
        return TABLE
    # без длинных линий: доля чернил в знаках высотой до TEXT_MM
    lines = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(3, width // 3), 1)))
    rest = mask & ~lines
    count, _labels, stats, _centroids = cv2.connectedComponentsWithStats(rest, connectivity=8)
    total = int(stats[1:, cv2.CC_STAT_AREA].sum()) if count > 1 else 0
    if not total:
        return DRAWING
    limit = TEXT_MM * px_per_mm
    small = stats[1:][(stats[1:, cv2.CC_STAT_HEIGHT] <= limit) & (stats[1:, cv2.CC_STAT_WIDTH] <= 3 * limit)]
    if len(small) >= 8 and small[:, cv2.CC_STAT_AREA].sum() >= TEXT_SHARE * total:
        return TEXT
    return DRAWING


def colored_share(image: np.ndarray) -> float:
    """Доля цветных чернил: сети на планах рисуют цветом (канализация коричневым, водопровод синим)."""
    if image.size == 0:
        return 0.0
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    ink = sheetdiff.ink(image)
    total = int(ink.sum())
    return float((ink & (hsv[..., 1] > 90)).sum()) / total if total else 0.0


def _lines(mask: np.ndarray, kernel: tuple[int, int]) -> int:
    opened = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, kernel))
    count, _labels = cv2.connectedComponents(opened, connectivity=8)
    return count - 1


def _share(box: Box, area: Box) -> float:
    """Доля площади `box` внутри `area`."""
    w = max(0.0, min(box[2], area[2]) - max(box[0], area[0]))
    h = max(0.0, min(box[3], area[3]) - max(box[1], area[1]))
    size = max(1e-9, (box[2] - box[0]) * (box[3] - box[1]))
    return w * h / size
