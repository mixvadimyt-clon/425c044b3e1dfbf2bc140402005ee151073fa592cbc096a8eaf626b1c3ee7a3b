"""Страница с нечитаемым текстовым слоем уходит в распознавание, а не притворяется годной.

Встречается шрифт без дескриптора и без годного ToUnicode: PyMuPDF честно отдаёт текст, но
кириллица в нём превращается в кашу. Опасно это тем, что символы на странице есть, значит
классификатор считает её пригодной, OCR не запускается, а извлечение работает по мусору —
и молчит. На корпусе это 515 страниц из 17 344 с текстовым слоем.
"""

from __future__ import annotations

import pytest

from conftest import cyrillic_font
from inspector_ml.quality.page_classifier import READABLE_MIN_LETTERS, readable_text

# Настоящие строки из корпуса: «Общество с ограниченной ответственностью «БратКом-групп»»
# и «Сроки строительства не подлежат корректировке».
BROKEN = (
    "Ɉ5M5EF6> E >7D4=<G5==>= >F65FEF65==>EFLN «ȻD4FɄ><-7DG??» ND.44D5E: $>EE<O, 115230, "
    "Ɇ>E>64 7., 6=.F5D.7. <G=<F<?4?L=O= >>DG7 ɇ474F<=>-%44>6=<>< ?D>574 %?55>746>4E><=, "
    "4>< 7, EFD.9. -3 ɉX Ʉ25 Ɉ63 ɂɇɇ 7726445683 / Ʉɉɉ 772401001"
)
BROKEN_2 = "ɋɪɨɤɢ ɫɬɪɨɢɬɟɥɶɫɬɜɚ ɧɟ ɩɨɞɥɟɠɚɬ ɤɨɪɪɟɤɬɢɪɨɜɤɟ Ɍɪɟɛɨɜɚɧɢɹ ɤ ɨɫɧɚɳɟɧɢɸ ɡɞɚɧɢɹ ɩɪɢɛɨɪɚɦɢ"
#: Проверка идёт по странице целиком, а не по отдельному блоку: так её и вызывает разбор.
#: В каждом куске по отдельности букв меньше порога, и это правильно — по обрывку не судим.
BROKEN_PAGE = BROKEN + " " + BROKEN_2
GOOD = (
    "Общество с ограниченной ответственностью «БратКом-групп», юридический адрес: Россия, "
    "115230, Москва, внутригородская территория муниципальный округ Нагатино-Садовники, "
    "проезд Хлебозаводский, дом 7, строение 9. ИНН 7726445683 / КПП 772401001"
)
ENGLISH = (
    "General notes: all dimensions are given in millimetres unless otherwise stated. "
    "Refer to the drawing set for further details and coordination with other disciplines."
)


class TestUnreadableTextIsCaught:
    def test_mojibake_is_not_readable(self) -> None:
        assert readable_text(BROKEN_PAGE) is False

    def test_a_single_block_is_too_little_to_judge(self) -> None:
        """В обрывке букв меньше порога — по нему не судим, даже если он явно сломан."""
        assert readable_text(BROKEN) is True
        assert readable_text(BROKEN_2) is True

    def test_normal_russian_passes(self) -> None:
        assert readable_text(GOOD) is True

    def test_english_page_passes(self) -> None:
        """Лист с латинскими обозначениями — честный лист, а не поломка шрифта."""
        assert readable_text(ENGLISH) is True

    def test_mixed_page_passes(self) -> None:
        assert readable_text(GOOD + " " + ENGLISH) is True


class TestShortTextIsNotJudged:
    """На подписи к чертежу доля букв ничего не значит — гадать нельзя."""

    def test_short_mojibake_is_left_alone(self) -> None:
        assert readable_text("Ɉ5M5EF6>") is True

    @pytest.mark.parametrize("size", [0, 1, READABLE_MIN_LETTERS - 1])
    def test_anything_shorter_than_the_threshold(self, size: int) -> None:
        assert readable_text("Ɉ" * size) is True

    def test_at_the_threshold_it_starts_judging(self) -> None:
        assert readable_text("Ɉ" * READABLE_MIN_LETTERS) is False


class TestParsedPageGoesToOcr:
    """Главное следствие: такая страница помечается LOW_QUALITY, и её заберёт распознавание."""

    @staticmethod
    def _pdf(tmp_path, name: str, body: str):
        import pymupdf

        font = cyrillic_font()
        if font is None:
            pytest.skip("нет системного шрифта с нужными глифами")
        path = tmp_path / name
        document = pymupdf.open()
        page = document.new_page(width=595, height=842)
        page.insert_textbox(
            pymupdf.Rect(40, 40, 555, 800), body, fontsize=9, fontfile=str(font), fontname="doc"
        )
        document.save(path)
        document.close()
        return path

    def test_unreadable_page_is_low_quality(self, tmp_path) -> None:
        from inspector_ml.ingest.pdf import parse_pdf
        from inspector_ml.storage.files import sha256_of

        path = self._pdf(tmp_path, "broken.pdf", BROKEN_PAGE)
        parsed = parse_pdf(path, sha256_of(path), "test", file_name=path.name)

        assert parsed["pages"][0]["quality"] == "LOW_QUALITY"

    def test_readable_page_stays_ok(self, tmp_path) -> None:
        from inspector_ml.ingest.pdf import parse_pdf
        from inspector_ml.storage.files import sha256_of

        path = self._pdf(tmp_path, "good.pdf", GOOD)
        parsed = parse_pdf(path, sha256_of(path), "test", file_name=path.name)

        assert parsed["pages"][0]["quality"] == "OK"
