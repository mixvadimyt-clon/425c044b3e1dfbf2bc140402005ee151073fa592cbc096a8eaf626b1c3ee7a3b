"""Сопоставление листов ПД ↔ РД ↔ ИД.

Инспектору нужно видеть два листа рядом: «вот этот план в проектной, а вот он же в рабочей».
Здесь определяется, какой лист какому соответствует; само наложение и поиск различий — `sheetdiff.py`.

Что сопоставляется и по чему:

1. **Отметки уровня на чертеже** — `cv.fingerprint`. Главный признак и единственный, который
   переживает переход от ПД к РД: `+13.750` — это одно и то же место в здании на любой стадии.
   Вес отметки тем больше, чем реже она встречается в комплекте.
2. **Отметка, названная в графе 4.** Наименование листа ПД не сопоставляется с наименованием
   РД, но само по себе оно — утверждение о содержимом: «План 4, 8 этажей **на отм. +13.750
   +27.950**». Отсюда возражение (`_contradicts`) и довод (`_declared_hit`).
3. **Наименование листа из основной надписи** — «План -3-го этажа», «Схема армирования».
   Берётся из графы 4 штампа (`layout.title_block.sheet_title`), а не из штампа целиком: в
   штампе целиком лежат подписи граф («изм. кол.уч. лист №док. подп. дата») и название объекта,
   одинаковые на всех листах комплекта. Первая версия сравнивала штамп целиком, и лучшей парой
   выходило «москва 2025 г» ↔ «москва, 2025 г».
4. **Номер листа из основной надписи.** Надёжен, но в комплекте номера идут по каждому
   документу заново, поэтому работает только прибавкой.
5. **Текст самого листа.** Подстраховка для сканов, где штамп не распознался.

**Миниатюр здесь нет,** хотя в задаче они упомянуты. На этапе сравнения у нас только разобранный
JSON: исходные PDF движку не передаются, а рендерить их заново негде. Сходство миниатюр появится
вместе с кешем рендеров (`renders/{sha256}/{page}.png`) и нужно для визуального diff —
там растр нужен в любом случае. Отметки уровня — способ обойтись без растра там, где можно.

Сопоставление **один к одному**: лист не может быть парой сразу к двум. Идём по убыванию оценки
и занимаем свободные стороны — это жадный выбор, но при таком разрыве в оценках он совпадает с
оптимальным, а стоит линейного времени вместо венгерского алгоритма на тысячах листов.
"""

from __future__ import annotations

import hashlib
import re
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Any

from rapidfuzz import fuzz, process

from inspector_ml.cv.fingerprint import (
    MIN_MARKS,
    MIN_SHARED_WEIGHT,
    elevations,
    shared_weight,
    similarity,
    weights,
)
from inspector_ml.extract.normalize import collapse, key
from inspector_ml.layout.title_block import page_text, sheet_title
from inspector_ml.logging import get_logger

log = get_logger(__name__)

#: Марки, которые описывают одно и то же на разных стадиях: в ПД раздел КР, в РД — КЖ.
EQUIVALENT_DISCIPLINES: dict[str, str] = {
    "КЖ": "КР",
    "КМ": "КР",
    "АС": "АР",
    "ЭС": "ЭОМ",
    "ВК": "НВК",
    "ГП": "СПОЗУ",
    "ПЗУ": "СПОЗУ",
}
#: Сколько символов текста листа берём для сравнения: дальше идёт таблица штампа и повторы.
TEXT_CHARS = 400
#: Минимум длины наименования, при котором лист вообще можно с чем-то сравнивать.
#: На сканах OCR иногда возвращает одну цифру — такой лист «похож» на что угодно. Порог низкий
#: намеренно: в РД графа 4 бывает короткой («Кровля Р 5»), а реквизиты комплекта отсекаются не
#: длиной, а повторяемостью — см. `MAX_TITLE_REPEATS`.
MIN_CONTENT = 16
#: Вклад признаков в итоговую оценку. Наименование листа важнее его текста: текст на планах
#: разных этажей почти одинаковый, а подпись в штампе как раз их и различает.
WEIGHT_TITLE = 0.6
WEIGHT_TEXT = 0.4
#: Прибавка за совпавший номер листа — не решающая сама по себе, но разводит близкие варианты.
SHEET_BONUS = 0.15
#: Прибавка за совпавшие отметки уровня. Самая большая: когда наборы отметок сошлись целиком и
#: отметки редкие, это соответствие сильнее любого сходства текстов — и, в отличие от текстов,
#: оно не ломается при переходе от ПД к РД. Полного совпадения отметок хватает, чтобы перешагнуть
#: `MIN_SCORE` без всякой помощи от штампа: на то и расчёт.
MARKS_BONUS = 0.55
#: Прибавка за отметку, **названную в графе 4** и найденную у листа-кандидата.
#:
#: Это признак другой природы, чем совпадение наборов отметок: там два листа просто похожи, а
#: здесь один лист прямо заявляет, что изображён этаж на отметке +13.750, и у кандидата эта
#: отметка есть. Набор отметок при этом может почти не пересекаться — в ПД лист несёт два
#: типовых этажа и все их размеры, в РД у этажа свой лист.
DECLARED_BONUS = 0.2
#: Суммарный вес названных отметок, при котором прибавка выходит на полную величину. Примерно
#: соответствует двум отметкам средней редкости — «+13.750 +27.950» в комплекте Речникова.
DECLARED_FULL_WEIGHT = 5.0
#: Ниже этой оценки пару не предлагаем: лучше пустой центр экрана, чем неверная пара рядом.
MIN_SCORE = 0.55
#: Предохранитель: пар больше, чем листов на меньшей стороне, быть не может, но на всякий случай.
MAX_PAIRS = 2000
#: Сколько кандидатов на лист оставляем после быстрого отбора — отдельно по каждому признаку.
CANDIDATES = 12
#: Сколько раз наименование может повториться в стадии, оставаясь наименованием листа.
#:
#: Чёрный список фраз тут не работает: из графы 4 в разных комплектах лезут то название объекта,
#: то адрес, то фамилия ГИПа, и перечислить всё нельзя. Зато их выдаёт повторяемость — «нагатинский
#: затон, улица речников, земельный участок 7/7» стоит на каждом листе, а «план -3-го этажа» на
#: одном-двух. Наименование, встреченное чаще этого порога, для сопоставления бесполезно.
MAX_TITLE_REPEATS = 5

_SHEET_NUMBER = re.compile(r"\d+")


@dataclass(frozen=True)
class Sheet:
    """Лист документа в том виде, в каком его можно сравнивать."""

    file_id: str
    page: int
    discipline: str | None
    sheet: str | None
    title: str
    text: str
    marks: frozenset[str] = frozenset()
    declared: frozenset[str] = frozenset()

    @property
    def group(self) -> str:
        """Ключ группировки: сопоставляем только листы одного раздела."""
        mark = (self.discipline or "").upper()
        return EQUIVALENT_DISCIPLINES.get(mark, mark)

    @property
    def comparable(self) -> bool:
        """Лист пригоден для сопоставления.

        Нужна марка раздела: без неё в одну группу сваливаются документы разной природы —
        состав проекта, акты, исходно-разрешительная документация — и сравниваются между собой.
        Дальше нужен хоть один различающий признак: распознанное наименование листа или набор
        отметок уровня. Одного текста чертежа мало — это размеры и подписи, они похожи у всех
        листов подряд.
        """
        return bool(self.discipline) and (len(self.title) >= MIN_CONTENT or len(self.marks) >= MIN_MARKS)


def sheets_of(file_id: Any, parsed: dict[str, Any]) -> list[Sheet]:
    """Листы документа: наименование из штампа, номер из метаданных, текст и отметки страницы."""
    metadata = parsed.get("metadata") or {}
    numbers = {row["page"]: row.get("sheet") for row in metadata.get("sheets") or []}
    discipline = metadata.get("discipline")

    sheets = []
    for page in parsed.get("pages") or []:
        whole = page_text(page)
        sheets.append(
            Sheet(
                file_id=str(file_id),
                page=page["page"],
                discipline=discipline,
                sheet=numbers.get(page["page"]),
                title=key(sheet_title(page) or ""),
                text=key(collapse(whole)[:TEXT_CHARS]),
                marks=elevations(whole),
                declared=elevations(sheet_title(page) or ""),
            )
        )
    return sheets


def pair_key(left: Sheet, right: Sheet) -> str:
    """Устойчивый ключ пары: одни и те же листы дают его при любом порядке обработки."""
    raw = f"{left.file_id}|{left.page}|{right.file_id}|{right.page}"
    return hashlib.sha1(raw.encode()).hexdigest()


#: Метрика сходства. Намеренно **не** `token_set_ratio`: он сравнивает пересечение множеств
#: токенов и возвращает 100 %, когда токены одной стороны — подмножество другой. На сканах, где
#: OCR распознал одну цифру, такой лист оказывался «полностью похож» на любой, где эта цифра
#: есть, — страница состава проекта сходилась с актом освидетельствования. `token_sort_ratio`
#: сравнивает строки целиком и за разницу в длине штрафует.
SCORER = fuzz.token_sort_ratio


def score(left: Sheet, right: Sheet, weight: Mapping[str, float] | None = None) -> float:
    """Насколько похожи два листа: 0 — ничего общего, 1 — совпадают.

    `weight` — веса отметок уровня по комплекту (`fingerprint.weights`). Без него отметки
    не учитываются: считать их редкость не по чему.
    """
    if _contradicts(left, right) or _contradicts(right, left):
        return 0.0
    title = SCORER(left.title, right.title) / 100 if left.title and right.title else 0.0
    text = SCORER(left.text, right.text) / 100 if left.text and right.text else 0.0
    value = WEIGHT_TITLE * title + WEIGHT_TEXT * text
    if weight:
        value += MARKS_BONUS * similarity(left.marks, right.marks, weight)
        value += DECLARED_BONUS * _declared_hit(left, right, weight)
    if _same_sheet(left.sheet, right.sheet):
        value += SHEET_BONUS
    return min(value, 1.0)


def _declared_hit(left: Sheet, right: Sheet, weight: Mapping[str, float]) -> float:
    """Насколько сильно графа 4 одного листа подтверждается отметками другого: от 0 до 1.

    Считается по редкости названных отметок, а не по их числу: «+43.925» встречается на двух
    листах комплекта и доказывает почти всё, «+0.000» — на сотне и не доказывает ничего.
    """
    named = max(
        shared_weight(left.declared, right.marks, weight),
        shared_weight(right.declared, left.marks, weight),
    )
    return min(named / DECLARED_FULL_WEIGHT, 1.0)


def _contradicts(left: Sheet, right: Sheet) -> bool:
    """Графа 4 одного листа прямо противоречит отметкам другого.

    В ПД в наименование пишут, что изображено, вместе с отметкой: «План 4, 8 этажей на отм.
    +13.750 +27.950». Это утверждение о содержимом листа, и оно сильнее любого сходства текстов:
    если у листа-кандидата нет **ни одной** из объявленных отметок, изображено там другое место.
    На Речникове это правило снимает пару «ПД стр. 51 (отм. +10.200, +24.400) ↔ РД стр. 24»,
    где общих отметок не было вовсе, а оценку набрал похожий текст чертежа.

    Достаточно **одной** общей отметки: в ПД на листе рисуют несколько типовых этажей сразу
    («План 5, 9 этажей»), а в РД каждый этаж идёт своим листом, и совпасть может только часть.

    Правило не применяется, когда у второго листа отметок нет совсем: на сканах их часто не
    видно, и молчание — не возражение.
    """
    return bool(left.declared) and len(right.marks) >= MIN_MARKS and not (left.declared & right.marks)


def _same_sheet(left: str | None, right: str | None) -> bool:
    """Номера листов совпадают. Сравниваем числа: «Лист 4» и «4» — один и тот же лист."""
    if not left or not right:
        return False
    a, b = _SHEET_NUMBER.search(left), _SHEET_NUMBER.search(right)
    return bool(a and b and a.group() == b.group())


def page_pairs(left: Sequence[Sheet], right: Sequence[Sheet], *, min_score: float = MIN_SCORE) -> list[dict[str, Any]]:
    """Пары листов двух стадий, по одной на лист, отсортированные по убыванию оценки."""
    ours_all, theirs_all = informative(left), informative(right)
    # Редкость отметки считаем по обеим стадиям сразу: это один и тот же объект, и отметка,
    # обычная для проектной документации, так же обычна и для рабочей.
    weight = weights(sheet.marks for sheet in [*ours_all, *theirs_all] if sheet.marks)

    candidates: list[tuple[float, Sheet, Sheet]] = []
    right_groups = _by_group(theirs_all)
    for group, ours in _by_group(ours_all).items():
        theirs = right_groups.get(group)
        if not theirs:
            continue
        candidates.extend(_candidates(ours, theirs, weight))

    candidates.sort(key=lambda item: (-item[0], item[1].file_id, item[1].page))
    taken_left: set[tuple[str, int]] = set()
    taken_right: set[tuple[str, int]] = set()

    pairs: list[dict[str, Any]] = []
    for value, one, two in candidates:
        if value < min_score or len(pairs) >= MAX_PAIRS:
            continue
        if (one.file_id, one.page) in taken_left or (two.file_id, two.page) in taken_right:
            continue
        taken_left.add((one.file_id, one.page))
        taken_right.add((two.file_id, two.page))
        pairs.append(
            {
                "pair_key": pair_key(one, two),
                "left": {"file_id": one.file_id, "page": one.page},
                "right": {"file_id": two.file_id, "page": two.page},
                "match_score": round(value, 4),
                "homography": None,
                "diff_regions": [],
            }
        )
    log.debug("page_pairs", left=len(left), right=len(right), pairs=len(pairs))
    return pairs


def informative(sheets: Iterable[Sheet]) -> list[Sheet]:
    """Листы, у которых есть чем сопоставляться.

    Наименование, повторяющееся в стадии слишком часто, — это не имя листа, а реквизит комплекта,
    попавший в графу 4. Такое наименование стирается, и лист остаётся в игре, только если его
    различают отметки уровня.
    """
    usable = [sheet for sheet in sheets if sheet.comparable]
    repeats = Counter(sheet.title for sheet in usable if len(sheet.title) >= MIN_CONTENT)
    kept = []
    for sheet in usable:
        if len(sheet.title) < MIN_CONTENT or repeats[sheet.title] > MAX_TITLE_REPEATS:
            sheet = replace(sheet, title="")
        if sheet.title or len(sheet.marks) >= MIN_MARKS:
            kept.append(sheet)
    return kept


def _by_group(sheets: Iterable[Sheet]) -> dict[str, list[Sheet]]:
    grouped: dict[str, list[Sheet]] = {}
    for sheet in sheets:
        grouped.setdefault(sheet.group, []).append(sheet)
    return grouped


def _candidates(
    ours: list[Sheet], theirs: list[Sheet], weight: Mapping[str, float]
) -> list[tuple[float, Sheet, Sheet]]:
    """Пары-кандидаты внутри одного раздела.

    Сравнивать каждый лист с каждым дорого: в комплекте объекта тысячи листов, и полный перебор
    даёт миллионы сравнений текста. Поэтому сначала быстрый отбор, и он идёт **двумя путями
    сразу** — по наименованию из штампа и по отметкам уровня. Один путь не заменяет другой:
    верная пара ПД ↔ РД сходится по отметкам, а по наименованию не попала бы даже в список
    кандидатов — в графе 4 у неё написано разное.
    """
    found = _by_title(ours, theirs) | _by_marks(ours, theirs, weight)
    return [(score(ours[i], theirs[j], weight), ours[i], theirs[j]) for i, j in found]


def _by_title(ours: list[Sheet], theirs: list[Sheet]) -> set[tuple[int, int]]:
    """Кандидаты по наименованию листа.

    `rapidfuzz.process.cdist` считает матрицу сходства сразу целиком в C — это на порядки
    быстрее, чем перебирать пары в Python.
    """
    titles_ours = [sheet.title for sheet in ours]
    titles_theirs = [sheet.title for sheet in theirs]
    if not any(titles_ours) or not any(titles_theirs):
        return set()

    matrix = process.cdist(titles_ours, titles_theirs, scorer=SCORER, workers=-1)
    found: set[tuple[int, int]] = set()
    for index, row in enumerate(matrix):
        if not titles_ours[index]:
            continue
        best = sorted(range(len(theirs)), key=lambda j: -row[j])[:CANDIDATES]
        found.update((index, j) for j in best if titles_theirs[j])
    return found


def _by_marks(ours: list[Sheet], theirs: list[Sheet], weight: Mapping[str, float]) -> set[tuple[int, int]]:
    """Кандидаты по отметкам уровня — через обратный индекс «отметка → листы».

    Перебор здесь не нужен: у листа десяток отметок, и достаточно пройти по тем листам другой
    стадии, где встретилась хотя бы одна из них. Лист без отметок в индекс не попадает и
    кандидатов не порождает.

    Ищем двумя заходами. Сначала по всем отметкам листа — так находятся чертежи одного места.
    Потом отдельно по отметкам из графы 4: лист ПД с двумя типовыми этажами и лист РД с одним
    из них по наборам целиком не сойдутся, а по названной отметке — сойдутся.
    """
    index: dict[str, list[int]] = {}
    for position, sheet in enumerate(theirs):
        for mark in sheet.marks:
            index.setdefault(mark, []).append(position)

    found: set[tuple[int, int]] = set()
    for position, sheet in enumerate(ours):
        if len(sheet.marks) >= MIN_MARKS:
            found |= _closest(position, sheet.marks, index, weight)
        found |= _closest(position, sheet.declared, index, weight)
    return found


def _closest(
    position: int, marks: frozenset[str], index: Mapping[str, list[int]], weight: Mapping[str, float]
) -> set[tuple[int, int]]:
    """Ближайшие листы другой стороны по сумме весов общих отметок."""
    totals: dict[int, float] = {}
    for mark in marks:
        value = weight.get(mark, 0.0)
        if not value:
            continue
        for other in index.get(mark, ()):
            totals[other] = totals.get(other, 0.0) + value
    best = sorted(totals, key=lambda other: -totals[other])[:CANDIDATES]
    return {(position, other) for other in best if totals[other] >= MIN_SHARED_WEIGHT}
