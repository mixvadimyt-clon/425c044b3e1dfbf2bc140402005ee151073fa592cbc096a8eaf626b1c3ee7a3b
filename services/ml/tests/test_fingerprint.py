"""Отпечаток листа по отметкам уровня."""

from __future__ import annotations

from inspector_ml.cv.fingerprint import elevations, shared_weight, similarity, weights


class TestElevations:
    def test_finds_marks_with_any_sign_and_separator(self) -> None:
        text = "План на отм. +13.750, низ плиты -5,400"

        assert elevations(text) == {"+13.750", "-5.400"}

    def test_ignores_numbers_without_a_sign(self) -> None:
        """Размеры на чертеже — тоже числа. Знак отличает отметку от всего остального."""
        assert elevations("проём 3750 мм, шаг 1.200 м") == frozenset()

    def test_ignores_longer_numbers(self) -> None:
        assert elevations("отсчёт +1234.5678") == frozenset()

    def test_normalises_the_unicode_minus(self) -> None:
        """В чертежах минус приходит и как U+2212, и как короткое тире."""
        assert elevations("отм. −5.400") == {"-5.400"}


class TestWeights:
    def test_a_mark_on_every_sheet_weighs_nothing(self) -> None:
        """`+0.000` стоит почти на каждом листе и не различает ничего."""
        sheets = [frozenset({"+0.000", f"+{n}.500"}) for n in range(10)]

        weight = weights(sheets)

        assert weight["+0.000"] == 0.0
        assert weight["+5.500"] > 2.0

    def test_no_sheets_give_no_weights(self) -> None:
        assert weights([]) == {}


class TestSimilarity:
    def setup_method(self) -> None:
        self.weight = weights([frozenset({"+0.000", f"+{n}.500"}) for n in range(20)])

    def test_rare_marks_in_common_mean_the_same_place(self) -> None:
        one, two = frozenset({"+3.500", "+7.500"}), frozenset({"+3.500", "+7.500"})

        assert similarity(one, two, self.weight) == 1.0

    def test_a_common_mark_alone_proves_nothing(self) -> None:
        """Обычный Жаккар дал бы здесь единицу: множества совпадают целиком."""
        one = two = frozenset({"+0.000", "+1.500"})
        weight = weights([frozenset({"+0.000", "+1.500"})] * 12)

        assert similarity(one, two, weight) == 0.0

    def test_a_single_mark_is_not_a_fingerprint(self) -> None:
        assert similarity(frozenset({"+3.500"}), frozenset({"+3.500"}), self.weight) == 0.0

    def test_shared_weight_counts_only_common_marks(self) -> None:
        one, two = frozenset({"+3.500", "+4.500"}), frozenset({"+3.500", "+9.500"})

        assert shared_weight(one, two, self.weight) == self.weight["+3.500"]
