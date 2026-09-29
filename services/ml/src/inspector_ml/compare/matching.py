"""Сопоставление экземпляров атомарного правила между стадиями.

Одна контрольная точка в ПД, РД и ИД называется по-разному: «Помещение 1-09», «пом. 1.09», «1.09».
Сначала работает точное сопоставление нормализованных ключей (``keys.rule_group``), затем —
нестрогое, через rapidfuzz.

Правила нестрогого сопоставления намеренно осторожные: лишняя группа заставит инспектора смотреть
две карточки вместо одной, а ошибочное слияние сравнит площадь одного помещения с площадью другого.

- **Номер решает.** Если в ключах есть числа, они должны совпасть полностью: «пом. 1.09» и «пом. 1.10»
  не одна точка, хотя строки похожи на 95 %.
- **Слова сравниваем по форме, а не строку целиком.** «стены в грунте» и «стена в грунте» — одна
  точка, «вертикальные конструкции подземной части» и «…надземной части» — разные. Сравнение строк
  здесь обманывает: у последней пары 95 % схожести, отличие в одну букву из сорока, — и классы
  бетона подземной и надземной части молча сравнились бы между собой.
- **При совпавших номерах** один ключ может быть подробнее другого («Экспликация помещений 1-го
  этажа» и «Экспликация 1-го этажа»): номер уже опознал точку. Без чисел состав слов должен совпасть.
- **Внутри одной стадии не сливаем**: два ключа из ПД — это две разные точки.
- **Ключ ``None`` — одна точка на параметр.** Так работает общий разбор по матрице
  (``extract/regex.py``): к какому элементу относится найденное значение, он не знает. Значения
  без ключа из разных стадий сравниваются между собой — иначе у 130 параметров из 132 сравнения
  не случилось бы вовсе. Плата за это — несколько разных значений внутри одной стадии: движок
  не выбирает из них сам, а требует выбора источника (``engine``, ``CLARIFICATION_REQUIRED``).
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Sequence

from rapidfuzz import fuzz

from inspector_ml.compare.keys import rule_group
from inspector_ml.compare.ports import Extraction

PREFIX = 5
"""Сколько первых букв должно совпасть, чтобы счесть слова формами одного (для коротких — на одну меньше)."""

TYPO_THRESHOLD = 90
"""Запасной путь для опечаток распознавания; начало слова всё равно должно совпасть."""

SHORT = 2
"""Слова не длиннее этого сравниваем только точно: «А» и «Б» — разные оси, а не формы одного слова."""


def _numbers(key: str) -> tuple[str, ...]:
    return tuple(re.findall(r"\d+(?:\.\d+)*", key))


def _words(key: str) -> list[str]:
    return re.findall(r"[а-яёa-z]+", key)


def _prefix_len(left: str, right: str) -> int:
    length = 0
    for a, b in zip(left, right, strict=False):  # слова разной длины — сравниваем по короткому
        if a != b:
            break
        length += 1
    return length


def same_word(left: str, right: str) -> bool:
    """Два слова — формы одного и того же.

    Решает начало слова, а не похожесть целиком: «стены» и «стена» — одно, «подземной» и
    «надземной» — разные. Сравнение строки целиком здесь не годится, оно даёт этой паре 95 %
    (отличие в одну букву из сорока) и молча сливает подземную часть с надземной.

    **Короткие слова сравниваем только точно.** Для слова из одной-двух букв порог «сколько
    первых букв совпало» вырождается в ноль, и тогда совпадает всё со всем: «ось А» и «ось Б»
    оказывались одной контрольной точкой. Буква здесь и есть всё содержание слова — ось, секция,
    литера, — поэтому никакой нестрогости.

    Нестрогое сравнение остаётся запасным путём для опечаток распознавания, но и оно требует
    совпадения первых букв: именно там живут «под», «над» и «не», которые меняют смысл.
    """
    if left == right:
        return True
    shortest = min(len(left), len(right))
    if shortest <= SHORT:
        return False
    if _prefix_len(left, right) >= min(PREFIX, shortest - 1):
        return True
    return _prefix_len(left, right) >= 2 and fuzz.ratio(left, right) >= TYPO_THRESHOLD


def _pair_up(small: list[str], big: list[str]) -> bool:
    """Каждому слову из ``small`` нашлась своя форма в ``big`` — по одной на слово."""
    free = list(big)
    for word in small:
        match = next((other for other in free if same_word(word, other)), None)
        if match is None:
            return False
        free.remove(match)
    return True


def similarity(left: str, right: str) -> float | None:
    """Оценка «это одна и та же точка» или ``None``, если сопоставлять нельзя."""
    left_numbers, right_numbers = _numbers(left), _numbers(right)
    left_words, right_words = _words(left), _words(right)
    if left_numbers or right_numbers:
        if left_numbers != right_numbers:
            return None
        if not left_words or not right_words:
            return 100.0
        # номер уже опознал точку, поэтому один ключ может быть подробнее другого;
        # но противопоставление («подземной» против «надземной») точкой быть не перестаёт
        small, big = sorted((left_words, right_words), key=len)
        return 100.0 if _pair_up(small, big) else None
    if not left_words or not right_words:
        return None
    return 100.0 if len(left_words) == len(right_words) and _pair_up(left_words, right_words) else None


def group(items: Iterable[Extraction], stage_of: Callable[[Extraction], str]) -> list[list[Extraction]]:
    """Извлечения, разложенные по контрольным точкам: сначала точно по ключу, затем нестрого."""
    exact: dict[str | None, list[Extraction]] = {}
    for x in items:
        exact.setdefault(rule_group(x.rule_key), []).append(x)
    groups: list[tuple[str | None, list[Extraction]]] = list(exact.items())

    while (pair := _best_merge(groups, stage_of)) is not None:
        i, j = pair
        groups[i] = (groups[i][0], groups[i][1] + groups[j][1])
        groups.pop(j)
    return [members for _, members in groups]


def _best_merge(
    groups: Sequence[tuple[str | None, list[Extraction]]], stage_of: Callable[[Extraction], str]
) -> tuple[int, int] | None:
    """Самая похожая пара групп из разных стадий; при равных оценках — первая по порядку."""
    best: tuple[float, int, int] | None = None
    for i, (left_key, left_items) in enumerate(groups):
        if left_key is None:
            continue
        left_stages = {stage_of(x) for x in left_items}
        for j in range(i + 1, len(groups)):
            right_key, right_items = groups[j]
            if right_key is None or left_stages & {stage_of(x) for x in right_items}:
                continue
            score = similarity(left_key, right_key)
            if score is not None and (best is None or score > best[0]):
                best = (score, i, j)
    return (best[1], best[2]) if best else None
