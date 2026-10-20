"""OCR: рендер, плитки, склейка строк и подстановка распознанного текста в страницу.

Сам движок здесь не нужен: он подменяется фейковым. Проверка настоящего PaddleOCR — в
`test_ocr_engine.py`, она пропускается, если extra `ocr` не установлен.
"""

from __future__ import annotations

import sys
import types
from collections.abc import Callable
from pathlib import Path

import numpy as np
import pymupdf
import pytest

from inspector_ml.ingest.pdf import file_quality, parse_pdf
from inspector_ml.ocr.base import OcrLine, OcrOptions
from inspector_ml.ocr.engines import available_engines, build_engine
from inspector_ml.ocr.paddle import current_device, ensure_device
from inspector_ml.ocr.page import recognize_page
from inspector_ml.ocr.render import Tile, dedupe, join_text, reading_order, render_page, shift, stitch, tiles


class FakeEngine:
    """Движок, который «узнаёт» одну строку в левом верхнем углу каждой плитки."""

    name = "fake"

    def __init__(self, text: str = "АОСР №1БТ", confidence: float = 0.9) -> None:
        self.text = text
        self.confidence = confidence
        self.calls = 0

    def recognize(self, image: np.ndarray) -> list[OcrLine]:
        self.calls += 1
        height, width = image.shape[:2]
        return [OcrLine(text=self.text, bbox=(0.0, 0.0, width / 4, height / 10), confidence=self.confidence)]


def options(engine: object | None = None, **overrides: object) -> OcrOptions:
    base: dict[str, object] = {"engine": engine, "dpi": 72, "max_px": 2000, "tile_px": 1600, "overlap_px": 160}
    base.update(overrides)
    return OcrOptions(**base)  # type: ignore[arg-type]


def test_render_page_respects_max_px(make_pdf: Callable[..., Path]) -> None:
    """Лист A0 не рендерим целиком: ограничение по пикселям обязательно."""
    document = pymupdf.open(make_pdf("a0.pdf", width=3370, height=2384))

    image = render_page(document[0], dpi=300, max_px=2000)

    assert max(image.shape) == 2000
    assert image.ndim == 2  # оттенки серого: цвет для OCR не нужен


def test_tiles_cover_large_image() -> None:
    image = np.zeros((3000, 4000), dtype=np.uint8)

    produced = list(tiles(image, tile_px=1600, overlap_px=160))

    assert len(produced) > 1
    assert all(tile.image.shape[0] <= 1600 and tile.image.shape[1] <= 1600 for tile in produced)
    # правый нижний угол попадает хотя бы в одну плитку
    assert max(tile.offset_x + tile.image.shape[1] for tile in produced) == 4000
    assert max(tile.offset_y + tile.image.shape[0] for tile in produced) == 3000


def test_single_tile_for_small_image() -> None:
    image = np.zeros((800, 600), dtype=np.uint8)

    produced = list(tiles(image, tile_px=1600, overlap_px=160))

    assert len(produced) == 1
    assert (produced[0].offset_x, produced[0].offset_y) == (0.0, 0.0)


def test_shift_moves_line_into_page_coordinates() -> None:
    line = OcrLine(text="B25", bbox=(10.0, 20.0, 60.0, 40.0), confidence=0.8)

    moved = shift(line, Tile(image=np.zeros((10, 10), dtype=np.uint8), offset_x=100.0, offset_y=200.0))

    assert moved.bbox == (110.0, 220.0, 160.0, 240.0)


def test_dedupe_keeps_most_confident_duplicate() -> None:
    """Строка из зоны перекрытия плиток не должна попасть в результат дважды."""
    first = OcrLine(text="Экспликация", bbox=(0.0, 0.0, 100.0, 20.0), confidence=0.6)
    second = OcrLine(text="Экспликация", bbox=(2.0, 1.0, 102.0, 21.0), confidence=0.95)
    other = OcrLine(text="Лист 4", bbox=(300.0, 300.0, 360.0, 320.0), confidence=0.7)

    kept = dedupe([first, second, other])

    assert [line.text for line in kept] == ["Экспликация", "Лист 4"]
    assert kept[0].confidence == 0.95


def tile(x: float, y: float, width: float = 1600, height: float = 1600) -> Tile:
    return Tile(image=np.zeros((int(height), int(width)), dtype=np.uint8), offset_x=x, offset_y=y)


def line(text: str, x0: float, y0: float, x1: float, y1: float, confidence: float = 0.9) -> OcrLine:
    return OcrLine(text=text, bbox=(x0, y0, x1, y1), confidence=confidence)


# Лист A4 при 300 dpi шириной 2480 px: две плитки в ряд, полоса перекрытия — x от 1440 до 1600.
LEFT, RIGHT = tile(0, 0), tile(1440, 0, width=1040)


class TestStitch:
    """Строки, разрезанные границами плиток (замер 25.09: «ограниченно енной», «СТРОИТЕЛЬНО ЕЛЬНОГО»)."""

    def test_line_cut_by_vertical_seam_is_joined_by_common_text(self) -> None:
        found = [
            (LEFT, [line("Общество с ограниченно", 1000, 100, 1600, 130)]),
            (RIGHT, [line("енной ответственностью", 1440, 100, 2100, 130, confidence=0.8)]),
        ]

        [joined] = stitch(found, 2480, 1600)

        assert joined.text == "Общество с ограниченной ответственностью"
        assert joined.bbox == (1000, 100, 2100, 130)
        assert 0.8 < joined.confidence < 0.9

    def test_without_common_text_seam_is_the_middle_of_the_overlap(self) -> None:
        """Общего куска нет — режем по середине пересечения рамок, по оценке ширины символа."""
        left = line("абвгдежзий", 1500, 100, 1600, 130)  # 10 px на символ
        right = line("klmnopqrst", 1560, 100, 1660, 130)  # шов на 1580: 8 символов слева, со 2-го справа

        assert join_text(left, right) == "абвгдежз" + "mnopqrst"

    def test_fragment_inside_the_overlap_yields_to_the_whole_line(self) -> None:
        """Строка начинается в полосе перекрытия: левая плитка видит обрывок, правая — целиком."""
        found = [
            (LEFT, [line("Лис", 1500, 100, 1600, 130)]),
            (RIGHT, [line("Лист 4 из 12", 1500, 100, 1800, 130)]),
        ]

        assert [item.text for item in stitch(found, 2480, 1600)] == ["Лист 4 из 12"]

    def test_line_cut_at_the_bottom_yields_to_the_next_row_of_tiles(self) -> None:
        """Полоса перекрытия выше строки текста: в нижнем ряду плиток строка видна целиком."""
        top, bottom = tile(0, 0), tile(0, 1440, height=1000)
        found = [
            (top, [line("Бетон В2", 100, 1580, 600, 1600, confidence=0.99)]),
            (bottom, [line("Бетон В25 W6", 100, 1580, 700, 1620, confidence=0.7)]),
        ]

        assert [item.text for item in stitch(found, 1600, 2440)] == ["Бетон В25 W6"]

    def test_neighbouring_texts_near_the_seam_stay_apart(self) -> None:
        """Разные ячейки одного ряда, рамки которых не заходят друг на друга, не склеиваются."""
        found = [
            (LEFT, [line("Бетон", 1400, 100, 1590, 130)]),
            (RIGHT, [line("В25", 1610, 100, 1700, 130)]),
        ]

        assert [item.text for item in stitch(found, 2480, 1600)] == ["Бетон", "В25"]

    def test_line_across_three_tiles(self) -> None:
        middle, last = tile(1440, 0), tile(2880, 0, width=620)
        found = [
            (LEFT, [line("Производство работ в зимн", 900, 100, 1600, 130)]),
            (middle, [line("зимнее время по ППР ведётся с подогрев", 1440, 100, 3040, 130)]),
            (last, [line("подогревом бетона", 2880, 100, 3300, 130)]),
        ]

        [joined] = stitch(found, 3500, 1600)

        assert joined.text == "Производство работ в зимнее время по ППР ведётся с подогревом бетона"

    def test_whole_duplicate_in_the_overlap_is_kept_once(self) -> None:
        found = [(LEFT, [line("B25", 1460, 100, 1540, 130)]), (RIGHT, [line("B25", 1460, 100, 1540, 130)])]

        assert [item.text for item in stitch(found, 2480, 1600)] == ["B25"]


def test_reading_order_keeps_pieces_of_a_row_left_to_right() -> None:
    """Верх правого куска на полпикселя выше — строка всё равно читается слева направо."""
    lines = [
        line("с ограниченной", 400, 99.5, 700, 130),
        line("Общество", 100, 100.3, 350, 130),
        line("Лист 4", 100, 200, 200, 230),
    ]

    assert [item.text for item in reading_order(lines)] == ["Общество", "с ограниченной", "Лист 4"]


def test_recognize_page_normalizes_bbox(make_pdf: Callable[..., Path]) -> None:
    document = pymupdf.open(make_pdf("scan.pdf"))
    engine = FakeEngine()

    result = recognize_page(document[0], 1, options(engine))

    assert result is not None
    assert result.blocks[0]["text"] == "АОСР №1БТ"
    x0, y0, x1, y1 = result.blocks[0]["bbox"]
    assert (x0, y0) == (0.0, 0.0)
    assert 0 < x1 <= 1 and 0 < y1 <= 1
    assert result.mean_confidence == 0.9


def test_recognize_page_without_engine_returns_none(make_pdf: Callable[..., Path]) -> None:
    document = pymupdf.open(make_pdf())

    assert recognize_page(document[0], 1, options(None)) is None


def test_parse_pdf_recognizes_pages_without_text(make_pdf: Callable[..., Path]) -> None:
    """Страница без текстового слоя уходит в OCR, и её блоки приходят из распознавания."""
    engine = FakeEngine()
    path = make_pdf("empty.pdf", empty=True)

    parsed = parse_pdf(path, "sha", "test", ocr=options(engine))

    page = parsed["pages"][0]
    assert page["source"] == "OCR"
    assert page["quality"] == "OK"
    assert page["ocr_confidence"] == 0.9
    assert page["blocks"][0]["text"] == "АОСР №1БТ"

    quality = file_quality(parsed)
    assert quality["pages_ocr"] == 1
    assert quality["pages_text_layer"] == 0
    assert quality["ocr_mean_confidence"] == 0.9


def test_parse_pdf_skips_pages_with_text_layer(make_pdf: Callable[..., Path]) -> None:
    """Текстовый слой лучше OCR: страницу с текстом не распознаём."""
    engine = FakeEngine()

    parsed = parse_pdf(make_pdf(), "sha", "test", ocr=options(engine))

    assert engine.calls == 0
    assert parsed["pages"][0]["source"] == "TEXT_LAYER"


def test_force_ocr_recognizes_everything(make_pdf: Callable[..., Path]) -> None:
    engine = FakeEngine()

    parsed = parse_pdf(make_pdf(pages=2), "sha", "test", ocr=options(engine, force=True))

    assert engine.calls == 2
    assert all(page["source"] == "OCR" for page in parsed["pages"])


def test_ocr_page_budget(make_pdf: Callable[..., Path]) -> None:
    """Бюджет страниц: сканы ИД бывают на сотни листов, распознавать всё не всегда нужно."""
    engine = FakeEngine()

    parsed = parse_pdf(make_pdf(pages=3, empty=True), "sha", "test", ocr=options(engine, max_pages=2))

    assert engine.calls == 2
    assert [page["source"] for page in parsed["pages"]] == ["OCR", "OCR", "TEXT_LAYER"]


def test_ocr_budget_prefers_text_sheets_over_drawings(tmp_path: Path) -> None:
    """При нехватке бюджета сначала распознаём сканы текстовых листов, а не чертежи.

    Значения параметров лежат в таблицах и тексте — экспликациях, спецификациях, актах.
    Чертёж формата A0 стоит дороже всех и значений почти не даёт, поэтому он уходит в конец
    очереди. На стенде без GPU бюджет ограничен, и порядок решает, что вообще будет разобрано.
    """
    document = pymupdf.open()
    document.new_page(width=2384, height=1684)  # лист A0 — классифицируется как чертёж
    document.new_page(width=595, height=842)  # скан A4
    path = tmp_path / "mixed.pdf"
    document.save(path)
    document.close()
    engine = FakeEngine()

    parsed = parse_pdf(path, "sha", "test", ocr=options(engine, max_pages=1))

    assert [page["is_drawing"] for page in parsed["pages"]] == [True, False]
    assert [page["source"] for page in parsed["pages"]] == ["TEXT_LAYER", "OCR"]


def test_low_confidence_marks_page_low_quality(make_pdf: Callable[..., Path]) -> None:
    """Плохо распознанная страница остаётся LOW_QUALITY — значения с неё брать рискованно."""
    engine = FakeEngine(confidence=0.2)

    parsed = parse_pdf(make_pdf("empty.pdf", empty=True), "sha", "test", ocr=options(engine, min_confidence=0.5))

    page = parsed["pages"][0]
    assert page["quality"] == "LOW_QUALITY"
    assert page["blocks"][0]["quality"] == "LOW_QUALITY"


def test_engine_none_disables_ocr() -> None:
    assert build_engine("none") is None


def test_ocr_failure_does_not_break_parsing(make_pdf: Callable[..., Path]) -> None:
    """Если движок падает, страница просто остаётся без текста, а разбор продолжается."""

    class BrokenEngine:
        name = "broken"

        def recognize(self, image: np.ndarray) -> list[OcrLine]:
            raise RuntimeError("модель не загрузилась")

    parsed = parse_pdf(make_pdf("empty.pdf", empty=True), "sha", "test", ocr=options(BrokenEngine()))

    page = parsed["pages"][0]
    assert page["source"] == "TEXT_LAYER"
    assert page["blocks"] == []


@pytest.mark.parametrize("name", ["paddle", "tesseract"])
def test_build_engine_returns_none_or_engine(name: str) -> None:
    """Без extra `ocr` движка нет, но ошибки тоже нет — конвейер работает без OCR."""
    engine = build_engine(name)

    assert engine is None or hasattr(engine, "recognize")


class TestEngineIsReused:
    """Модель OCR грузится десяток секунд — держим её столько же, сколько живёт процесс.

    Проверяем сам факт переиспользования, а не конкретный движок: без extra `ocr`
    в окружении может не быть ни одного, и тогда `build_engine` честно вернёт `None`.
    """

    def test_second_call_does_not_build_again(self) -> None:
        build_engine("none", paddle_det_model=None, device="cpu")
        build_engine("none", paddle_det_model=None, device="cpu")

        assert build_engine.cache_info().hits >= 1

    def test_other_settings_are_built_separately(self) -> None:
        build_engine("none", paddle_det_model=None, device="cpu")
        build_engine("none", paddle_det_model=None, device="gpu")

        assert build_engine.cache_info().misses >= 2

    def test_cache_clear_forgets_everything(self) -> None:
        build_engine("none")
        build_engine.cache_clear()

        assert build_engine.cache_info().hits == 0

    def test_installed_engine_is_the_same_object(self) -> None:
        name = next(iter(available_engines()), None)
        if name is None:
            pytest.skip("ни одного движка OCR не установлено")

        assert build_engine(name) is build_engine(name)


class TestDeviceIsNotSubstitutedSilently:
    """На проверяющем стенде нормативы меряют в GPU-конфигурации.

    Запасные наборы параметров в `PaddleEngine._build` намеренно выбрасывают `device` — без
    этого старые сборки PaddleOCR не поднимались. Но при `OCR_DEVICE=gpu` первая же неудача
    уводила распознавание на процессор молча, записью уровня `debug`. Страница на процессоре
    стоит около минуты против секунды на карте.
    """

    def test_explicit_gpu_on_cpu_is_an_error(self) -> None:
        with pytest.raises(RuntimeError, match="OCR_DEVICE=gpu"):
            ensure_device("gpu", "cpu")

    def test_explicit_gpu_on_gpu_passes(self) -> None:
        ensure_device("gpu", "gpu:0")

    def test_auto_may_land_anywhere(self) -> None:
        """При `auto` выбор за движком: подмена осознанна, её достаточно записать в лог."""
        ensure_device("auto", "cpu")
        ensure_device("auto", "gpu:0")

    def test_explicit_cpu_is_not_checked(self) -> None:
        ensure_device("cpu", "cpu")

    def test_device_is_taken_from_the_pipeline_not_from_paddle(self) -> None:
        """Устройство спрашиваем у конвейера PaddleOCR.

        `paddle.get_device()` в сборке с `paddlepaddle-gpu` отвечает «gpu:0» всегда — и тогда,
        когда PaddleOCR создан с `device="cpu"` и считает на процессоре. На этом 22.09 стенд
        писал в лог «gpu:0», распознавая страницу 34 секунды вместо двух.
        """

        class Pipeline:
            device = "cpu"

        class Model:
            paddlex_pipeline = Pipeline()

        assert current_device(Model()) == "cpu"

    def test_device_falls_back_to_paddle_when_the_pipeline_is_silent(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """У других версий PaddleOCR этого поля нет — тогда спрашиваем paddle, как раньше."""
        fake = types.SimpleNamespace(get_device=lambda: "gpu:0")
        monkeypatch.setitem(sys.modules, "paddle", fake)

        assert current_device(object()) == "gpu:0"

class TableEngine:
    """Движок, «узнающий» на скане акта таблицу: три строки, две колонки.

    Детектор PP-OCRv5 внутри таблицы режет по ячейкам, поэтому каждая ячейка приходит своей
    строкой — фейк повторяет это поведение.
    """

    name = "fake-table"
    ROWS = (
        ("Наименование конструкции", "Класс бетона"),
        ("Стена в грунте", "B25"),
        ("Фундаментная плита", "B40"),
    )

    def recognize(self, image: np.ndarray) -> list[OcrLine]:
        height, width = image.shape[:2]
        lines: list[OcrLine] = []
        for index, (left, right) in enumerate(self.ROWS):
            top = height * (0.10 + 0.08 * index)
            bottom = top + height * 0.05
            lines.append(OcrLine(text=left, bbox=(width * 0.05, top, width * 0.45, bottom), confidence=0.95))
            lines.append(OcrLine(text=right, bbox=(width * 0.55, top, width * 0.80, bottom), confidence=0.95))
        return lines


class TestTablesAfterOcr:
    """Распознанная страница отдавала текст и ни одной таблицы.

    У страницы без текстового слоя `chars == 0`, поэтому таблицы при первом проходе не
    собирались, а после подстановки блоков OCR разбор второй раз не запускался. ИД у нас
    в основном сканы, а значения живут в таблицах — акты, журналы, спецификации.
    """

    def parsed(self, make_pdf: Callable[..., Path]) -> dict:
        path = make_pdf("акт.pdf", empty=True, width=420, height=595)
        return parse_pdf(path, "0" * 64, "test-1", ocr=options(TableEngine()))

    def test_table_is_rebuilt(self, make_pdf: Callable[..., Path]) -> None:
        page = self.parsed(make_pdf)["pages"][0]

        assert page["source"] == "OCR"
        assert page["tables"], "после OCR таблица должна собираться заново"

    def test_cells_keep_their_text_and_place(self, make_pdf: Callable[..., Path]) -> None:
        page = self.parsed(make_pdf)["pages"][0]
        texts = [cell["text"] for table in page["tables"] for cell in table["cells"]]

        assert "Стена в грунте" in texts
        assert "B25" in texts

    def test_value_is_extracted_from_the_scanned_act(self, make_pdf: Callable[..., Path]) -> None:
        """То, ради чего всё это: на скане акта с таблицей значение параметра находится."""
        from inspector_ml import matrix
        from inspector_ml.extract import concrete

        param = matrix.param("M-055")
        if param is None:  # pragma: no cover — матрица лежит в репозитории рядом
            pytest.skip("нет матрицы")

        found = concrete.extract(param, self.parsed(make_pdf)["pages"])

        assert {f.value for f in found} == {"B25", "B40"}
        assert any("стен" in (f.rule_key or "").lower() for f in found)

    def test_a_page_without_a_table_stays_without_one(self, make_pdf: Callable[..., Path]) -> None:
        """Одна распознанная строка — не таблица: иначе разлиновка чертежа лезла бы в данные."""
        path = make_pdf("скан.pdf", empty=True, width=420, height=595)

        page = parse_pdf(path, "0" * 64, "test-1", ocr=options(FakeEngine()))["pages"][0]

        assert page["source"] == "OCR"
        assert page["tables"] == []
