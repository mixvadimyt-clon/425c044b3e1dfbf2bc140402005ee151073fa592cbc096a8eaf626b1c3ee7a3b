"""Сопоставление листов ПД ↔ РД и наименование листа из штампа."""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from inspector_ml.cv.fingerprint import weights
from inspector_ml.cv.pairing import Sheet, informative, page_pairs, pair_key, score
from inspector_ml.layout.title_block import sheet_title


def block(text: str, bbox: list[float], kind: str = "title_block") -> dict[str, Any]:
    return {"id": "b", "type": kind, "text": text, "bbox": bbox}


def sheet(
    page: int,
    title: str,
    *,
    stage_file: str = "pd",
    number: str | None = None,
    text: str = "",
    marks: set[str] | None = None,
    declared: set[str] | None = None,
) -> Sheet:
    return Sheet(
        file_id=stage_file,
        page=page,
        discipline="АР",
        sheet=number,
        title=title,
        text=text or title,
        marks=frozenset(marks or ()),
        declared=frozenset(declared or ()),
    )


def complect(stage_file: str, count: int = 12) -> list[Sheet]:
    """Остальные листы комплекта: по ним считается редкость отметок.

    Без них отметка, встреченная дважды, редкой не выглядит — редкость меряется по комплекту,
    а в комплекте из двух листов любая отметка обычная.
    """
    return [
        sheet(200 + n, f"узел {n} крепления навесной панели", stage_file=stage_file, marks={f"+{n}.100", f"+{n}.200"})
        for n in range(count)
    ]


class TestSheetTitle:
    def test_takes_the_sheet_name_from_the_stamp(self) -> None:
        page = {
            "blocks": [
                block("Изм. Кол.уч. Лист №док. Подп. Дата", [0.80, 0.93, 0.92, 0.95]),
                block("«Жилой дом с подземной автостоянкой», расположенный по адресу", [0.80, 0.90, 0.99, 0.92]),
                block("План -3-го этажа. Фрагмент плана на отм. -11.200", [0.80, 0.96, 0.93, 0.98]),
            ]
        }

        assert sheet_title(page) == "План -3-го этажа. Фрагмент плана на отм. -11.200"

    def test_ignores_stamp_column_labels(self) -> None:
        """Шапка граф штампа — не наименование листа: на ней сходились любые два чертежа."""
        labels = "Изм. Кол.уч. Лист №док. Подп. Дата Стадия Листов Формат А2"
        page = {"blocks": [block(labels, [0.80, 0.96, 0.99, 0.98])]}

        assert sheet_title(page) is None

    def test_ignores_the_object_name(self) -> None:
        """Название объекта одинаково на всех листах комплекта и лист не различает."""
        page = {"blocks": [block("Жилой дом, расположенный по адресу: г. Москва", [0.85, 0.96, 0.99, 0.98])]}

        assert sheet_title(page) is None

    def test_ignores_blocks_outside_the_stamp(self) -> None:
        page = {"blocks": [block("Схема расположения свай", [0.1, 0.2, 0.4, 0.3])]}

        assert sheet_title(page) is None


class TestScore:
    def test_same_sheet_number_adds_to_the_score(self) -> None:
        """Номера листов совпали — это довод за пару. Наименования берём разные: у одинаковых
        оценка и так упирается в потолок, и прибавки не видно."""
        one = sheet(1, "план 3 этажа на отметке 10.200", number="12")
        with_number = score(one, sheet(1, "план 7 этажа на отметке 24.400", stage_file="rd", number="Лист 12"))
        without = score(one, sheet(1, "план 7 этажа на отметке 24.400", stage_file="rd", number="7"))

        assert with_number > without

    def test_short_subset_does_not_score_as_a_full_match(self) -> None:
        """`token_set_ratio` давал таким парам 100 %: одна цифра со скана «совпадала» с чем угодно."""
        assert score(sheet(1, "4"), sheet(1, "план 4 этажа на отметке 12.500", stage_file="rd")) < 0.5


class TestMarks:
    """Отметки уровня — единственный признак, переживающий переход от ПД к РД."""

    def test_pairs_sheets_whose_stamps_say_nothing_alike(self) -> None:
        """Ровно тот случай, ради которого всё это: в графе 4 ПД написано, что изображено,
        в РД — раздел и номер листа. По тексту такая пара не находится никогда."""
        floor = {"+40.375", "+42.150"}
        left = [sheet(54, "коржова маслова суханова план 11 этажа", marks=floor), *complect("pd")]
        right = [
            sheet(10, "архитектурные решения надземной части планы р 16", stage_file="rd", marks=floor),
            *complect("rd"),
        ]

        pairs = page_pairs(left, right)

        assert (54, 10) in [(p["left"]["page"], p["right"]["page"]) for p in pairs]

    def test_a_stamp_naming_another_floor_blocks_the_pair(self) -> None:
        """Наименования совпадают дословно — и пары всё равно нет: в графе 4 сказано «на отм.
        +13.750», а у второго листа отметки совсем другие. Изображено там другое место."""
        left = [sheet(4, "план 4 этажа на отметке 13.750", marks={"+13.750", "+27.950"}, declared={"+13.750"})]
        right = [sheet(4, "план 4 этажа на отметке 13.750", stage_file="rd", marks={"-5.400", "-8.900"})]

        assert page_pairs(left, right) == []

    def test_the_same_floor_is_not_blocked(self) -> None:
        """Обратный случай к предыдущему: отметка из графы 4 у кандидата есть."""
        left = [sheet(4, "план 4 этажа на отметке 13.750", marks={"+13.750", "+27.950"}, declared={"+13.750"})]
        right = [sheet(9, "план 4 этажа на отметке 13.750", stage_file="rd", marks={"+13.750", "+2.700"})]

        assert [(p["left"]["page"], p["right"]["page"]) for p in page_pairs(left, right)] == [(4, 9)]

    def test_a_named_floor_raises_the_score(self) -> None:
        """В ПД на листе два типовых этажа, в РД у каждого свой лист: наборы отметок целиком
        не совпадают, и довод за пару — отметка, названная в графе 4."""
        # «+13.750» встречается в комплекте один раз из двадцати — отметка редкая и весит много.
        weight = weights([frozenset({"+13.750"})] + [frozenset({f"+{n}.500"}) for n in range(1, 20)])
        named = sheet(
            4,
            "план 4, 8 этажей на отметке 13.750 27.950",
            marks={"+13.750", "+27.950", "+3.300", "+6.600"},
            declared={"+13.750"},
        )
        other = sheet(7, "архитектурные решения планы р 16", stage_file="rd", marks={"+13.750", "+1.500"})

        assert score(named, other, weight) > score(replace(named, declared=frozenset()), other, weight)

    def test_a_scan_without_marks_is_not_contradicted(self) -> None:
        """У скана отметки часто не распознаются. Молчание — не возражение."""
        left = sheet(4, "план 4 этажа на отметке 13.750", declared={"+13.750"})
        right = sheet(4, "план 4 этажа на отметке 13.750", stage_file="rd")

        assert score(left, right) > 0.5


class TestInformative:
    def test_drops_titles_repeated_across_the_stage(self) -> None:
        """Адрес объекта в графе 4 повторяется на каждом листе — это реквизит, а не имя листа."""
        address = "нагатинский затон улица речников участок 7/7"
        sheets = [sheet(n, address) for n in range(1, 9)] + [sheet(9, "план 3 этажа на отметке 10.200")]

        left = informative(sheets)

        assert [s.page for s in left] == [9]

    def test_drops_sheets_without_a_discipline(self) -> None:
        unknown = Sheet(file_id="pd", page=1, discipline=None, sheet=None, title="план 3 этажа", text="")

        assert informative([unknown]) == []


class TestPagePairs:
    def test_matches_sheets_with_the_same_name(self) -> None:
        left = [sheet(1, "план 3 этажа на отметке 10.200"), sheet(2, "фасад в осях 1-7 корпус 1")]
        right = [
            Sheet("rd", 5, "АС", None, "фасад в осях 1-7 корпус 1", ""),
            Sheet("rd", 4, "АС", None, "план 3 этажа на отметке 10.200", ""),
        ]

        pairs = page_pairs(left, right)

        assert [(p["left"]["page"], p["right"]["page"]) for p in pairs] == [(1, 4), (2, 5)]
        assert all(p["homography"] is None and p["diff_regions"] == [] for p in pairs)

    def test_one_sheet_takes_only_one_pair(self) -> None:
        """Лист не может быть парой сразу к двум: инспектор сравнивает два листа, а не три."""
        left = [sheet(1, "план 3 этажа на отметке 10.200")]
        right = [
            Sheet("rd", 4, "АР", None, "план 3 этажа на отметке 10.200", ""),
            Sheet("rd", 5, "АР", None, "план 3 этажа на отметке 10.200", ""),
        ]

        assert len(page_pairs(left, right)) == 1

    def test_different_disciplines_are_not_paired(self) -> None:
        left = [sheet(1, "план 3 этажа на отметке 10.200")]
        right = [Sheet("rd", 4, "ОВ", None, "план 3 этажа на отметке 10.200", "")]

        assert page_pairs(left, right) == []

    def test_pd_and_rd_disciplines_are_matched_by_meaning(self) -> None:
        """В ПД раздел КР, в РД тот же раздел называется КЖ."""
        left = [Sheet("pd", 1, "КР", None, "схема армирования плиты на отметке 10.200", "")]
        right = [Sheet("rd", 4, "КЖ", None, "схема армирования плиты на отметке 10.200", "")]

        assert len(page_pairs(left, right)) == 1

    def test_pair_key_is_stable(self) -> None:
        one, two = sheet(1, "план"), Sheet("rd", 4, "АР", None, "план", "")

        assert pair_key(one, two) == pair_key(one, two)
        assert pair_key(one, two) != pair_key(two, one)
