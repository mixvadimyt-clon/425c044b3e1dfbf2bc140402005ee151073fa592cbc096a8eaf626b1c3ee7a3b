"""Совмещение двух листов-чертежей и области различий.

Лист-чертёж здесь — страница, на которой заметную долю занимает растр: скан плана, картинка
ситуационного плана, вставленная в пояснительную записку. Разбор такие листы читает плохо: у РД
пары-примера текстовый слой — 85 символов подписи сверху, а весь смысл — в картинке. Поэтому
анализ идёт по растру исходного файла, а не по разобранному тексту, и `PARSER_VERSION` не трогает.

Шаги:

1. **Растр листа** — самая крупная картинка страницы (не меньше `MIN_SHARE` площади листа),
   отрисованная в цвете: сети на планах различаются цветом (канализация коричневая, водопровод
   синий), а в оттенках серого они почти одинаковы.
2. **Совмещение** — ORB-точки, отбор по тесту Лоу, гомография RANSAC. Одна подложка на двух листах
   стоит в разном месте и в разном масштабе (у пары-примера — в 1,19 раза), поэтому нужна
   гомография, а не сдвиг. Мало согласованных точек — листы разные, сравнивать нечего.
3. **Различия** — «чернила» (насыщенный цвет или тёмный тон) одного листа, которых нет рядом на
   другом. Рядом — в пределах `TOLERANCE_PX`: совмещение не бывает точным до пикселя, а сжатие
   сканов сдвигает линии. Близкие пятна сливаются в области, мелкие отбрасываются.

Координаты наружу — в долях страницы, как `bbox` во всём контракте. Гомография переводит
нормализованные координаты правого листа в левый (так её ждёт экран наложения листов).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

import cv2
import numpy as np
import pymupdf

BoxN = tuple[float, float, float, float]

#: Доля листа, которую должна занимать картинка, чтобы лист считался чертежом-растром.
MIN_SHARE = 0.15
#: Меньше стольких пикселей у самой крупной картинки — логотип, штамп, штрихкод, а не план.
#: У пары-примера план в РД — 896 × 629, в ПД — скан 1653 × 2339.
MIN_IMAGE_PIXELS = 300 * 300
#: Больше стольких картинок — лист-мозаика: на трёх обучающих объектах 43 таких листа, растров среди них 4,
#: а времени — 126 с из 430.
MAX_PAGE_IMAGES = 100
#: Разрешение растра для совмещения и поиска различий: подписи сетей читаются, а ORB укладывается в секунду.
DPI = 150
ORB_FEATURES = 5000
#: Тест Лоу: ближайший дескриптор должен быть заметно ближе второго.
RATIO = 0.75
#: Столько согласованных точек нужно, чтобы считать листы одной подложкой.
MIN_INLIERS = 40
#: И такую долю от отобранных совпадений: у разных листов RANSAC тоже что-то находит, но мало.
MIN_INLIER_RATIO = 0.25
#: Масштаб совмещения в разумных пределах: иначе это вырожденная гомография, а не тот же план.
SCALE_RANGE = (0.2, 5.0)
#: Насколько «рядом» должна быть линия на другом листе, чтобы не считаться различием.
TOLERANCE_PX = 9
#: Радиус, в котором пятна различий сливаются в одну область.
MERGE_PX = 25
#: Меньше этой доли растра — шум сжатия, а не различие.
MIN_REGION_SHARE = 0.002
MAX_REGIONS = 6
#: Тот же ли это лист: один из двух листов должен почти целиком найтись на другом — у него не больше этой
#: доли чернил без пары. Векторные листы одного комплекта делят рамку, сетку осей и шапку таблицы и совмещаются между
#: собой: на «Тюменской 5» из 8642 проверенных пар совместились 2303, и 37 из 42 гипотез сравнивали разные
#: спецификации — у них доля 0,061–0,179. У одной таблицы в ПД и РД, в том числе дополненной в РД, — 0,001–0,027.
#: С проверкой совместились 53 пары, гипотез 15. Известная дыра: 10 из них — тоже разные спецификации, где почти
#: пустой лист ПД «находится» на плотном листе РД того же бланка (текст ближе `TOLERANCE_PX`).
#: Проверка только для пар, где хоть один лист нарисован из векторного описания: у пары куратора (растры, две разные
#: сети на одной подложке) доля 0,081, и её мы показываем.
MAX_UNMATCHED_SHARE = 0.05
#: Длинная сторона листа, отрисованного целиком (`render_sheet`): A0 при 150 dpi — 7000 px, а время совмещения и
#: память растут с площадью. Предел тот же, что у растров разбора (`RENDER_MAX_PX`).
SHEET_MAX_PX = 4000
#: Запас вокруг штампа при закраске, в долях листа: линии рамки штампа выходят за рамки его подписей.
STAMP_MARGIN = 0.005

Side = Literal["left", "right"]


@dataclass(frozen=True)
class Region:
    """Область различия: где она на левом листе и где соответствующее место на правом."""

    side: Side
    """На каком листе есть то, чего нет на другом."""
    left_box: BoxN
    right_box: BoxN
    share: float
    """Доля площади растра — чем больше, тем заметнее различие."""


@dataclass(frozen=True)
class SheetDiff:
    homography: list[float]
    """3×3 построчно: нормализованные координаты правой страницы → левой."""
    inliers: int
    inlier_ratio: float
    regions: list[Region]
    matched_share: float = 1.0
    """Доля линий и подписей обоих листов, нашедших пару на другом, — «соответствие» пары листов."""


@dataclass(frozen=True)
class Raster:
    """Растр листа-чертежа и где он стоит на странице."""

    image: np.ndarray
    region: BoxN
    """Положение растра на странице, в долях."""
    clean: bool = False
    """Лист нарисован нами из векторного описания (`render_sheet`): шума сжатия нет, тонкие линии не стираем."""


def page_images(document: pymupdf.Document, index: int) -> tuple[int, int]:
    """Сколько картинок на странице и пикселей в самой крупной; битые ресурсы — (0, 0).

    Список картинок читается из ресурсов страницы без её загрузки — это дёшево.
    """
    try:
        images = document.get_page_images(index, full=False)
    except Exception:  # битые ресурсы страницы — не повод ронять сравнение
        return 0, 0
    if not images:
        return 0, 0
    return len(images), max(int(item[2]) * int(item[3]) for item in images)


def is_mosaic(count: int) -> bool:
    """Лист-мозаика из сотен плиток — векторный чертёж САПР с заливками, а не растр."""
    return count > MAX_PAGE_IMAGES


def image_pixels(document: pymupdf.Document, index: int) -> int:
    """Пикселей в самой крупной картинке страницы; 0 — растра-чертежа на ней нет.

    Дешёвый отсев до `drawing_region`: `get_image_info` строит текстовый слой — 30–60 мс на лист, минуты
    на комплект. Лист без картинок, с одним логотипом или штампом и лист-мозаика (`get_image_info` на нём
    идёт до 13 с) чертежом-растром не считаются.
    """
    count, pixels = page_images(document, index)
    if not count or is_mosaic(count):
        return 0
    return pixels if pixels >= MIN_IMAGE_PIXELS else 0


def drawing_region(page: pymupdf.Page) -> BoxN | None:
    """Самая крупная картинка страницы в долях листа, если она занимает не меньше `MIN_SHARE`."""
    width, height = page.rect.width, page.rect.height
    if width <= 0 or height <= 0 or not image_pixels(page.parent, page.number):
        return None
    best: tuple[float, BoxN] | None = None
    for info in page.get_image_info():
        x0, y0, x1, y1 = (max(0.0, v) for v in info["bbox"])
        x1, y1 = min(x1, width), min(y1, height)
        if x1 <= x0 or y1 <= y0:
            continue
        share = (x1 - x0) * (y1 - y0) / (width * height)
        if share >= MIN_SHARE and (best is None or share > best[0]):
            best = (share, (x0 / width, y0 / height, x1 / width, y1 / height))
    return best[1] if best else None


def render(page: pymupdf.Page, region: BoxN, dpi: int = DPI, max_px: int = SHEET_MAX_PX) -> np.ndarray:
    """Цветной растр области страницы (BGR) — не больше `max_px` по длинной стороне, как лист целиком.

    Без предела растр почти всего листа A0 при 150 dpi — 7000 × 4900, около 100 МБ, и на профиле GPU (150 листов на
    стадию) графика «Речникова» упёрлась в память WSL (17.10).
    """
    rect = page.rect
    clip = pymupdf.Rect(
        rect.x0 + region[0] * rect.width,
        rect.y0 + region[1] * rect.height,
        rect.x0 + region[2] * rect.width,
        rect.y0 + region[3] * rect.height,
    )
    dpi = sheet_dpi(clip.width, clip.height, dpi, max_px)
    pixmap = page.get_pixmap(dpi=dpi, clip=clip, colorspace=pymupdf.csRGB, alpha=False)
    image = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(pixmap.height, pixmap.width, 3)
    return cv2.cvtColor(image, cv2.COLOR_RGB2BGR)


def sheet_dpi(width_pt: float, height_pt: float, dpi: int = DPI, max_px: int = SHEET_MAX_PX) -> int:
    """Разрешение для листа целиком: `dpi`, но длинная сторона не больше `max_px`."""
    longest_in = max(width_pt, height_pt) / 72
    return max(1, min(dpi, int(max_px / longest_in))) if longest_in > 0 else dpi


def sheet_pixels(width_pt: float, height_pt: float, dpi: int = DPI, max_px: int = SHEET_MAX_PX) -> int:
    """Сколько пикселей даст `render_sheet` — для порядка обхода наравне с размером растра."""
    scale = sheet_dpi(width_pt, height_pt, dpi, max_px) / 72
    return int(width_pt * scale) * int(height_pt * scale)


def render_sheet(page: pymupdf.Page, masks: Sequence[BoxN] = (), dpi: int = DPI, max_px: int = SHEET_MAX_PX) -> Raster:
    """Лист целиком — для векторного чертежа САПР и листа-мозаики, у которых нет одной крупной картинки.

    `masks` закрашиваются белым: это штамп, где у ПД и РД разные шифры, даты и подписи, — различие документов, а
    не чертежа. Область растра — весь лист, поэтому координаты областей различий — сразу доли страницы.

    Рисуется без сглаживания: сглаженная линия САПР толщиной 0,18–0,35 мм выходит серой и тоньше 3 px, и пропажа
    такой линии из РД не находилась (опыт 16.10: ловились только линии от 0,5 мм на A4 и от 0,7 мм на A1).
    """
    previous = pymupdf.TOOLS.show_aa_level()
    pymupdf.TOOLS.set_aa_level(0)
    try:
        image = render(page, (0.0, 0.0, 1.0, 1.0), sheet_dpi(page.rect.width, page.rect.height, dpi, max_px)).copy()
    finally:
        pymupdf.TOOLS.set_aa_level(int(previous["graphics"]))
    height, width = image.shape[:2]
    for x0, y0, x1, y1 in masks:
        cv2.rectangle(
            image,
            (int(x0 * width), int(y0 * height)),
            (int(np.ceil(x1 * width)), int(np.ceil(y1 * height))),
            (255, 255, 255),
            -1,
        )
    return Raster(image=image, region=(0.0, 0.0, 1.0, 1.0), clean=True)


def raster(page: pymupdf.Page, dpi: int = DPI) -> Raster | None:
    region = drawing_region(page)
    if region is None:
        return None
    return Raster(image=render(page, region, dpi), region=region)


@dataclass
class Features:
    keypoints: tuple
    descriptors: np.ndarray | None


def features(image: np.ndarray) -> Features:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    keypoints, descriptors = cv2.ORB_create(nfeatures=ORB_FEATURES).detectAndCompute(gray, None)
    return Features(keypoints, descriptors)


def align(left: Features, right: Features) -> tuple[np.ndarray, int, float] | None:
    """Преобразование «правый растр → левый» в пикселях (3×3), число и доля согласованных точек.

    Одна подложка на двух листах отличается поворотом, масштабом и сдвигом, поэтому берётся
    подобие (`estimateAffinePartial2D`), а не полная гомография: у той RANSAC добавляет
    перспективу из шума, и наложение «плывёт» к краям листа. `None` — листы разные.
    """
    if left.descriptors is None or right.descriptors is None or len(left.keypoints) < 8 or len(right.keypoints) < 8:
        return None
    pairs = cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(right.descriptors, left.descriptors, k=2)
    good = [m for m, n in (p for p in pairs if len(p) == 2) if m.distance < RATIO * n.distance]
    if len(good) < MIN_INLIERS:
        return None
    source = np.float32([right.keypoints[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    target = np.float32([left.keypoints[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    affine, mask = cv2.estimateAffinePartial2D(source, target, method=cv2.RANSAC, ransacReprojThreshold=4.0)
    if affine is None or mask is None:
        return None
    homography = np.vstack([affine, [0.0, 0.0, 1.0]])
    inliers = int(mask.sum())
    ratio = inliers / len(good)
    scale = float(np.sqrt(abs(np.linalg.det(homography[:2, :2]))))
    if inliers < MIN_INLIERS or ratio < MIN_INLIER_RATIO or not SCALE_RANGE[0] <= scale <= SCALE_RANGE[1]:
        return None
    return homography, inliers, ratio


def ink(image: np.ndarray) -> np.ndarray:
    """Линии и подписи: насыщенный цвет (сети, отметки) или тёмный тон (контуры, текст)."""
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    return ((hsv[..., 1] > 90) & (hsv[..., 2] < 235)) | (hsv[..., 2] < 90)


def compare(
    left: Raster, right: Raster, left_features: Features | None = None, right_features: Features | None = None
) -> SheetDiff | None:
    """Совместить растры и найти различия. `None` — листы не совмещаются (это разные чертежи)."""
    aligned = align(left_features or features(left.image), right_features or features(right.image))
    if aligned is None:
        return None
    homography, inliers, ratio = aligned
    height, width = left.image.shape[:2]
    warped = cv2.warpPerspective(right.image, homography, (width, height), borderValue=(255, 255, 255))
    covered = cv2.warpPerspective(np.full(right.image.shape[:2], 255, np.uint8), homography, (width, height)) > 0
    covered = cv2.erode(covered.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)

    left_ink, right_ink = ink(left.image) & covered, ink(warped) & covered
    near = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * TOLERANCE_PX + 1, 2 * TOLERANCE_PX + 1))
    only_left = left_ink & ~cv2.dilate(right_ink.astype(np.uint8), near).astype(bool)
    only_right = right_ink & ~cv2.dilate(left_ink.astype(np.uint8), near).astype(bool)
    if (left.clean or right.clean) and _unmatched_share(
        left_ink, right_ink, only_left, only_right
    ) > MAX_UNMATCHED_SHARE:
        return None

    inverse = np.linalg.inv(homography)
    regions: list[Region] = []
    # шум сжатия есть только у сканов и вставленных картинок; у листа, нарисованного нами, его нет — раскрытие
    # стёрло бы тонкие линии САПР
    for side, mask, clean in (("left", only_left, left.clean), ("right", only_right, right.clean)):
        for box, share in _blobs(mask, denoise=not clean):
            right_px = _transform_box(box, inverse)
            regions.append(
                Region(
                    side=side,
                    left_box=_to_page(box, left.region, width, height),
                    right_box=_to_page(right_px, right.region, *right.image.shape[1::-1]),
                    share=share,
                )
            )
    regions.sort(key=lambda r: -r.share)
    return SheetDiff(
        homography=_page_homography(homography, left, right),
        inliers=inliers,
        inlier_ratio=round(ratio, 3),
        regions=regions[:MAX_REGIONS],
        matched_share=_matched_share(left_ink, right_ink, only_left, only_right),
    )


def _matched_share(left_ink: np.ndarray, right_ink: np.ndarray, only_left: np.ndarray, only_right: np.ndarray) -> float:
    """Доля чернил обоих листов, у которых есть пара на другом листе; штамп закрашен ещё при рендере и не считается.

    В отличие от `_unmatched_share`, общая по обоим листам: подробности РД, которых нет в ПД, тоже снижают соответствие.
    """
    total = int(left_ink.sum()) + int(right_ink.sum())
    if not total:
        return 1.0
    return 1.0 - (int(only_left.sum()) + int(only_right.sum())) / total


def _unmatched_share(
    left_ink: np.ndarray, right_ink: np.ndarray, only_left: np.ndarray, only_right: np.ndarray
) -> float:
    """Доля чернил без пары у того листа, где она меньше: насколько один лист целиком есть на другом.

    Меньшая из двух, а не общая: РД обычно подробнее ПД, и у верной пары своих линий много только у одного листа.
    """
    left_total, right_total = int(left_ink.sum()), int(right_ink.sum())
    if not left_total or not right_total:
        return 0.0
    return min(int(only_left.sum()) / left_total, int(only_right.sum()) / right_total)


def _blobs(mask: np.ndarray, denoise: bool = True) -> list[tuple[tuple[float, float, float, float], float]]:
    """Области различий: мелкий шум убирается раскрытием (`denoise`), близкие пятна сливаются."""
    cleaned = mask.astype(np.uint8)
    if denoise:
        cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    merged = cv2.dilate(cleaned, cv2.getStructuringElement(cv2.MORPH_RECT, (MERGE_PX, MERGE_PX)))
    count, _labels, stats, _centroids = cv2.connectedComponentsWithStats(merged)
    found = []
    for x, y, w, h, area in stats[1:count]:
        share = float(area) / mask.size
        if share >= MIN_REGION_SHARE:
            found.append(((float(x), float(y), float(x + w), float(y + h)), share))
    return found


def _transform_box(box: tuple[float, float, float, float], matrix: np.ndarray) -> tuple[float, float, float, float]:
    x0, y0, x1, y1 = box
    corners = np.float32([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]).reshape(-1, 1, 2)
    moved = cv2.perspectiveTransform(corners, matrix).reshape(-1, 2)
    return float(moved[:, 0].min()), float(moved[:, 1].min()), float(moved[:, 0].max()), float(moved[:, 1].max())


def _to_page(box: tuple[float, float, float, float], region: BoxN, width: int, height: int) -> BoxN:
    """Пиксели растра → доли страницы (с обрезкой до листа)."""
    rx0, ry0, rx1, ry1 = region
    x0, y0, x1, y1 = box

    def along(v: float, size: int, lo: float, hi: float) -> float:
        return min(1.0, max(0.0, lo + (v / size) * (hi - lo)))

    return (
        along(x0, width, rx0, rx1),
        along(y0, height, ry0, ry1),
        along(x1, width, rx0, rx1),
        along(y1, height, ry0, ry1),
    )


def _page_homography(homography: np.ndarray, left: Raster, right: Raster) -> list[float]:
    """Гомография в пикселях растров → в нормализованных координатах страниц (правая → левая)."""

    def page_to_raster(raster_: Raster) -> np.ndarray:
        x0, y0, x1, y1 = raster_.region
        height, width = raster_.image.shape[:2]
        sx, sy = width / (x1 - x0), height / (y1 - y0)
        return np.array([[sx, 0, -x0 * sx], [0, sy, -y0 * sy], [0, 0, 1]], dtype=float)

    full = np.linalg.inv(page_to_raster(left)) @ homography @ page_to_raster(right)
    full = full / full[2, 2]
    return [round(float(v), 6) for v in full.flatten()]
