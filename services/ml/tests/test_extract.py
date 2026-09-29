"""Извлечение M-002 и M-055: нормализация, сборка строк, экспликации, класс бетона.

Таблицы собираются из PDF, который тест рисует сам: так проверяется весь путь —
геометрия слов → строки → ячейки → значение с bbox, — и фикстуры не нужно держать в git.

Параметры берутся из **настоящей матрицы** (`data/matrix/params.csv`), а не из самодельных:
синонимы наименований и шаблоны живут там, и тест должен ломаться, если из матрицы пропадёт
якорь, на котором держится извлечение.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pymupdf
import pytest

from conftest import cyrillic_font
from inspector_ml import matrix
from inspector_ml.contracts.events import MatrixParam
from inspector_ml.extract import concrete, regex, rooms
from inspector_ml.extract.lexicon import element, same_word
from inspector_ml.extract.normalize import collapse, concrete_class, lookalike, number, only_number
from inspector_ml.extract.tables import PageCell, anchors, named_row
from inspector_ml.ingest.pdf import parse_pdf

PARSER_VERSION = "test-1"

#: Экспликация помещений: номер, наименование, площадь — и итог по этажу под таблицей.
EXPLICATION = [
    ("Экспликация помещений 1-го этажа", None, None),
    ("Номер", "Наименование", "Площадь, м²"),
    ("1.01", "Вестибюль", "84,7"),
    ("1.02", "Тамбур-шлюз", "4,9"),
    ("1.03", "Лестничная клетка ЛК3", "15,2"),
    ("1.04", "Санузел", "1,7"),
    ("Итого по этажу", None, "106,5"),
]

#: Таблица ТЭП пояснительной записки: в ПД Новослободской строка называется не «Общая площадь
#: здания», а «Площадь жилого здания» — этот синоним пришёл в матрицу.
TEP = [
    ("Наименование показателя", "Ед. изм.", "Показатель"),
    ("Площадь застройки", "м2", "2 810,0"),
    ("Площадь жилого здания, в т. ч.", "м2", "17 140,2"),
    ("Строительный объём", "м3", "104 300,0"),
]

#: Левые края колонок: у ТЭП наименование длинное, поэтому колонки шире.
COLUMNS = (40, 110, 300)
TEP_COLUMNS = (40, 300, 380)


def _matrix_param(code: str) -> MatrixParam:
    param = matrix.param(code)
    if param is None:  # pragma: no cover — матрица лежит в репозитории рядом
        pytest.skip(f"нет {matrix.params_path()}")
    return param


@pytest.fixture
def m002() -> MatrixParam:
    return _matrix_param("M-002")


@pytest.fixture
def m055() -> MatrixParam:
    return _matrix_param("M-055")


def _draw(
    page: pymupdf.Page,
    font: Path,
    rows: list[tuple[str | None, str | None, str | None]],
    columns: tuple[int, int, int] = COLUMNS,
) -> None:
    """Нарисовать таблицу: три колонки с фиксированными левыми краями."""
    for index, (first, second, third) in enumerate(rows):
        y = 80 + index * 20
        for text, x in zip((first, second, third), columns, strict=True):
            if text:
                page.insert_text((x, y), text, fontsize=9, fontname="ru", fontfile=str(font))


@pytest.fixture
def explication_pdf(tmp_path: Path) -> Path:
    font = cyrillic_font()
    if font is None:  # pragma: no cover — на машине нет шрифта с кириллицей
        pytest.skip("нет системного шрифта с кириллицей")
    document = pymupdf.open()
    page = document.new_page(width=420, height=300)
    _draw(page, font, EXPLICATION)
    path = tmp_path / "ar.pdf"
    document.save(path)
    document.close()
    return path


@pytest.fixture
def tep_pdf(tmp_path: Path) -> Path:
    font = cyrillic_font()
    if font is None:  # pragma: no cover — на машине нет шрифта с кириллицей
        pytest.skip("нет системного шрифта с кириллицей")
    document = pymupdf.open()
    page = document.new_page(width=600, height=300)
    _draw(page, font, TEP, TEP_COLUMNS)
    path = tmp_path / "pz.pdf"
    document.save(path)
    document.close()
    return path


@pytest.fixture
def concrete_pdf(tmp_path: Path) -> Path:
    font = cyrillic_font()
    if font is None:  # pragma: no cover — на машине нет шрифта с кириллицей
        pytest.skip("нет системного шрифта с кириллицей")
    document = pymupdf.open()
    page = document.new_page(width=420, height=300)
    _draw(
        page,
        font,
        [
            ("Материалы конструкций", None, None),
            ("поз. 1", "фундаментная плита", "B40"),
            ("поз. 2", "пилоны, колонны, стены -3 по +1", "В60"),
            ("поз. 3", "бетонная подготовка", "B10"),
        ],
    )
    path = tmp_path / "kr.pdf"
    document.save(path)
    document.close()
    return path


def _pages(path: Path) -> list[dict]:
    return parse_pdf(path, "0" * 64, PARSER_VERSION)["pages"]


class TestNormalize:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("17 140,2", 17140.2),
            ("1030,7", 1030.7),  # первая ветка шаблона не должна откусывать «103»
            ("3 009.4", 3009.4),
            ("1225,8", 1225.8),
            ("-13,600", -13.6),
            ("нет числа", None),
        ],
    )
    def test_number(self, text: str, expected: float | None) -> None:
        assert number(text) == expected

    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("бетон класса В25 F200 W8", "B25"),  # кириллическая «В»
            ("B40,F150,W6, м3", "B40"),  # запятая сразу после марки
            ("В12,5", "B12.5"),
            ("Ø25 А500С", None),  # марка арматуры — не класс бетона
            ("B9", None),  # вне ГОСТ
            ("B 25 по ГОСТ 26633-2015", "B25"),  # пробел у заглавной — марка
            ("Бетон в25 (от руки в акте)", "B25"),  # строчная слитно — тоже марка
            # Строчная «в» с пробелом — русский предлог, а не марка. «предельной высоты зданий
            # согласно ГПЗУ в 50 м» давало B50 и делало ожидаемое значение M-055 неоднозначным.
            ("предельной высоты зданий согласно ГПЗУ в 50 м", None),
            ("Корпус 1 имеет этажность в 13 эт.", None),
            ("токоотводы не ближе, чем в 3 м от входов", None),
        ],
    )
    def test_concrete_class(self, text: str, expected: str | None) -> None:
        assert concrete_class(text) == expected

    def test_lookalike_brings_cyrillic_to_latin(self) -> None:
        assert lookalike("В25") == lookalike("B25") == "B25"

    def test_collapse_removes_nonbreaking_spaces(self) -> None:
        assert collapse("17 140,2  м²") == "17 140,2 м²"


class TestLexicon:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("Спецификация материалов на ж/б фундаментную плиту на отм. -13.750", "Фундаментная плита"),
            ("монолитной ж/б «стены в грунте» толщиной 600 мм", "Стена в грунте"),
            ("пилоны, колонны, стены +6 до +16", "Вертикальные конструкции"),
            # отрицательная отметка уточняет точку так же, как её назвал эксперт организаторов
            ("пилоны, колонны, стены -3 по +1", "Вертикальные конструкции подземной части"),
            (
                "Спецификация материалов ж/б вертикальных конструкции на отм.-13.750",
                "Вертикальные конструкции подземной части",
            ),
            ("АОСР №1А-БСС от 24.02.2026", None),  # аббревиатуры в шифрах не считаем конструкцией
            ("Ведомость расхода стали", None),
        ],
    )
    def test_element(self, text: str, expected: str | None) -> None:
        assert element(text) == expected

    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("ростверк Рм-1", "Ростверк"),
            ("устройство монолитного ростверка", "Ростверк"),
            ("бетон для ростверков", "Ростверк"),
            ("лестницы", "Лестницы"),
            ("устройство лестниц", "Лестницы"),
            ("лестничных маршей", "Лестницы"),
            ("стен подвала", "Стены подвала"),
            ("фундаментной плиты", "Фундаментная плита"),
            ("бетонной подготовки", "Бетонная подготовка"),
            ("обвязочной балки", "Обвязочная балка"),
            ("перекрытий", "Плиты перекрытия"),
        ],
    )
    def test_indirect_cases_with_zero_ending(self, text: str, expected: str) -> None:
        """В актах ИД конструкцию называют в косвенном падеже.

        «Бетонная смесь для ростверка: БСТ B20» — класс не извлекался вовсе, потому что основы
        «ростверк» и «ростверка» после отрезания двух букв расходились.
        """
        assert element(text) == expected

    @pytest.mark.parametrize(
        ("left", "right", "same"),
        [
            ("ростверк", "ростверка", True),
            ("ростверк", "ростверков", True),
            ("лестниц", "лестницы", True),
            ("маршей", "марши", True),
            ("стен", "стены", True),
            ("фундаментной", "фундаментная", True),
            # общее начало то же, но остаток не окончание — это другое слово
            ("стена", "стенд", False),
            ("плита", "плитка", False),
            # слишком короткое общее начало ничего не доказывает
            ("сваи", "свая", False),
        ],
    )
    def test_same_word(self, left: str, right: str, same: bool) -> None:
        assert same_word(left, right) is same
        assert same_word(right, left) is same


class TestRooms:
    def test_rows_and_floor_total(self, m002: MatrixParam, explication_pdf: Path) -> None:
        found = {item.rule_key: item for item in rooms.extract(m002, _pages(explication_pdf))}

        assert found["пом. 1.01"].value == pytest.approx(84.7)
        assert found["пом. 1.01"].unit == "м²"
        assert found["пом. 1.03 (назначение)"].raw_value == "Лестничная клетка ЛК3"
        assert found["Экспликация помещений 1-го этажа"].value == pytest.approx(106.5)

    def test_room_bbox_points_at_the_area_cell(self, m002: MatrixParam, explication_pdf: Path) -> None:
        area = next(item for item in rooms.extract(m002, _pages(explication_pdf)) if item.rule_key == "пом. 1.02")
        x0, y0, x1, y1 = area.bbox
        assert 0.0 <= x0 < x1 <= 1.0
        assert 0.0 <= y0 < y1 <= 1.0
        assert x0 > 0.5  # колонка площадей — правая

    def test_building_area_row_is_found_by_the_matrix_synonym(self, m002: MatrixParam, tep_pdf: Path) -> None:
        """«Площадь жилого здания» — синоним из матрицы, своего списка в коде больше нет."""
        found = {item.rule_key: item for item in rooms.extract(m002, _pages(tep_pdf))}

        assert found["Общая площадь здания"].value == pytest.approx(17140.2)
        assert found["Общая площадь здания"].raw_value == "17 140,2"  # не «2» из единицы «м2»
        assert found["Общая площадь здания"].unit == "м²"

    def test_floor_total_does_not_become_a_building_area_point(self, m002: MatrixParam, explication_pdf: Path) -> None:
        """Якоря экспликации («итого по этажу») в строку ТЭП не идут: это чужая точка."""
        found = rooms.extract(m002, _pages(explication_pdf))

        assert [item.rule_key for item in found if item.rule_key == "Общая площадь здания"] == []
        assert any(item.rule_key == "Экспликация помещений 1-го этажа" for item in found)

    def test_without_anchors_only_the_tep_row_is_lost(self, m002: MatrixParam, explication_pdf: Path) -> None:
        """Матрица без якорей: экспликации ищутся по заголовку и геометрии и работают дальше."""
        bare = m002.model_copy(update={"semantic_anchors": None})
        found = rooms.extract(bare, _pages(explication_pdf))

        assert any(item.rule_key == "пом. 1.01" for item in found)


class TestMatrixParams:
    def test_matrix_carries_the_synonyms_extraction_relies_on(self, m002: MatrixParam) -> None:
        """Проверка на случай, если синонимы пропадут из `data/matrix/overrides.csv`."""
        names = anchors(m002.semantic_anchors)

        assert "площадь жилого здания" in names
        assert "общая площадь объекта" in names

    def test_generic_path_reads_anchors_and_pattern_of_the_matrix(
        self, m002: MatrixParam, make_pdf: Callable[..., Path]
    ) -> None:
        """Общий путь по матрице: якоря приходят массивом (контракт), шаблон — строкой."""
        if cyrillic_font() is None:  # pragma: no cover — в образе inspector-ml нет шрифта с кириллицей
            pytest.skip("нет системного шрифта с кириллицей: make_pdf нарисует текст без русских букв")
        found = regex.extract(m002, _pages(make_pdf(text="Общая площадь здания 3009,4 м2")))

        assert [item.value for item in found] == [pytest.approx(3009.4)]
        assert found[0].method == "regex"
        assert found[0].rule_key is None

    def test_generic_path_finds_a_table_row_by_anchor(self, tep_pdf: Path) -> None:
        footprint = MatrixParam.model_validate(
            {
                "id": 1,
                "code": "M-001",
                "section": "ПЗ",
                "parameter_name": "Площадь застройки",
                "unit": "м²",
                "data_type": "number",
                "review_priority": "HIGH",
                "semantic_anchors": ["площадь застройки"],
                "created_at": "2026-09-20T10:00:00Z",
                "updated_at": "2026-09-20T10:00:00Z",
            }
        )
        found = regex.extract(footprint, _pages(tep_pdf))

        assert [item.value for item in found] == [pytest.approx(2810.0)]
        assert found[0].method == "table"


class TestTornFromWord:
    """Короткое значение, приклеенное к букве, — обрывок слова: «лифт|а|» не класс «А».

    Шаблон класса энергоэффективности в матрице — `\\D{0,20}([A-GА-Г]\\+{0,2})` с `(?i)`, и без
    учёта регистра кириллическое «а» из «лифта» проходило как класс «А» (M-021, M-124, замер 24.09).
    """

    def energy_class(self) -> MatrixParam:
        return _matrix_param("M-124")

    def page(self, text: str) -> list[dict]:
        return [{"page": 1, "blocks": [{"id": "b0", "type": "text", "text": text, "bbox": [0, 0, 1, 0.1]}]}]

    def test_letter_from_a_word_is_not_a_class(self) -> None:
        found = regex.extract(self.energy_class(), self.page("Класс энергетической эффективности лифта"))

        assert found == []

    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("Класс энергетической эффективности здания — A+", "A+"),
            ("класс энергетической эффективности: B", "B"),
            ("Класс энергетической эффективности здания В", "B"),  # кириллическая «В» отдельно
        ],
    )
    def test_standalone_class_is_kept(self, text: str, expected: str) -> None:
        found = regex.extract(self.energy_class(), self.page(text))

        assert [item.value for item in found] == [expected]

    @pytest.mark.parametrize(
        "text",
        [
            "сведения о классе энергетической эффективности (в случае если присвоение класса",
            "Энергопотребление и класс энергетической эффективности лифта определены в соответствии",
        ],
    )
    def test_preposition_is_not_a_class(self, text: str) -> None:
        """Строчная одиночная «в» — предлог. Все 102 значения M-021 и M-124 на замере 24.09 были такими."""
        assert regex.extract(self.energy_class(), self.page(text)) == []

    def test_numbers_glued_to_units_are_not_touched(self, m002: MatrixParam) -> None:
        """«3009,4м2» — число законно приклеено к единице, фильтр только для коротких букв."""
        found = regex.extract(m002, self.page("Общая площадь здания 3009,4м2"))

        assert [item.value for item in found] == [pytest.approx(3009.4)]


class TestConcrete:
    def test_element_from_the_same_row(self, m055: MatrixParam, concrete_pdf: Path) -> None:
        found = {item.rule_key: item for item in concrete.extract(m055, _pages(concrete_pdf))}

        assert found["Фундаментная плита"].value == "B40"
        assert found["Вертикальные конструкции подземной части"].value == "B60"
        assert found["Бетонная подготовка"].value == "B10"

    def test_cyrillic_grade_is_normalized(self, m055: MatrixParam, concrete_pdf: Path) -> None:
        found = concrete.extract(m055, _pages(concrete_pdf))
        vertical = next(i for i in found if i.rule_key == "Вертикальные конструкции подземной части")

        assert vertical.raw_value == "В60"  # как в документе
        assert vertical.value == "B60"  # как в матрице

    def test_grade_without_element_is_dropped(
        self, m055: MatrixParam, tmp_path: Path, make_pdf: Callable[..., Path]
    ) -> None:
        """Марка без названия конструкции не выдаётся: пустой ключ склеил бы разные точки."""
        path = make_pdf("plain.pdf", text="Бетон класса В25 по ГОСТ 26633-2015")

        assert concrete.extract(m055, _pages(path)) == []


class TestConcreteContext:
    """Конструкция из шапки акта ИД переносится на страницы реестра — и только в актах."""

    @staticmethod
    def page(number: int, text: str) -> dict:
        return {"page": number, "blocks": [{"id": "b0", "type": "text", "text": text, "bbox": [0, 0, 1, 0.1]}]}

    def test_act_carries_the_element_to_the_registry(self, m055: MatrixParam) -> None:
        """АОСР №1А-БСС (ИД Новослободской): конструкция на стр. 2, марка в реестре на стр. 4."""
        pages = [
            self.page(1, "АКТ освидетельствования скрытых работ № 1А-БСС «24» февраля 2026 г."),
            self.page(2, "1. К освидетельствованию предъявлены следующие работы: устройство стены в грунте"),
            self.page(4, "Документ о качестве партии БСТ В25 П4 F200 W8"),
        ]
        found = concrete.extract(m055, pages)

        assert [(f.rule_key, f.value, f.method) for f in found] == [("Стена в грунте", "B25", "context")]

    def test_bundle_of_acts(self, m055: MatrixParam) -> None:
        """Папка ИД по этажу: опись, потом акты подряд — шапка у каждого, а не на первом листе."""
        pages = [
            self.page(1, "Опись документов исполнительной документации. Папка № 13"),
            self.page(2, "Перечень актов освидетельствования скрытых работ"),
            self.page(10, "АКТ освидетельствования скрытых работ № 8-12"),
            self.page(11, "1. К освидетельствованию предъявлены следующие работы: устройство стены в грунте"),
            self.page(13, "Документ о качестве партии БСТ В25 П4 F200 W8"),
            self.page(20, "Документ о качестве партии БСТ В30 П4"),  # далеко от названной конструкции
        ]
        found = concrete.extract(m055, pages)

        assert [(f.rule_key, f.value, f.page) for f in found] == [("Стена в грунте", "B25", 13)]

    def test_volume_of_pd_does_not_carry(self, m055: MatrixParam) -> None:
        """Том ПД: конструкция упомянута на странице, но чужой марке она не хозяйка (замер 25.09)."""
        pages = [
            self.page(1, "Работы выполняются с составлением акта освидетельствования скрытых работ"),
            self.page(2, "Под стенами подвала выполнена гидроизоляция"),
            self.page(3, "Покрытие пола - бетон В15 с железнением"),
        ]

        assert concrete.extract(m055, pages) == []


class TestOnlyNumber:
    """Ячейка-значение — это число и, может быть, единица. Всё прочее значением не считается.

    До этого правила значением строки бралась самая правая ячейка, в которой `number` что-нибудь
    нашёл, а находил он много лишнего: «м2» → 2, «не более 30 000» → 30000, «26.03.23» → 26.03.
    В ТЭП такие ячейки стоят в одной строке с показателем, и площадь застройки превращалась
    в норматив ГПЗУ.
    """

    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("3 009,4", 3009.4),
            ("4629,70 м²", 4629.7),
            ("84,7*", 84.7),
            ("-3.1", -3.1),
            ("2", 2.0),
        ],
    )
    def test_values(self, text: str, expected: float) -> None:
        assert only_number(text) == expected

    @pytest.mark.parametrize(
        "text",
        [
            "м2",
            "кв. м",
            "не более 30 000",
            "не менее 7000",
            "26.03.23",
            "18.05.2022",
            "Экспликация помещений 1 этажа",
            "1054,9 1091,5",
            "B25",
            "",
        ],
    )
    def test_not_values(self, text: str) -> None:
        assert only_number(text) is None

    @pytest.mark.parametrize("text", ["02.22", "02.22 м2", "007", "01,5", "0012"])
    def test_leading_zero_is_not_a_value(self, text: str) -> None:
        """«02.22» на живом прогоне дало «общую площадь здания 2.22 м²» с уверенностью 0.998.

        Пришло с распознанного плана, где сотни обрывков размеров. Величину с ведущим нулём
        не пишут — так выглядят месяц с годом, индекс или номер по порядку.
        """
        assert only_number(text) is None

    @pytest.mark.parametrize(("text", "expected"), [("0,45", 0.45), ("0.45", 0.45), ("0", 0.0)])
    def test_honest_zero_survives(self, text: str, expected: float) -> None:
        """Ноль перед запятой — это обычная запись величины меньше единицы, её не трогаем."""
        assert only_number(text) == expected


class TestNamedRowPicksTheValue:
    """Строка ТЭП: единица и норматив ГПЗУ стоят рядом с показателем и раньше выигрывали."""

    def cells(self, *texts: str) -> list[PageCell]:
        return [
            PageCell(text=text, bbox=[0.1 + 0.2 * i, 0.5, 0.28 + 0.2 * i, 0.54], table_id="t1", row=1, col=i)
            for i, text in enumerate(texts)
        ]

    def test_unit_and_norm_lose_to_the_real_value(self) -> None:
        cells = self.cells("Общая площадь здания", "м2", "не более 30 000", "3 009,4")

        row = named_row(cells, ("общая площадь здания",))

        assert row is not None
        assert row[1].text == "3 009,4"

    def test_abstains_when_only_a_norm_is_there(self) -> None:
        """Раньше сюда возвращался норматив 7000 как площадь застройки объекта."""
        cells = self.cells("Площадь застройки", "м2", "не более 7000")

        assert named_row(cells, ("площадь застройки",)) is None


class TestEnumFromTableRow:
    """Табличный путь перечислимого параметра берёт ячейку перечня, а не самое правое число строки.

    На замере 24.09 у M-023 «класс конструктивной пожарной опасности» из строки таблицы вышло
    «137.90» — самое правое число, соседняя колонка.
    """

    def cells(self, *texts: str) -> list[PageCell]:
        return [
            PageCell(text=text, bbox=[0.1 + 0.2 * i, 0.5, 0.28 + 0.2 * i, 0.54], table_id="t1", row=1, col=i)
            for i, text in enumerate(texts)
        ]

    def page(self, *texts: str) -> list[dict]:
        cells = [
            {"text": text, "bbox": [0.05 + 0.2 * i, 0.5, 0.2 + 0.2 * i, 0.54], "row": 0, "col": i}
            for i, text in enumerate(texts)
        ]
        return [{"page": 1, "blocks": [], "tables": [{"id": "t1", "bbox": [0, 0.5, 1, 0.54], "cells": cells}]}]

    def fire_class(self) -> MatrixParam:
        return _matrix_param("M-023")

    def test_enum_cell_wins_over_the_rightmost_number(self) -> None:
        found = regex.extract(self.fire_class(), self.page("Класс конструктивной пожарной опасности", "С0", "137.90"))

        assert [item.value for item in found] == ["С0"]

    def test_no_enum_cell_means_no_value(self) -> None:
        """Лучше не найти, чем взять номер строки за класс."""
        found = regex.extract(self.fire_class(), self.page("Класс конструктивной пожарной опасности", "2."))

        assert found == []

    def test_string_param_does_not_take_a_number(self) -> None:
        """Замер 25.09, ПЗУ Новослободской: «Конструкция дорожной одежды» получала «+1.92»."""
        road = _matrix_param("M-032")

        assert regex.extract(road, self.page("Конструкция дорожной одежды", "+1.92")) == []

    def test_sentence_is_not_a_row_name(self, m002: MatrixParam) -> None:
        """Слова якоря внутри длинной фразы — не наименование строки таблицы."""
        text = "Проектные отметки относятся к верху планировки, поэтому учтена поправка к общей площади здания"

        assert regex.extract(m002, self.page(text, "1.92")) == []

    def test_anchor_inside_a_long_cell_is_not_a_row_name(self) -> None:
        """«Пример нарушений», Том 5.7.1: описание мебели, а не вместимость объекта (M-013)."""
        capacity = _matrix_param("M-013")
        text = "Ножки из металла, могут превращаться в ножки, поднимающие корзину на уровень руки. Вместимость от"

        assert regex.extract(capacity, self.page(text, "1")) == []

    def test_short_row_name_in_other_case_is_found(self, m002: MatrixParam) -> None:
        found = regex.extract(m002, self.page("Общей площади здания, м2", "3009,4"))

        assert [item.value for item in found] == [pytest.approx(3009.4)]
