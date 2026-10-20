"""Запрет на выдумку: ответ модели проверяется по переданным ей фрагментам.

Это главное требование приёмки свободного поиска языковой моделью, и оно держится на коде, а не на доверии к модели
([ADR-0008](../../../../docs/adr/0008-llm-scope.md)). Модель, которая уверенно называет
несуществующую площадь, для надзорного документа хуже, чем молчание.

Две проверки, обе обязательные:

1. **Цитата должна находиться в документе.** Не нашли — гипотезы нет. Побочная польза:
   найденная цитата даёт страницу и рамку, то есть доказательство, на которое инспектор
   нажмёт в интерфейсе. Ровно так же устроено извлечение значений (`extract/`): без bbox
   результат отбрасывается.
2. **Каждое число из ответа должно встречаться в переданных фрагментах.** Число — самое опасное,
   что модель может придумать: «площадь 45,2 м²», которой нет ни в ПД, ни в РД, выглядит
   в протоколе так же убедительно, как настоящая.

Сравнение чисел **строгое**: «2,50» и «2.5» разными не считаем только в части запятой и точки,
а хвостовой ноль не отбрасываем. Иначе выдуманное «пом. 1.10» проходило бы по настоящему
«пом. 1.1». Строгость здесь безопасна: лишняя строгость даёт отсутствие гипотезы, а не ложную.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from typing import Any

#: Число в тексте: целое или дробное, разделитель — точка или запятая.
_NUMBER = re.compile(r"\d+(?:[.,]\d+)?")
#: Пробел внутри числа как разделитель тысяч: «1 200» и «1 200» — то же самое, что «1200».
_GROUPED = re.compile(r"(?<=\d)[\s  ](?=\d)")
_SPACES = re.compile(r"\s+")
_DASHES = str.maketrans({"–": "-", "—": "-", "−": "-", "«": '"', "»": '"', "“": '"', "”": '"'})

#: Сколько подряд идущих блоков страницы разрешено склеить, чтобы найти цитату.
#: Строка таблицы после распознавания приходит разорванной по ячейкам, поэтому одного блока мало;
#: больше трёх — уже не цитата, а пересказ половины страницы.
MAX_BLOCKS = 3
#: Цитата короче этого ничего не доказывает: «м²» найдётся на любой странице.
MIN_QUOTE = 12


def normalize(text: str) -> str:
    """Текст в виде, пригодном для сравнения: регистр, пробелы, «ё», тире и кавычки не различаем."""
    lowered = text.translate(_DASHES).casefold().replace("ё", "е")
    return _SPACES.sub(" ", _GROUPED.sub("", lowered)).strip()


def numbers(text: str) -> set[str]:
    """Числа текста в каноническом виде: «1 200,5» → «1200.5»."""
    return {match.group(0).replace(",", ".") for match in _NUMBER.finditer(_GROUPED.sub("", text))}


def ungrounded(text: str, sources: Iterable[str]) -> set[str]:
    """Числа, которых нет ни в одном переданном фрагменте. Пустое множество — ответ опирается на документ."""
    known: set[str] = set()
    for source in sources:
        known |= numbers(source)
    return numbers(text) - known


def page_text(page: dict[str, Any]) -> str:
    """Весь текст страницы одной строкой — для проверки чисел."""
    return "\n".join(str(block.get("text") or "") for block in page.get("blocks") or [])


def locate(quote: str, pages: Sequence[dict[str, Any]]) -> tuple[int, list[float], str] | None:
    """Где на страницах лежит цитата: `(номер страницы, рамка, текст-подсказка)` или `None`.

    Сначала ищем в отдельных блоках, и только потом в склейках соседних: так рамка получается
    по возможности узкой — инспектор увидит подсвеченной строку, а не полстраницы.
    """
    needle = normalize(quote)
    if len(needle) < MIN_QUOTE:
        return None

    for width in range(1, MAX_BLOCKS + 1):
        for page in pages:
            found = _in_page(needle, page, width)
            if found is not None:
                return found
    return None


def _in_page(needle: str, page: dict[str, Any], width: int) -> tuple[int, list[float], str] | None:
    blocks = [b for b in page.get("blocks") or [] if str(b.get("text") or "").strip()]
    for start in range(0, max(0, len(blocks) - width + 1)):
        window = blocks[start : start + width]
        text = " ".join(str(b.get("text") or "") for b in window)
        if needle in normalize(text):
            box = _union(b.get("bbox") for b in window)
            if box is None:
                continue
            return int(page.get("page") or 1), box, text.strip()[:300]
    return None


def _union(boxes: Iterable[Any]) -> list[float] | None:
    found = [b for b in boxes if isinstance(b, (list, tuple)) and len(b) == 4]
    if not found:
        return None
    return [
        min(float(b[0]) for b in found),
        min(float(b[1]) for b in found),
        max(float(b[2]) for b in found),
        max(float(b[3]) for b in found),
    ]
