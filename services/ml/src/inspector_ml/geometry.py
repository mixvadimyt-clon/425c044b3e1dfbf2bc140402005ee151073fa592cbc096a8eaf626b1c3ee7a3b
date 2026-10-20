"""Нормализация координат (REQ-PRS-06).

Модуль лежит в корне пакета, а не в `ingest/`: одни и те же правила нужны и разбору PDF,
и OCR, и совмещению чертежей, а перекрёстные импорты между ними давали цикл.

Правило одно для всего сервиса: bbox — это `[x0, y0, x1, y1]` в долях видимой области страницы,
начало координат в **левом верхнем углу**, значения обрезаны до [0; 1]. Так же устроен
viewport pdf.js, поэтому пересчёт на фронте не нужен. А вот `bbox_normalized` в разметке
организаторов отсчитывается от **нижнего** края страницы, как в самом PDF: перед сравнением его
переворачивают (`eval.cv.top_left`, проверено 25.09 на полях штампа обучающей части).

Важная тонкость PyMuPDF: `page.rect` учитывает CropBox и поворот, а координаты текста
возвращаются в **неповёрнутой** системе. Поэтому перед нормализацией bbox нужно перевести
в видимую систему через `page.rotation_matrix` — иначе на повёрнутых страницах (а их в корпусе
около 20 %) подсветка уезжает.
"""

from __future__ import annotations

Box = tuple[float, float, float, float]


def _clamp(value: float) -> float:
    return 0.0 if value < 0.0 else 1.0 if value > 1.0 else value


def normalize_bbox(bbox: Box, page_box: Box, *, digits: int = 6) -> list[float]:
    """Перевести bbox в доли страницы.

    `bbox` и `page_box` должны быть в одной системе координат (обе — видимая область страницы).
    Координаты упорядочиваются, так что `x0 <= x1` и `y0 <= y1`.
    """
    px0, py0, px1, py1 = page_box
    width = px1 - px0
    height = py1 - py0
    if width <= 0 or height <= 0:
        return [0.0, 0.0, 0.0, 0.0]

    x0, y0, x1, y1 = bbox
    left, right = (x0, x1) if x0 <= x1 else (x1, x0)
    top, bottom = (y0, y1) if y0 <= y1 else (y1, y0)

    return [
        round(_clamp((left - px0) / width), digits),
        round(_clamp((top - py0) / height), digits),
        round(_clamp((right - px0) / width), digits),
        round(_clamp((bottom - py0) / height), digits),
    ]


def bbox_area(bbox: list[float]) -> float:
    """Площадь нормализованного bbox (доля страницы)."""
    return max(0.0, bbox[2] - bbox[0]) * max(0.0, bbox[3] - bbox[1])
