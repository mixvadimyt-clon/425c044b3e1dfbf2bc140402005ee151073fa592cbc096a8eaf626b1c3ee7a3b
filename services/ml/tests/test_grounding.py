"""Запрет на выдумку: числа вне документа и цитаты, которых нет (ADR-0008)."""

from __future__ import annotations

from typing import ClassVar

from inspector_ml.llm import grounding
from inspector_ml.llm.client import parse_object


def page(number: int, *blocks: tuple[str, list[float]]) -> dict:
    return {
        "page": number,
        "source": "TEXT_LAYER",
        "quality": "OK",
        "blocks": [{"type": "text", "text": text, "bbox": bbox} for text, bbox in blocks],
    }


class TestNumbersOutsideTheDocument:
    """Число, которого нет ни в одном переданном фрагменте, — признак выдумки."""

    def test_number_from_the_source_passes(self) -> None:
        assert grounding.ungrounded("площадь помещения 45,2 м2", ["Помещение 1.09, площадь 45,2 м2"]) == set()

    def test_invented_number_is_caught(self) -> None:
        assert grounding.ungrounded("площадь 51,7 м2", ["Помещение 1.09, площадь 45,2 м2"]) == {"51.7"}

    def test_comma_and_point_are_the_same_number(self) -> None:
        assert grounding.ungrounded("значение 2.5", ["в проекте 2,5 кВт"]) == set()

    def test_thousands_separator_does_not_hide_the_number(self) -> None:
        assert grounding.ungrounded("1 200 мм", ["ширина 1200 мм"]) == set()

    def test_trailing_zero_is_not_dropped(self) -> None:
        """«Пом. 1.10» не должно проходить по настоящему «пом. 1.1» — иначе запрет дырявый."""
        assert grounding.ungrounded("помещение 1.10", ["помещение 1.1 отапливается"]) == {"1.10"}

    def test_several_sources_are_all_considered(self) -> None:
        assert grounding.ungrounded("1.09 и 45,2", ["помещение 1.09", "площадь 45,2"]) == set()

    def test_text_without_numbers_is_always_grounded(self) -> None:
        assert grounding.ungrounded("прибор отопления не предусмотрен", ["что угодно"]) == set()


class TestQuoteMustBeFound:
    """Цитата — это и проверка, и доказательство: без неё гипотезе не на что опереться."""

    pages: ClassVar[list[dict]] = [
        page(3, ("В помещении 1.09 предусмотрен отопительный прибор", [0.1, 0.2, 0.9, 0.25])),
        page(4, ("Ведомость отделки помещений", [0.1, 0.1, 0.5, 0.15])),
    ]

    def test_exact_quote_gives_page_and_box(self) -> None:
        found = grounding.locate("предусмотрен отопительный прибор", self.pages)

        assert found is not None
        number, bbox, snippet = found
        assert number == 3
        assert bbox == [0.1, 0.2, 0.9, 0.25]
        assert "1.09" in snippet

    def test_case_and_spacing_do_not_matter(self) -> None:
        assert grounding.locate("ПРЕДУСМОТРЕН   отопительный ПРИБОР", self.pages) is not None

    def test_invented_quote_is_not_found(self) -> None:
        assert grounding.locate("предусмотрен кондиционер настенный", self.pages) is None

    def test_too_short_quote_proves_nothing(self) -> None:
        """«прибор» найдётся где угодно, поэтому короткие цитаты не принимаем."""
        assert grounding.locate("прибор", self.pages) is None

    def test_quote_across_neighbouring_blocks_is_found(self) -> None:
        """Строка таблицы после распознавания приходит разорванной по ячейкам."""
        split = [
            page(
                7,
                ("Помещение 1.09", [0.1, 0.2, 0.3, 0.25]),
                ("радиатор стальной", [0.35, 0.2, 0.6, 0.25]),
            )
        ]

        found = grounding.locate("Помещение 1.09 радиатор стальной", split)

        assert found is not None
        assert found[1] == [0.1, 0.2, 0.6, 0.25]

    def test_block_box_wins_over_the_glued_one(self) -> None:
        """Рамка должна быть узкой: инспектор подсвечивает строку, а не полстраницы."""
        found = grounding.locate("В помещении 1.09 предусмотрен отопительный прибор", self.pages)

        assert found is not None
        assert found[1] == [0.1, 0.2, 0.9, 0.25]

    def test_ye_and_yo_are_the_same_letter(self) -> None:
        pages = [page(1, ("учёт тепловой энергии ведётся узлом учёта", [0, 0, 1, 1]))]

        assert grounding.locate("учет тепловой энергии ведется", pages) is not None


class TestAnswerIsReadEvenWhenMessy:
    """Qwen3 рассуждает вслух и любит обрамлять JSON — разбор не должен на этом ломаться."""

    def test_plain_json(self) -> None:
        assert parse_object('{"hypotheses": []}') == {"hypotheses": []}

    def test_thinking_out_loud_is_cut(self) -> None:
        answer = '<think>сравню помещения</think>\n{"hypotheses": [{"subject": "1.09"}]}'

        assert parse_object(answer) == {"hypotheses": [{"subject": "1.09"}]}

    def test_json_inside_prose(self) -> None:
        assert parse_object('Вот результат:\n```json\n{"hypotheses": []}\n```\nГотово') == {"hypotheses": []}

    def test_not_json_at_all(self) -> None:
        assert parse_object("не нашёл расхождений") is None

    def test_list_instead_of_object(self) -> None:
        assert parse_object("[1, 2, 3]") is None
