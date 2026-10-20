"""Вентиляция по помещениям ПД ↔ РД (IOS4-078 и IOS4-079): сравнение состава систем.

Значение точки даёт извлечение (`extract/ventilation.py`): системы, которые обслуживают помещение,
через запятую по алфавиту — «В2.7, В2.8, П3». Ключ точки — «пом. 140». Сравниваются наборы, а не строки:
строка расходится и тогда, когда в РД просто добавилась естественная вытяжка, а это не нарушение.

- **M-078** (системы помещения):
  - механической вытяжки ПД («В…», кроме «ВЕ») в РД нет совсем — вытяжная вентиляция отсутствует
    (MISSING_DESIGN_ELEMENT в терминах эталона, как IOS4-078 у помещений 140 и 142);
  - части систем ПД в РД нет — конфигурация изменена (CONFIGURATION_MISMATCH, помещения 147, 198, 314);
  - в РД только добавились системы — состав ПД сохранён, триггер это не описывает.
- **M-079** (приточные установки венткамеры): наборы различаются в любую сторону — конфигурация изменена
  (CONFIGURATION_MISMATCH, венткамера 012). Подмена установки видна как «одной нет, другая появилась».

Неполное распознавание: на плане РД подпись читает OCR, и «В12.1» иногда приходит как «В12». Такая запись
засчитывается за любую систему ПД с тем же номером группы, и наоборот: ложный кандидат дороже пропуска.
Значение только в одной стадии сюда не доходит — движок даёт NOT_COMPARABLE (пропуск извлечения на плане
не доказывает, что вентиляции нет).

Формулировку триггера матрицы («уменьшение площади сечения воздуховода») к выводу не добавляем: значения
этих параметров — состав систем, а не сечения.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

#: Параметры, у которых значение точки — набор систем вентиляции (формат).
CODES = frozenset({"M-078", "M-079"})

#: Шрифт САПР распознаётся латиницей — «B2.7», «BE16»; приводим к кириллице, как извлечение.
_LATIN = str.maketrans({"B": "В", "E": "Е"})
_SYSTEM = re.compile(r"^(ВЕ|ПЕ|В|П)(\d+(?:\.\d+)*)?$")


@dataclass(frozen=True)
class Verdict:
    triggered: bool
    delta: str | None
    rationale: str


def parse(value: object) -> list[str] | None:
    """«В2.7, В2.8, П3» → ["В2.7", "В2.8", "П3"]; не набор систем — ``None`` (сравнение пойдёт обычным путём)."""
    if not isinstance(value, str) or not value.strip():
        return None
    systems = []
    for token in value.split(","):
        code = re.sub(r"\s+", "", token).upper().translate(_LATIN)
        if not _SYSTEM.match(code):
            return None
        systems.append(code)
    return list(dict.fromkeys(systems))


def _bare(a: str, b: str) -> bool:
    """Естественная вентиляция без номера и пронумерованная той же буквы — одна система: в ПД «ПЕ», в РД «ПЕ1»
    («Тюменская 5», помещение 008). Для «В» и «П» так не считаем: «В» без номера —
    не обозначение системы."""
    return a in ("ПЕ", "ВЕ") and re.fullmatch(re.escape(a) + r"\d+(?:\.\d+)*", b) is not None


def _same(a: str, b: str) -> bool:
    """Одна система: совпадение, неполная запись группы («В12» и «В12.1») или «ПЕ» без номера и «ПЕ1»."""
    return a == b or a.startswith(b + ".") or b.startswith(a + ".") or _bare(a, b) or _bare(b, a)


def _absent(systems: list[str], other: list[str]) -> list[str]:
    """Системы, которых нет в ``other``. Неполная запись засчитывается, только если её пара не стоит в своём наборе
    точно: у ПД «П2, П3» и РД «П2, П2.1» система П2 уже нашлась, и «П2.1» — новая установка, а не недочитанная «П2»."""
    return [s for s in systems if s not in other and not any(_same(s, o) and o not in systems for o in other)]


def _mechanical_exhaust(code: str) -> bool:
    return code.startswith("В") and not code.startswith("ВЕ")


def _delta(lost: list[str], added: list[str]) -> str:
    return "; ".join(part for part in (", ".join(f"−{s}" for s in lost), ", ".join(f"+{s}" for s in added)) if part)


def compare(code: str, expected: list[str], actual: list[str]) -> Verdict:
    lost = _absent(expected, actual)
    added = _absent(actual, expected)
    if not lost and not added:
        return Verdict(False, None, "состав систем совпадает")
    delta = _delta(lost, added)
    if code == "M-079":
        parts = [f"в РД нет установок {', '.join(lost)}"] if lost else []
        parts += [f"появились {', '.join(added)}"] if added else []
        return Verdict(True, delta, "конфигурация приточных установок изменена: " + ", ".join(parts))
    if not lost:
        return Verdict(
            False, delta, f"в РД добавлены системы {', '.join(added)}, системы ПД сохранены — триггер это не описывает"
        )
    exhaust = [s for s in expected if _mechanical_exhaust(s)]
    if exhaust and all(s in lost for s in exhaust) and not any(_mechanical_exhaust(s) for s in actual):
        return Verdict(True, delta, f"вытяжная вентиляция в РД отсутствует: нет систем {', '.join(exhaust)}")
    rationale = f"конфигурация вентиляции изменена: в РД нет систем {', '.join(lost)}"
    if added:
        rationale += f", появились {', '.join(added)}"
    return Verdict(True, delta, rationale)
