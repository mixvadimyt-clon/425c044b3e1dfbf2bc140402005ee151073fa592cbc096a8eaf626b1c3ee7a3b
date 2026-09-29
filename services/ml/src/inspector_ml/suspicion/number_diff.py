"""Изменённые числа в совпадающем тексте ПД и РД — гипотезы без матрицы и без модели.

Зачем. Матрица ловит только свои 132 параметра и только по своим якорям. На стенде 26.09 пришла
пара ПД/РД раздела ИОС3.2 с одним и тем же текстом, где в РД поменяли три числа: R0 грунта
270 → 300 кПа, суточный расход 123,576 → 125,576 м³/сут, секундный 8,397 → 11,397 л/с. Двух из них
в матрице нет вовсе, третий записан другими словами, чем якорь параметра, — и протокол вышел
пустым. Человек же видит такое сразу: абзац слово в слово тот же, а число другое.

Как ищем:

1. **Пары страниц с одним и тем же текстом.** Текст страницы без основной надписи превращается
   в набор «четвёрок слов», где любое число заменено на `#`: так страницы с разными числами, но
   одинаковыми словами, совпадают. Для каждой страницы ПД берётся страница РД с наибольшей долей
   общих четвёрок; меньше `MIN_SIMILARITY` — это разный текст, сравнивать нечего.
2. **Выравнивание слов.** Тексты пары выравниваются по словам (`difflib`), и заменой считается
   место, где с обеих сторон стоит **только число**, а всё вокруг совпало. Слова поменялись —
   это уже не «то же с другим числом», а другой текст.
3. **Отбор.** Число должно быть величиной: с единицей после («кПа», «мм», «м3/сут»), со знаком
   «=» перед или дробным. Годы, даты, номера листов, пунктов и документов («№ 4», «Лист 4»,
   «от 29.12.2022») отбрасываются.

Результат — **гипотеза**: «R0: в ПД 270 кПа, в РД 300 кПа», с доказательствами на обеих страницах.
Нарушение это или согласованное изменение, решает инспектор. Если то же расхождение уже нашёл
движок по параметру матрицы, гипотеза не дублирует кандидата.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Any

from inspector_ml.compare import pagepairs
from inspector_ml.compare.keys import suspicion_key
from inspector_ml.contracts.events import PagePairResult, SuspicionResult
from inspector_ml.extract.api import LoadedDocument
from inspector_ml.layout.title_block import TITLE_BLOCK_REGION
from inspector_ml.logging import get_logger
from inspector_ml.suspicion.semantic import _fragment, _reference, readable

log = get_logger(__name__)

DISCOVERY_METHOD = "SEMANTIC_DISSONANCE"
#: Уверенность гипотезы: сам текст совпал точно, но нарушение ли это — вопрос к инспектору.
CONFIDENCE = 0.6
#: Сколько слов в «четвёрке» и какая доля общих четвёрок делает две страницы одним текстом.
SHINGLE = 4
MIN_SIMILARITY = 0.5
#: Меньше стольких четвёрок — на странице слишком мало текста, чтобы говорить о «том же тексте».
MIN_SHINGLES = 15
#: Сколько гипотез берём со страницы и со всей проверки: дальше это уже другая редакция документа,
#: а не точечная правка, и инспектору нужен не список чисел, а сравнение редакций.
MAX_PER_PAGE = 5
MAX_TOTAL = 25
#: Больше этой доли изменившихся чисел — страницы описывают разное (два листа данных разных
#: установок по одному бланку), и числа между ними не сравниваем. На паре ИОС3.2 со стенда
#: изменились 3 числа из двух десятков.
MAX_CHANGED_SHARE = 0.3
#: Сколько совпавших элементов текста должно стоять перед изменившимся числом.
MIN_CONTEXT = 3
#: Четвёрка, которая стоит больше чем на стольких страницах РД, — шаблон, а не текст.
COMMON_SHINGLE_PAGES = 50
#: Сколько слов перед числом показываем как «что изменилось».
LABEL_WORDS = 5

#: Обозначения, слова, числа и знаки. «R0=270кПа» → R0, =, 270, кПа; «123,576» — одно число.
#: Цифры, приклеенные к буквам («П1», «В2», «R0», «м3»), — часть обозначения, а не величина:
#: по ним листы данных разных установок одного бланка перестают совпадать.
TOKEN = re.compile(r"[^\W\d_]+\d+(?:[.,]\d+)*|\d+(?:[.,]\d+)*|[^\W\d_]+|[^\w\s]")
NUMBER = re.compile(r"\d+(?:[.,]\d+)*")
#: После такого слова число — номер, а не величина.
NUMBERING = frozenset(
    {"№", "n", "лист", "листов", "изм", "стр", "пункт", "п", "пп", "раздел", "том", "книга", "часть"}
    | {"гост", "сп", "снип", "ту", "iso"}
)
#: Перед такими словами число — дата, год или номер тома.
NUMBER_AFTER = frozenset({"г", "года", "год", "гг", "том", "тома", "книга", "часть", "руб", "рублей", "р"})
#: Рядом с этими словами числа — деньги и реквизиты, а не проектное решение.
MONEY = frozenset({"ндс", "стоимость", "стоимости", "цена", "сумма", "руб", "рублей"})
#: «29.12», «01.02.2022», «01,02» — дата, а не величина.
DATE = re.compile(r"(0?[1-9]|[12]\d|3[01])[.,](0?[1-9]|1[0-2])(?:[.,](\d{2}|\d{4}))?")
#: Единицы — чтобы «270» с «кПа» считалось величиной, а не номером.
UNIT_START = re.compile(
    r"^(?:[кмсдгт]?[пp]а|мпа|кпа|мм|см|м|км|м2|м3|кв|л|т|кг|квт|мвт|вт|гкал|ккал|сут|ч|час|мин|с|шт|%|°)", re.IGNORECASE
)


@dataclass(frozen=True)
class Token:
    text: str
    start: int
    end: int

    @property
    def is_number(self) -> bool:
        return NUMBER.fullmatch(self.text) is not None

    @property
    def key(self) -> str:
        return "#" if self.is_number else self.text.casefold().replace("ё", "е")


@dataclass(frozen=True)
class Change:
    """Одно изменённое число: что это, значения и цитаты вокруг для доказательств."""

    label: str
    unit: str
    pd_value: str
    rd_value: str
    pd_quote: str
    rd_quote: str


def run(
    docs: Sequence[LoadedDocument],
    object_id: object,
    page_pairs: Sequence[PagePairResult] = (),
    known: Iterable[tuple[str, str]] = (),
) -> list[SuspicionResult]:
    """Гипотезы по комплекту. `known` — пары чисел (ПД, РД), которые движок уже показал кандидатами."""
    covered = {(_canonical(a), _canonical(b)) for a, b in known}
    pd_docs = [doc for doc in docs if doc.stage == "PD"]
    rd_docs = [doc for doc in docs if doc.stage == "RD"]
    if not pd_docs or not rd_docs:
        return []

    rd_pages = [(doc, page, _tokens(page)) for doc in rd_docs for page in readable(doc)]
    index = _index(rd_pages)
    found: list[SuspicionResult] = []
    seen: set[tuple[Any, ...]] = set()
    for pd, page, pd_tokens, rd, rd_page, rd_tokens in _pairs(pd_docs, rd_pages, index):
        for change in changes(pd_tokens, rd_tokens, _text(page), _text(rd_page))[:MAX_PER_PAGE]:
            values = (_canonical(change.pd_value), _canonical(change.rd_value))
            # одно и то же изменение на соседних листах (таблица повторена в приложении) — одна гипотеза
            repeat = (pd.file_id, rd.file_id, *values, change.unit)
            if values in covered or repeat in seen:
                continue
            result = _hypothesis(change, pd, page, rd, rd_page, object_id, page_pairs)
            if result is None:
                continue
            seen.add(repeat)
            found.append(result)
            if len(found) >= MAX_TOTAL:
                log.info("number_diff_limit", hypotheses=len(found))
                return found
    log.info("number_diff_done", hypotheses=len(found))
    return found


def _pairs(
    pd_docs: Sequence[LoadedDocument],
    rd_pages: Sequence[tuple[LoadedDocument, dict[str, Any], list[Token]]],
    index: dict[tuple[str, ...], list[int]],
) -> list[tuple[LoadedDocument, dict[str, Any], list[Token], LoadedDocument, dict[str, Any], list[Token]]]:
    """Пары страниц «ПД — РД» с тем же текстом, **один к одному**.

    Листы технических данных оборудования написаны по одному бланку: у каждой установки свои
    числа, а слова те же. Если каждой странице ПД брать самую похожую страницу РД, три листа
    разных установок ПД сойдутся на одном листе РД, и «расход 0,63 и 1,47 → 4,41» сравнит
    разные агрегаты. Поэтому сначала собираем все пары с долей общих четвёрок не ниже
    `MIN_SIMILARITY`, а потом разбираем их от самых похожих: страница РД достаётся одной
    странице ПД.
    """
    rd_shingles = [_shingles(tokens) for _, _, tokens in rd_pages]
    candidates = []
    for pd in pd_docs:
        for page in readable(pd):
            tokens = _tokens(page)
            mine = _shingles(tokens)
            if len(mine) < MIN_SHINGLES:
                continue
            votes = Counter(number for shingle in mine for number in index.get(shingle, ()))
            for number, _ in votes.most_common(5):
                score = similarity(mine, rd_shingles[number])
                if score >= MIN_SIMILARITY:
                    candidates.append((score, pd, page, tokens, number))
    candidates.sort(key=lambda item: -item[0])
    used_pd: set[tuple[Any, int]] = set()
    used_rd: set[int] = set()
    pairs = []
    for _, pd, page, tokens, number in candidates:
        key = (pd.file_id, int(page.get("page") or 0))
        if key in used_pd or number in used_rd:
            continue
        used_pd.add(key)
        used_rd.add(number)
        rd, rd_page, rd_tokens = rd_pages[number]
        pairs.append((pd, page, tokens, rd, rd_page, rd_tokens))
    return pairs


def changes(pd: Sequence[Token], rd: Sequence[Token], pd_text: str, rd_text: str) -> list[Change]:
    """Места, где выровненные тексты отличаются только числом."""
    matcher = SequenceMatcher(None, [t.key for t in pd], [t.key for t in rd], autojunk=False)
    aligned = [
        (pd[i1 + k], rd[j1 + k])
        for tag, i1, i2, j1, _ in matcher.get_opcodes()
        if tag == "equal"
        for k in range(i2 - i1)
        if pd[i1 + k].is_number
    ]
    differing = sum(1 for a, b in aligned if _canonical(a.text) != _canonical(b.text))
    # поменялась заметная доля чисел — это другая таблица по тому же бланку (лист данных другой
    # установки), а не точечная правка того же текста
    if not aligned or differing > MAX_CHANGED_SHARE * len(aligned):
        return []
    found: list[Change] = []
    # ключи чисел одинаковы («#»), поэтому число, поменявшееся на другое, выравниватель считает
    # совпадением: сравниваем сами числа внутри совпавших кусков
    for tag, i1, i2, j1, _ in matcher.get_opcodes():
        if tag != "equal":
            continue
        for offset in range(i2 - i1):
            a, b = pd[i1 + offset], rd[j1 + offset]
            if not a.is_number or _canonical(a.text) == _canonical(b.text):
                continue
            # перед числом должен совпасть не только знак «=», но и слова: «супеси R0 =» —
            # то же место, «крупности R0 =» после «с линзами песка средней» — уже другой текст
            if offset < MIN_CONTEXT and not (i1 == 0 and j1 == 0):
                continue
            if not _quantity(pd, i1 + offset) or _code(pd_text, a) or _code(rd_text, b):
                continue
            found.append(
                Change(
                    label=_label(pd, i1 + offset, pd_text),
                    unit=_unit(pd, i1 + offset, pd_text),
                    pd_value=a.text,
                    rd_value=b.text,
                    pd_quote=_quote(pd_text, a),
                    rd_quote=_quote(rd_text, b),
                )
            )
    return found


def similarity(first: set[tuple[str, ...]], second: set[tuple[str, ...]]) -> float:
    if not first or not second:
        return 0.0
    common = len(first & second)
    return common / (len(first) + len(second) - common)


def _tokens(page: dict[str, Any]) -> list[Token]:
    text = _text(page)
    return [Token(m.group(0), m.start(), m.end()) for m in TOKEN.finditer(text)]


def _text(page: dict[str, Any]) -> str:
    """Текст страницы без основной надписи: номер листа и подписи в штампе — не содержание."""
    return "\n".join(
        str(block.get("text") or "")
        for block in page.get("blocks") or []
        if not _in_title_block(block.get("bbox") or [0, 0, 0, 0])
    )


def _in_title_block(bbox: Sequence[float]) -> bool:
    x0, y0, _, _ = TITLE_BLOCK_REGION
    return len(bbox) == 4 and bbox[0] >= x0 and bbox[1] >= y0


def _shingles(tokens: Sequence[Token]) -> set[tuple[str, ...]]:
    keys = [t.key for t in tokens if t.key.isalnum() or t.key == "#"]
    return {tuple(keys[i : i + SHINGLE]) for i in range(max(0, len(keys) - SHINGLE + 1))}


def _index(pages: Sequence[tuple[LoadedDocument, dict[str, Any], list[Token]]]) -> dict[tuple[str, ...], list[int]]:
    """Четвёрка слов → страницы РД, где она есть. Шаблонные четвёрки, которые стоят на сотнях
    страниц («Изм. Кол.уч. Лист»), в голосование не идут: они ничего не говорят о тексте."""
    index: dict[tuple[str, ...], list[int]] = {}
    for number, (_, _, tokens) in enumerate(pages):
        for shingle in _shingles(tokens):
            index.setdefault(shingle, []).append(number)
    limit = max(COMMON_SHINGLE_PAGES, len(pages) // 10)
    return {shingle: numbers for shingle, numbers in index.items() if len(numbers) <= limit}


def _quantity(tokens: Sequence[Token], at: int) -> bool:
    """Число — величина, а не номер, год или дата."""
    value = tokens[at].text
    before = tokens[at - 1].key if at > 0 else ""
    after = tokens[at + 1].key if at + 1 < len(tokens) else ""
    if before in NUMBERING or after in NUMBER_AFTER or before == "от":
        return False
    if any(t.key in MONEY for t in tokens[max(0, at - 4) : at + 3]):
        return False
    if DATE.fullmatch(value) and not (after and UNIT_START.match(after)):
        return False
    if len(re.findall(r"[.,]", value)) >= 2 and not (after and UNIT_START.match(after)):
        return False  # «5.2.1» — номер пункта, а не величина
    if re.fullmatch(r"(19|20)\d\d", value):
        return False
    if re.fullmatch(r"\d{1,2}[.]\d{1,2}[.]\d{2,4}", value):  # дата «29.12.2022»
        return False
    return bool(after and UNIT_START.match(after)) or before in {"=", ":", "≈", "~"} or "," in value or "." in value


def _code(text: str, token: Token) -> bool:
    """Число — часть шифра или марки: «НВС-2025/03-ИОС5.4», «П-2025-04.266» (дефис или дробь в том же слове)."""
    start = token.start
    while start > 0 and not text[start - 1].isspace():
        start -= 1
    head = text[start : token.start]
    return any(ch in head for ch in "-/") and any(ch.isalpha() for ch in head)


def _label(tokens: Sequence[Token], at: int, text: str) -> str:
    """Что изменилось — несколько слов перед числом до границы фразы: «с прослоями супеси R0».

    Одна буква («Q», «q») — слишком мало: тогда берём и слова перед двоеточием, «водоотведения
    составят: Q».
    """
    start = at
    words = 0
    while start > 0 and words < LABEL_WORDS:
        previous = tokens[start - 1]
        if previous.text in ".;," and words:
            break
        if previous.text == ":" and words >= 2:
            break
        start -= 1
        if previous.key.isalpha():
            words += 1
    label = text[tokens[start].start : tokens[at].start] if start < at else ""
    return " ".join(label.replace("\n", " ").split()).strip(" =:–—-(,") or "Значение"


def _unit(tokens: Sequence[Token], at: int, text: str) -> str:
    if at + 1 < len(tokens) and UNIT_START.match(tokens[at + 1].key):
        end = at + 1
        # «м3/сут», «л/с»: степень вплотную к единице, потом дробь
        if end + 1 < len(tokens) and tokens[end + 1].text.isdigit() and tokens[end + 1].start == tokens[end].end:
            end += 1
        while end + 2 < len(tokens) and tokens[end + 1].text == "/" and tokens[end + 2].key.isalpha():
            end += 2
        return text[tokens[at + 1].start : tokens[end].end]
    return ""


def _quote(text: str, token: Token) -> str:
    """Кусок текста вокруг числа — по нему доказательство найдёт свою рамку на странице."""
    start = max(0, token.start - 40)
    return " ".join(text[start : token.end + 12].replace("\n", " ").split())


def _canonical(value: str) -> str:
    return value.replace(",", ".").rstrip("0").rstrip(".") if "," in value or "." in value else value


def _hypothesis(
    change: Change,
    pd: LoadedDocument,
    pd_page: dict[str, Any],
    rd: LoadedDocument,
    rd_page: dict[str, Any],
    object_id: object,
    page_pairs: Sequence[PagePairResult],
) -> SuspicionResult | None:
    pd_fragment = _fragment(pd, change.pd_quote, "EXPECTED", [pd_page])
    rd_fragment = _fragment(rd, change.rd_quote, "ACTUAL", [rd_page])
    if pd_fragment is None or rd_fragment is None:
        log.debug("number_diff_unlocated", label=change.label[:40])
        return None
    unit = f" {change.unit}" if change.unit else ""
    description = (
        f"{change.label} — в ПД {change.pd_value}{unit}, в РД {change.rd_value}{unit}. "
        "Текст вокруг числа в ПД и РД совпадает — проверьте, согласовано ли изменение."
    )
    evidence = [pd_fragment, rd_fragment]
    confidences = [f.confidence for f in evidence if f.confidence is not None]
    return SuspicionResult.model_validate(
        {
            "suspicion_key": suspicion_key(
                object_id, "NUMBER_DIFF", f"{change.label}|{_canonical(change.pd_value)}|{_canonical(change.rd_value)}"
            ),
            "discovery_method": DISCOVERY_METHOD,
            "confidence": min([CONFIDENCE, *confidences]),
            "description": description,
            "pd_reference": _reference(pd, pd_fragment),
            "rd_reference": _reference(rd, rd_fragment),
            "id_reference": None,
            "review_priority": "MEDIUM",
            "rule_id": None,
            "page_pair_key": pagepairs.key_for(evidence, page_pairs),
            "evidence": evidence,
        }
    )
