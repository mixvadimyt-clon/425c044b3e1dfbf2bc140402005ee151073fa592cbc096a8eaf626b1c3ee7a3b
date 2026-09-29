"""Классификатор страницы: что это за лист и можно ли с него читать значения (REQ-PRS-04).

Два независимых вывода:

- **вид страницы** — `text` (текстовый документ), `scan` (растровая копия), `drawing` (чертёж);
- **качество** — `OK` (текстовый слой пригоден для извлечения), `LOW_QUALITY` (текста мало или нет,
  нужен OCR), `ABSTAIN` (читать нечего: пустая страница).

Порог подобран по разметке организаторов: в `page_index.jsonl` у каждой страницы есть поле
`needs_ocr`. На выборке из 60 файлов обучающей части (3472 страницы, из них 996 с `needs_ocr`)
правило «символов меньше 10» совпало с разметкой **на всех страницах** — ни одного пропуска
и ни одного ложного срабатывания; при пороге 20 точность падает до 0.982.
Проверка воспроизводится командой `inspector-ml dataset calibrate <корень dataset>`.

Важно: `OK` здесь означает «текст со страницы читается», а не «значение точно найдётся».
Насколько текста хватает для извлечения конкретного параметра — вопрос уверенности извлечения.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

PageKind = Literal["text", "scan", "drawing"]
PageQuality = Literal["OK", "LOW_QUALITY", "ABSTAIN"]

# Меньше этого числа символов — читаемого текста на странице нет, нужен OCR.
TEXT_MIN_CHARS = 10
# Растр закрывает столько площади листа — перед нами скан, а не вёрстка.
SCAN_IMAGE_RATIO = 0.6
# Лист крупнее A3 почти всегда чертёж.
LARGE_SHEET_PT = 1000.0
# Тяжёлый поток команд рисования — признак векторного чертежа.
DRAWING_CONTENT_BYTES = 200_000
# Ниже этого порога страница считается пустой.
EMPTY_CONTENT_BYTES = 1_000
EMPTY_IMAGE_RATIO = 0.05


@dataclass(frozen=True)
class PageSignals:
    """Дешёвые признаки страницы: считаются при разборе, без рендера."""

    chars: int
    blocks: int
    width_pt: float
    height_pt: float
    image_area_ratio: float
    content_bytes: int

    @property
    def is_large_sheet(self) -> bool:
        return max(self.width_pt, self.height_pt) > LARGE_SHEET_PT


def page_kind(signals: PageSignals) -> PageKind:
    """Вид страницы. Скан проверяем первым: скан чертежа — всё-таки скан."""
    if signals.image_area_ratio >= SCAN_IMAGE_RATIO and signals.chars < TEXT_MIN_CHARS:
        return "scan"
    if signals.is_large_sheet or signals.content_bytes > DRAWING_CONTENT_BYTES:
        return "drawing"
    return "text"


def page_quality(signals: PageSignals) -> PageQuality:
    """Пригодность текстового слоя для извлечения значений."""
    if (
        signals.chars == 0
        and signals.image_area_ratio < EMPTY_IMAGE_RATIO
        and signals.content_bytes < EMPTY_CONTENT_BYTES
    ):
        return "ABSTAIN"
    return "OK" if signals.chars >= TEXT_MIN_CHARS else "LOW_QUALITY"


#: Кириллица, любая буква и «экзотика» — латиница-расширенная-B и МФА.
_CYRILLIC = re.compile(r"[А-Яа-яЁё]")
_LETTER = re.compile(r"[^\W\d_]", re.UNICODE)
_EXOTIC = re.compile("[ƀ-ɏɐ-ʯ]")

#: Ниже этого числа букв доля ничего не значит: на подписи к чертежу гадать нельзя.
READABLE_MIN_LETTERS = 80
#: Русский документ, где кириллицы меньше половины букв, — подозрителен.
READABLE_MIN_CYRILLIC = 0.5


def readable_text(text: str) -> bool:
    """Читается ли текстовый слой страницы, или шрифт раскодирован в мусор.

    Встречается шрифт без дескриптора и без годного ToUnicode: PyMuPDF честно отдаёт текст,
    но кириллица в нём превращается в кашу — «Общество с ограниченной ответственностью»
    приходит как «Ɉ5M5EF6> E >7D4=<G5==>= >F65FEF65==>EFLN». На корпусе это 515 страниц
    из 17 344 с текстовым слоем, и опаснее всего они тем, что выглядят нормальными:
    символы есть, значит распознавание не запускается, а извлечение работает по мусору.

    Признак — буквы из латиницы-расширенной и МФА (`Ɉ`, `Ȼ`, `ɟ`, `ɪ`), которых в наших
    документах не бывает, вместе с низкой долей кириллицы. Оба условия обязательны:
    по одной «экзотике» сработала бы страница с формулой, по одной доле — честный лист
    с латинскими обозначениями.

    **Что этот признак не ловит:** текст, раскодированный целиком в латиницу и цифры,
    без «экзотики». Ошибаемся в сторону «читается» намеренно: лишний OCR стоит минуту
    на страницу, а ложное `LOW_QUALITY` на нормальном листе выбросило бы годный текст.
    """
    letters = _LETTER.findall(text)
    if len(letters) < READABLE_MIN_LETTERS:
        return True
    if not _EXOTIC.search(text):
        return True
    return len(_CYRILLIC.findall(text)) / len(letters) >= READABLE_MIN_CYRILLIC


def needs_ocr(quality: PageQuality) -> bool:
    """Страницу заберёт OCR. У `ABSTAIN` читать нечего, OCR не поможет."""
    return quality == "LOW_QUALITY"


def classify(signals: PageSignals) -> tuple[PageKind, PageQuality]:
    return page_kind(signals), page_quality(signals)
