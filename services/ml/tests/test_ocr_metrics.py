"""Метрики OCR (§14): сопоставление строк и текст страницы по рядам — без движка распознавания."""

from __future__ import annotations

from inspector_ml.eval.ocr_metrics import in_rows, match_lines


class TestMatchLines:
    def test_exact_lines_have_no_errors(self) -> None:
        assert match_lines(["бетон b25", "арматура a500c"], ["арматура a500c", "бетон b25"]) == (0, 23)

    def test_short_line_does_not_steal_a_longer_one(self) -> None:
        """Единица «м», прочитанная латиницей, не забирает строку, которая с неё начинается.

        По очереди и по `WRatio` «м» уводила «мягкая защита стен» (вхождение подстроки — 90 баллов),
        и сама строка оставалась без пары: 35 ошибок вместо одной.
        """
        reference = ["м", "мягкая защита стен"]
        hypothesis = ["мягкая защита стен", "m"]

        assert match_lines(reference, hypothesis) == (1, 19)

    def test_duplicates_are_not_rewarded(self) -> None:
        """Лишняя копия строки не уменьшает ошибок: пара у строки эталона одна."""
        reference = ["общество с ограниченной ответственностью"]
        once = match_lines(reference, ["общество с ограниченной ответственностью"])
        twice = match_lines(reference, ["общество с ограниченной ответственностью"] * 2)

        assert once == twice == (0, 40)

    def test_line_without_pair_counts_as_missing(self) -> None:
        assert match_lines(["лист 4", "стадия р"], ["лист 4"]) == (8, 14)

    def test_empty_recognition(self) -> None:
        assert match_lines(["лист 4"], []) == (6, 6)


class TestRows:
    def test_pieces_of_one_line_are_read_left_to_right(self) -> None:
        """Верх правого куска чуть выше — строка всё равно читается слева направо."""
        pieces = [
            ("с ограниченной", (0.40, 0.099, 0.60, 0.120)),
            ("общество", (0.10, 0.100, 0.35, 0.121)),
            ("лист 4", (0.10, 0.200, 0.20, 0.221)),
        ]

        assert in_rows(pieces) == "общество с ограниченной лист 4"

    def test_split_lines_read_like_whole(self) -> None:
        """Нарезка строки на куски не меняет текст страницы."""
        whole = [("бетон b25 w6 f150", (0.1, 0.1, 0.5, 0.12))]
        split = [("бетон b25", (0.1, 0.1, 0.3, 0.12)), ("w6 f150", (0.31, 0.1, 0.5, 0.12))]

        assert in_rows(whole) == in_rows(split)

    def test_rows_go_top_down(self) -> None:
        lines = [("низ", (0.1, 0.9, 0.2, 0.92)), ("верх", (0.5, 0.1, 0.6, 0.12))]

        assert in_rows(lines) == "верх низ"
