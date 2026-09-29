"""M-058 «Толщина монолитной фундаментной плиты / ростверка».

Строки взяты из документов обучающей части (Новослободская, «Пример нарушений на чертежах») —
в том числе со страниц эталона организаторов KR-058: ПД КР2 стр. 53 («1000/1200 мм») и РД
КЖ1.1.1 стр. 3 и 7 («1200/1500 мм»). Ловушки — оттуда же: на тех же страницах рядом стоит
толщина подготовки, приямка и безымянной «плиты», и любая из них дала бы ложное уменьшение.
"""

from __future__ import annotations

import pytest

from inspector_ml import matrix
from inspector_ml.contracts.events import MatrixParam
from inspector_ml.extract import foundation
from inspector_ml.extract.api import extractor_for


@pytest.fixture
def m058() -> MatrixParam:
    param = matrix.param("M-058")
    if param is None:  # pragma: no cover — матрица лежит в репозитории рядом
        pytest.skip(f"нет {matrix.params_path()}")
    return param


def page(*texts: str, number: int = 1, kind: str = "text") -> dict:
    blocks = [
        {"id": f"b{i}", "type": kind, "text": t, "bbox": [0, 0.1 * i, 1, 0.1 * i + 0.05]} for i, t in enumerate(texts)
    ]
    return {"page": number, "blocks": blocks}


def thickness_in(m058: MatrixParam, *pages: dict) -> dict[str | None, tuple[float, str]]:
    return {f.rule_key: (f.value, f.raw_value) for f in foundation.extract(m058, list(pages))}


def thickness(m058: MatrixParam, *texts: str) -> dict[str | None, tuple[float, str]]:
    return thickness_in(m058, page(*texts))


class TestHowThicknessIsWritten:
    def test_thickness_then_element(self, m058: MatrixParam) -> None:
        """ПД КР2 стр. 53 (эталон KR-058): зоны разной толщины — берём самую тонкую."""
        found = thickness(m058, "Толщина фундаментной плиты определена по расчету, составляет 1000мм и 1200мм.")

        assert found == {"Фундаментная плита": (1000.0, "1000мм и 1200мм")}

    def test_list_of_elements(self, m058: MatrixParam) -> None:
        """Перечень толщин: у плиты своё значение, у перекрытий и капителей — свои, не наши."""
        found = thickness(
            m058,
            "- Толщина фундаментной плиты -1000, 1200мм - Перекрытия -2 и -1 этажей - 250мм"
            " - Капители -2 и -1 этажей - 500мм",
        )

        assert found == {"Фундаментная плита": (1000.0, "1000, 1200мм")}

    def test_foundation_in_the_form_of_a_slab(self, m058: MatrixParam) -> None:
        """РД КЖ1.1.1 стр. 3 (эталон KR-058): «фундаментной» рядом с «плитой» нет."""
        found = thickness(
            m058,
            "4. Фундамент жилого дома предусмотрен в виде монолитной железобетонной плиты толщиной"
            " 1200 и 1500 мм с отметкой низа -14.950",
        )

        assert found == {"Фундаментная плита": (1200.0, "1200 и 1500 мм")}

    def test_drawing_dimension(self, m058: MatrixParam) -> None:
        """РД КЖ1.1.1 стр. 7 (эталон KR-058): размер на разрезе."""
        assert thickness(m058, "Железобетонная фундаментная плита h=1200 мм") == {
            "Фундаментная плита": (1200.0, "1200 мм")
        }

    def test_abbreviation_is_not_the_end_of_a_sentence(self, m058: MatrixParam) -> None:
        """«ж/б.» — сокращение, а не точка: иначе «Фундаменты … плита» разорвалось бы."""
        found = thickness(
            m058, "Фундаменты основной части здания – монолитная ж/б. плита толщиной 600мм из бетона В30 W10 F300"
        )

        assert found == {"Фундаментная плита": (600.0, "600мм")}

    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("Толщина ростверка 800 мм", 800.0),
            ("устройство монолитного ростверка толщиной 600 мм", 600.0),
            ("Ростверк Рм-1, h=900 мм", 900.0),
        ],
    )
    def test_grillage(self, m058: MatrixParam, text: str, expected: float) -> None:
        found = thickness(m058, text)

        assert list(found) == ["Ростверк"]
        assert found["Ростверк"][0] == expected

    def test_slab_and_grillage_are_separate_points(self, m058: MatrixParam) -> None:
        found = thickness(m058, "Фундаментная плита толщиной 1000 мм, ростверк толщиной 800 мм")

        assert found == {"Фундаментная плита": (1000.0, "1000 мм"), "Ростверк": (800.0, "800 мм")}


class TestTraps:
    """Толщина рядом с плитой, но не плиты. Любая из них — ложное «уменьшение толщины»."""

    @pytest.mark.parametrize(
        "text",
        [
            # РД КЖ1.1.1 стр. 3: ближайшая конструкция перед толщиной — подготовка
            "Под телом фундаментной плиты выполнена бетонная подготовка из бетона В10 толщиной 100 мм.",
            # РД 2451.Р.ДР: плита приямка — другой элемент
            "Фундаментная плита приямка, h=900 мм",
            # РД КЖ1.1.1 стр. 6: какой плиты — из строки не видно
            "H плиты 400мм",
            # ПД КР2 стр. 53: не фундамент
            "В корпусах К1 и К2 предусмотрены переходные плиты в уровне 1 этажа толщиной 800 мм, 900 мм",
            # РД КЖ1.1.1 стр. 7: «толщину» без числа, дальше новая фраза с чужим числом
            "Бетонирование вести слоем на всю толщину фундаментной плиты. Захватки не более 1500 мм",
            # толщина относится к стенам, плита названа в той же фразе
            "Толщина стен подвала и фундаментной плиты 600 мм",
            # утеплитель под плитой
            "Толщина утеплителя под фундаментной плитой 100 мм",
            # тротуарная плитка — не плита
            "Фундамент ограждения, тротуарная плитка толщиной 600 мм",
        ],
    )
    def test_not_a_slab_thickness(self, m058: MatrixParam, text: str) -> None:
        assert thickness(m058, text) == {}

    def test_slab_thickness_before_the_layer_under_it(self, m058: MatrixParam) -> None:
        """«Пример нарушений», Том 4.1.1: 600 — плита, 100 — подготовка под ней."""
        found = thickness(
            m058,
            "Фундаменты основного здания – монолитная ж/б плита толщиной 600мм по бетонной подготовке"
            " толщиной 100мм на естественном основании",
        )

        assert found == {"Фундаментная плита": (600.0, "600мм")}

    @pytest.mark.parametrize("text", ["Толщина фундаментной плиты 50 мм", "Толщина фундаментной плиты 9000 мм"])
    def test_implausible_thickness(self, m058: MatrixParam, text: str) -> None:
        assert thickness(m058, text) == {}

    def test_paragraph_taken_for_a_title_block_is_read(self, m058: MatrixParam) -> None:
        """«Пример нарушений», Том 5.3.4, стр. 8: абзац внизу листа разметка приняла за штамп."""
        text = (
            "Относительной отметке здания ±0.000 соответствует абсолютная отметка 138.000. \n"
            "Отметки пола подземной части здания -2.100 и -2.950 м. Толщина фундаментной плиты 600 \nмм."
        )

        assert thickness_in(m058, page(text, kind="title_block")) == {"Фундаментная плита": (600.0, "600 мм")}

    def test_real_title_block_gives_nothing(self, m058: MatrixParam) -> None:
        """Настоящий штамп РД КЖ1.1.1: плита названа, толщины нет."""
        text = "Разрезы 1-1, ..., 8-8. Опалубка. Указания по возведению ж/б монолитной фундаментной плиты"

        assert thickness_in(m058, page(text, kind="title_block")) == {}


class TestOneValuePerDocument:
    def test_thinnest_zone_over_pages(self, m058: MatrixParam) -> None:
        """На разрезах РД толщины зон — отдельными подписями; значение документа — самая тонкая."""
        pages = [
            page("Железобетонная фундаментная плита h=1500 мм", number=6),
            page("Железобетонная фундаментная плита h=1200 мм", number=7),
            page("Железобетонная фундаментная плита h=1500 мм", number=8),
        ]
        found = foundation.extract(m058, pages)

        assert [(f.rule_key, f.value, f.page) for f in found] == [("Фундаментная плита", 1200.0, 7)]

    def test_evidence_of_the_value(self, m058: MatrixParam) -> None:
        (found,) = foundation.extract(m058, [page("Толщина фундаментной плиты 800 мм", number=3)])

        assert found.unit == "мм"
        assert found.method == "regex"
        assert found.bbox == [0, 0.0, 1, 0.05]
        assert "Толщина фундаментной плиты 800 мм" in found.snippet

    def test_dispatch(self) -> None:
        assert extractor_for("M-058") is foundation.extract
