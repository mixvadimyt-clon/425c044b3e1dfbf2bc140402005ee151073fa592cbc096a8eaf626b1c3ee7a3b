"""Sentence-BERT — запасной путь извлечения числовых параметров.

Правила матрицы ищут параметр по дословному названию (так у 106 параметров из 132), и где документ называет
его иначе, они молчат. Тогда работает этот модуль: со страниц берутся кандидаты «подпись → число с единицей»
(фразы текста и строки таблиц), единица должна подходить параметру, а подпись сравнивается с названием и
якорями параметра по косинусной близости эмбеддингов (`paraphrase-multilingual-MiniLM-L12-v2`).

Значение берётся, только если:

- правила по параметру молчат **во всех документах стадии** — это запасной путь, а не соперник правил. Из
  стадии берётся одно значение, самое близкое: два разных числа в стадии дали бы «требуется уточнение»;
- у параметра нет ключа места: помещения M-002, конструкции M-058, выпуски M-074 и т. п. Значение без ключа
  с их точками не сводится (`extract/api.py`, `KEYED`);
- кандидат прошёл фильтры: значение в пределах `min_value…max_value` матрицы, у счётного параметра оно
  целое, в подписи не меньше двух содержательных слов и нет стоп-основ (`sbert_stops.json`);
- близость не ниже `SBERT_THRESHOLD` (0,9);
- подпись не ближе к другому параметру матрицы — любому, в том числе нечисловому и уже найденному правилами:
  «одна подпись — один параметр». Проигравший параметр берёт следующего кандидата. Иначе «Строительный объём»
  стал бы значением и общего, и подземного объёма, а «площадь застройки» — ещё и общей площадью здания.

Значение относится к параметру целиком (`rule_key = None`), фрагмент помечен `extraction_method = SBERT`
(контракт 0.23.0): найденное по смыслу слабее найденного правилом, и это видят инспектор в карточке и скорер
признаком `sbert`. Уверенность фрагмента не трогаем — это уверенность распознавания текста, а не метода.

Замер — `data/samples/sbert-eval/README.md`. На отложенных объектах 12, 17, 18 F1 0,718 → 0,749
(95 % ДИ 0,70–0,79): полнота 0,665 → 0,743, точность 0,779 → 0,755. Разметка серебряная, интервалы
перекрываются.

Считается один раз на документ сразу для всех числовых параметров — иначе не проверить «одна подпись — один
параметр» — и запоминается на время задачи сравнения. Модель грузится один раз на процесс и только с диска. Нет
пакета, нет весов, кончился лимит подписей (`SBERT_MAX_LABELS`, детерминированный) или аварийный бюджет времени —
запасной путь выключается, работают одни правила: проверка не падает из-за модели.

Дорого здесь только кодирование подписей: на процессоре около 120 подписей в секунду, всё остальное — доли
процента. Поэтому до модели подпись проходит дешёвый отсев: не меньше двух содержательных слов (фильтр
`generic` — он от параметра не зависит) и хотя бы одна общая основа из `ROOT` букв с названием или якорем
какого-нибудь числового параметра. Без общего слова близость 0,9 не набирается: на отложенных ни одно из 84
значений повтора не было без общей основы со своим параметром, а кодировать остаётся 40 % подписей. Эмбеддинги
подписей помнятся на процесс (`MAX_CACHED_LABELS`): повторное сравнение того же комплекта их не пересчитывает.
"""

from __future__ import annotations

import json
import re
import time
from collections import OrderedDict
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import numpy as np

from inspector_ml.config import Settings
from inspector_ml.contracts.events import MatrixParam
from inspector_ml.extract.base import Found
from inspector_ml.extract.normalize import collapse, number
from inspector_ml.extract.tables import PageCell, bands, page_cells
from inspector_ml.logging import get_logger

log = get_logger(__name__)

#: Метод извлечения в `Found.method` и `Extraction.method`.
METHOD = "sbert"
#: Стадии, на которых запасной путь мерили. ИД — акты и сканы, там его не проверяли.
STAGES = frozenset({"PD", "RD"})
STOPS_FILE = Path(__file__).with_name("sbert_stops.json")

#: Класс единицы параметра по колонке `unit` матрицы. Параметр с единицей не из списка принимает только
#: число без единицы.
UNIT_CLASS = {
    "м": "len",
    "мм": "len",
    "м²": "area",
    "мм²": "area_mm",
    "м³": "vol",
    "м³/сут": "flow_day",
    "м³/ч": "flow_h",
    "л/с": "flow_ls",
    "кВт": "power",
    "Гкал/ч": "heat",
    "%": "pct",
    "‰": "permille",
    "шт.": "count",
    "ед.": "count",
    "чел.": "count",
    "А (Ампер)": "amp",
    "дни": "days",
    "мин": "min",
    "мин (EI)": "min",
    "тыс. руб.": "money",
    "Вт/(м·С)": "lambda",
    "м²·С/Вт": "r0",
    "кВт·ч/м²": "specific",
}
#: Единица после числа в документе. Порядок важен: длинные раньше коротких.
UNITS = (
    ("flow_day", r"(?:м\s*[3³]|куб\.?\s*м)\s*/\s*сут\w*"),
    ("flow_h", r"(?:м\s*[3³]|куб\.?\s*м)\s*/\s*ч\w*"),
    ("flow_ls", r"л\s*/\s*с(?:ек)?\b"),
    ("heat", r"Гкал\s*/\s*ч\w*"),
    ("specific", r"кВт\s*[·*.]?\s*ч\s*/\s*м\s*[2²]"),
    ("r0", r"м\s*[2²]\s*[·*.]?\s*°?\s*С\s*/\s*Вт"),
    ("lambda", r"Вт\s*/\s*\(?\s*м\s*[·*.]?\s*°?\s*С"),
    ("area_mm", r"мм\s*[2²]"),
    ("area", r"(?:м\s*[2²]|кв\.?\s*м)(?![а-яё])"),
    ("vol", r"(?:м\s*[3³]|куб\.?\s*м)(?![а-яё/])"),
    ("len_mm", r"мм(?![а-яё²2])"),
    ("len", r"м(?![а-яё²2³3/])"),
    ("power", r"кВт(?![а-яё·*.]?\s*ч)"),
    ("pct", r"%"),
    ("permille", r"‰"),
    ("amp", r"(?-i:А)(?![а-яё])"),  # заглавная: союз «а» после числа — не амперы
    ("money", r"(?:тыс\.?\s*)?руб\w*"),
    ("min", r"мин\w*"),
    ("days", r"(?:дн\w*|сут\w*|дней)"),
    ("count", r"(?:шт\.?|чел\w*|мест\w*|ед\.)"),
)
_UNIT_AFTER = tuple((unit, re.compile(r"^\s*" + pattern, re.IGNORECASE)) for unit, pattern in UNITS)
_UNIT_IN_LABEL = tuple(
    (unit, re.compile(r"[,(\s]\s*" + pattern + r"\s*\)?\s*$", re.IGNORECASE), re.compile(r",\s*" + pattern, re.I))
    for unit, pattern in UNITS
)
_NUMBER = re.compile(r"(?<![\w.,/-])(\d{1,3}(?:[ \u00a0]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(?!\d)")
_CELL_NUMBER = re.compile(r"(\d{1,3}(?:[ \u00a0]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)\s*(\S{0,12})")
_YEAR = re.compile(r"^(19|20)\d\d$")
_LETTERS = re.compile(r"[а-яё]{3}", re.IGNORECASE)
#: Содержательное слово подписи (фильтр `generic`).
_WORD = re.compile(r"[а-яёa-z]{3,}", re.IGNORECASE)
#: Основа слова для стоп-списка: первые `STEM` букв слова длиной от четырёх.
STEM = 6
_STEM_WORD = re.compile(r"[а-яё]{4,}")
COUNT_UNITS = frozenset({"шт.", "шт", "ед.", "ед"})
#: Сколько последних слов подписи оставлять: дальше — чужой текст абзаца.
LABEL_WORDS = 14
#: Общая основа подписи с названием параметра для отсева до модели: первые `ROOT` букв слова.
ROOT = 4
_ROOT_WORD = re.compile(r"[а-яёa-z]{4,}", re.IGNORECASE)
#: Сколько эмбеддингов подписей помнить на процесс: 50 тыс. × 384 × 4 байта ≈ 77 МБ.
MAX_CACHED_LABELS = 50_000
#: Подписи кодируются пачками, и перед каждой проверяется бюджет: один большой документ (чертежи ПД на сотни
#: листов) кодировался почти 4 минуты, и проверка бюджета только между документами его не останавливала.
#: Пачка на процессоре — около 2 с, это и есть предел перерасхода.
ENCODE_CHUNK = 256


@dataclass(frozen=True)
class Candidate:
    """Число с единицей и подписью перед ним — кандидат в значение какого-нибудь параметра."""

    label: str
    raw: str
    unit: str | None
    page: int
    bbox: list[float]
    snippet: str


def candidates(page: dict[str, Any]) -> list[Candidate]:
    """Кандидаты «подпись → число с единицей» со страницы: фразы текстовых блоков и строки таблиц.

    Штамп листа (`title_block`) не берётся: там номера листов, даты и шифры.
    """
    page_number = int(page.get("page") or 0)
    found: list[Candidate] = []
    for block in page.get("blocks") or []:
        if block.get("type") == "title_block" or not block.get("bbox"):
            continue
        text = collapse(block.get("text") or "")
        for match in _NUMBER.finditer(text):
            raw = match.group(1)
            if _YEAR.match(raw):
                continue
            head = text[max(0, match.start() - 160) : match.start()]
            cut = max(head.rfind(". "), head.rfind("; "), head.rfind("\n"))
            head = head[cut + 1 :] if cut >= 0 else head
            label = _label(head)
            if not _is_label(label):
                continue
            unit = unit_after(text[match.end() : match.end() + 16]) or unit_in_label(label)
            snippet = (head + text[match.start() : match.end() + 16])[-220:]
            found.append(Candidate(label, raw, unit, page_number, list(block["bbox"]), snippet))
    for row in bands(page_cells(page)):
        # Подпись числа — ячейки после предыдущего числа строки, единица — из них или из соседней справа. Раньше подпись
        # копилась с начала строки, а единица бралась из любой ячейки: «Площадь, м² | 1250 | Процент | 12 | %» давала
        # 12 как площадь.
        words: list[PageCell] = []
        for position, cell in enumerate(row):
            text = cell.text.strip()
            match = _CELL_NUMBER.fullmatch(text)
            if match is None or _YEAR.match(match.group(1)):
                words.append(cell)
                continue
            label = _label(" ".join(c.text.strip() for c in words))
            around = [*words, *row[position + 1 : position + 2]]
            words = []
            if not _is_label(label):
                continue
            unit = (
                (unit_after(match.group(2)) if match.group(2) else None)
                or unit_in_label(label)
                or next((unit_after(c.text) for c in around if len(c.text) <= 10 and unit_after(c.text)), None)
            )
            snippet = " | ".join(c.text for c in row)[:220]
            found.append(Candidate(label, match.group(1), unit, page_number, list(cell.bbox), snippet))
    return found


def unit_after(text: str) -> str | None:
    """Класс единицы в начале текста после числа: «м²», «куб. м/сут», «шт.»."""
    return next((unit for unit, pattern in _UNIT_AFTER if pattern.match(text)), None)


def unit_in_label(label: str) -> str | None:
    """Класс единицы в самой подписи: «Площадь застройки, м²», «Объём (куб. м)»."""
    return next((unit for unit, tail, comma in _UNIT_IN_LABEL if tail.search(label) or comma.search(label)), None)


def compatible(param_unit: str | None, unit: str | None) -> bool:
    """Подходит ли единица числа параметру. Длина — и в метрах, и в миллиметрах (пересчёт в `scale`)."""
    if param_unit is None:
        return unit is None
    if param_unit == "len":
        return unit in ("len", "len_mm")
    if param_unit == "count":
        return unit in ("count", None)
    return unit == param_unit


def scale(param_unit: str | None, unit: str | None) -> float:
    """Множитель к единице параметра: 600 мм при параметре в метрах — это 0,6."""
    base = (param_unit or "").strip()
    if base == "м" and unit == "len_mm":
        return 0.001
    if base == "мм" and unit == "len":
        return 1000.0
    return 1.0


def stems(text: str) -> set[str]:
    """Основы слов для стоп-списка: «Строительный объём» → {«строит», «объем»}."""
    return {word[:STEM] for word in _STEM_WORD.findall(text.lower().replace("ё", "е"))}


def roots(text: str) -> set[str]:
    """Короткие основы для отсева до модели: «Площадь застройки» → {«площ», «заст»}."""
    return {word[:ROOT] for word in _ROOT_WORD.findall(text.lower().replace("ё", "е"))}


def load_stops(path: Path = STOPS_FILE) -> frozenset[str]:
    """Стоп-основы из файла. Их учили только на обучающих объектах — как, написано в самом файле."""
    return frozenset(json.loads(path.read_text(encoding="utf-8"))["stops"])


def is_numeric(param: MatrixParam) -> bool:
    return str(getattr(param.data_type, "root", param.data_type)) == "number"


def queries(param: MatrixParam) -> list[str]:
    """Тексты, с которыми сравнивается подпись: название параметра и его якоря из матрицы."""
    anchors = param.semantic_anchors or []
    parts = anchors.split("|") if isinstance(anchors, str) else list(anchors)
    return list(dict.fromkeys(text.strip() for text in [param.parameter_name, *parts] if text and text.strip()))


def _label(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip(" :—–-=|;,.")
    return " ".join(text.split(" ")[-LABEL_WORDS:])


def _is_label(label: str) -> bool:
    return len(label) >= 4 and bool(_LETTERS.search(label))


class Encoder(Protocol):
    def __call__(self, texts: list[str]) -> np.ndarray:
        """Нормированные эмбеддинги текстов: строка матрицы на текст."""
        ...


#: Загруженные модели на процесс. Неудачная загрузка сюда не попадает: положили веса — следующая задача модель
#: найдёт без перезапуска ml.
_ENCODERS: dict[str, Encoder] = {}


def load_encoder(model: str) -> Encoder | None:
    """Модель Sentence-BERT на процессоре, один раз на процесс. `None` — пакета или весов нет.

    `model` — имя в кеше Hugging Face (`HF_HOME`) или путь к папке с весами. Грузится **только с диска**
    (`local_files_only`): в закрытом контуре задача сравнения не должна ходить на huggingface.co и виснуть на
    таймаутах, если весов в образе нет. В образ веса кладутся при сборке вызовом `SentenceTransformer(model,
    device="cpu")`, локально — той же командой из `docs/services/ml.md`.
    """
    if model in _ENCODERS:
        return _ENCODERS[model]
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        log.warning("sbert_unavailable", reason="нет пакета sentence-transformers: нужен extra embeddings")
        return None
    try:
        network = SentenceTransformer(model, device="cpu", local_files_only=True)
    except Exception as error:  # нет весов, битый кеш — всё это «модели нет», а не падение проверки
        log.warning("sbert_unavailable", model=model, reason=f"{type(error).__name__}: {error}")
        return None

    # в sentence-transformers 6 метод переименован, старое имя пишет FutureWarning
    size = getattr(network, "get_embedding_dimension", None) or network.get_sentence_embedding_dimension
    dimension = size() or 0
    cache: OrderedDict[str, np.ndarray] = OrderedDict()

    def encode(texts: list[str]) -> np.ndarray:
        fresh = [text for text in dict.fromkeys(texts) if text not in cache]
        if fresh:
            vectors = network.encode(
                fresh, batch_size=64, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False
            )
            cache.update(zip(fresh, np.asarray(vectors, dtype=np.float32), strict=True))
        result = np.stack([cache[text] for text in texts]) if texts else np.zeros((0, dimension), np.float32)
        for text in texts:
            cache.move_to_end(text)
        while len(cache) > MAX_CACHED_LABELS:
            cache.popitem(last=False)
        return result

    log.info("sbert_loaded", model=model)
    _ENCODERS[model] = encode
    return encode


class _Document(Protocol):
    @property
    def sha256(self) -> str: ...

    @property
    def stage(self) -> str: ...

    @property
    def pages(self) -> list[dict[str, Any]]: ...


@dataclass
class Fallback:
    """Запасной путь на одну задачу сравнения: параметры матрицы запроса, модель, память по документам.

    `params` — числовые параметры, которым запасной путь ищет значение. `rivals` — остальные параметры матрицы:
    значений им запасной путь не ищет, но подпись, которая ближе к названию такого параметра, числовым не
    достаётся. «Площадь застройки» ↔ «общая площадь здания» — 0,925, выше порога, и развести M-001 и M-002 может
    только это правило.
    """

    params: dict[str, MatrixParam]
    encode: Encoder
    rivals: dict[str, MatrixParam] = field(default_factory=dict)
    threshold: float = 0.9
    max_labels: int = 30_000
    budget_s: float = 1800.0
    stops: frozenset[str] = field(default_factory=load_stops)
    clock: Callable[[], float] = time.monotonic
    _memo: dict[str, dict[str, tuple[Found, float]]] = field(default_factory=dict, init=False, repr=False)
    _vectors: dict[str, np.ndarray] = field(default_factory=dict, init=False, repr=False)
    _labels: set[str] = field(default_factory=set, init=False, repr=False)
    _queries: np.ndarray = field(init=False, repr=False)
    _columns: dict[str, list[int]] = field(init=False, repr=False)
    _own: dict[str, set[str]] = field(init=False, repr=False)
    _roots: set[str] = field(init=False, repr=False)
    _spent: float = field(default=0.0, init=False)
    _stopped: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        """Эмбеддинги названий и якорей всех параметров — один раз на задачу."""
        texts: dict[str, int] = {}
        self._columns, self._own, self._roots = {}, {}, set()
        for code, param in {**self.rivals, **self.params}.items():
            own = queries(param)
            if not own:
                continue
            self._columns[code] = [texts.setdefault(text, len(texts)) for text in own]
            if code in self.params:
                self._own[code] = stems(" ".join(own))
                self._roots |= roots(" ".join(own))
        self._queries = self.encode(list(texts))

    @classmethod
    def create(cls, params: Iterable[MatrixParam], settings: Settings, *, keyed: Iterable[str] = ()) -> Fallback | None:
        """Запасной путь для матрицы запроса или `None`: выключен, нет числовых параметров, нет модели.

        `keyed` — параметры, чей свой разбор ставит ключ места (помещение, конструкция, выпуск): значение без
        ключа с их точками не сводится, поэтому им запасной путь значений не ищет, но они остаются соперниками.
        """
        if not settings.sbert_enabled:
            return None
        active = [p for p in params if p.is_active is not False]
        skip = set(keyed)
        numeric = {p.code: p for p in active if is_numeric(p) and p.code not in skip}
        if not numeric:
            return None
        encode = load_encoder(settings.embedding_model)
        if encode is None:
            return None
        return cls(
            params=numeric,
            encode=encode,
            rivals={p.code: p for p in active if p.code not in numeric},
            threshold=settings.sbert_threshold,
            max_labels=settings.sbert_max_labels,
            budget_s=settings.sbert_budget_s,
        )

    def applies(self, param: MatrixParam) -> bool:
        return param.code in self.params

    def best(self, param: MatrixParam, docs: Sequence[_Document]) -> tuple[_Document, Found] | None:
        """Одно значение параметра по смыслу на группу документов (стадию) — самое близкое, или `None`.

        Одно, а не по значению на документ: несколько разных чисел в стадии движок превратил бы в «требуется
        уточнение» вместо сравнения. При равной близости — документ, который идёт раньше.
        """
        if param.code not in self.params:
            return None
        chosen: tuple[_Document, Found, float] | None = None
        for doc in docs:
            if doc.stage not in STAGES:
                continue
            pick = self._picks(doc).get(param.code)
            if pick is not None and (chosen is None or pick[1] > chosen[2]):
                chosen = (doc, pick[0], pick[1])
        return (chosen[0], chosen[1]) if chosen is not None else None

    def find(self, param: MatrixParam, doc: _Document) -> list[Found]:
        """Значение параметра в одном документе по смыслу — или пусто."""
        pick = self.best(param, [doc])
        return [pick[1]] if pick is not None else []

    def _picks(self, doc: _Document) -> dict[str, tuple[Found, float]]:
        picks = self._memo.get(doc.sha256)
        if picks is not None:
            return picks
        if self._spent >= self.budget_s:
            self._stop("sbert_budget_exhausted", budget_s=self.budget_s)
        if self._stopped:
            return {}
        started = self.clock()
        picks = self._document(doc.pages, deadline=started + self.budget_s - self._spent)
        self._spent += self.clock() - started
        self._memo[doc.sha256] = picks
        return picks

    def _stop(self, event: str, **details: Any) -> None:
        if not self._stopped:
            self._stopped = True
            log.warning(event, documents=len(self._memo), labels=len(self._labels), **details)

    def _document(self, pages: list[dict[str, Any]], deadline: float = float("inf")) -> dict[str, tuple[Found, float]]:
        """Значение каждого числового параметра в документе после всех проверок, с его близостью.

        Лимиты: `max_labels` — сколько разных подписей задача вообще кодирует, в порядке документов запроса. Он
        детерминированный: пересчёт того же комплекта даёт те же значения, тёплый ли кеш и занят ли процессор.
        Бюджет по часам (`budget_s`) — только аварийный: проверяется перед каждой пачкой подписей. Документ, на
        котором лимит кончился, идёт без Sentence-BERT целиком, а не частично.
        """
        found = [candidate for page in pages for candidate in candidates(page) if self._worth(candidate.label)]
        if not found or not self.params:
            return {}
        labels = list(dict.fromkeys(c.label for c in found))
        new = [label for label in labels if label not in self._labels]
        if len(self._labels) + len(new) > self.max_labels:
            self._stop("sbert_labels_exhausted", max_labels=self.max_labels)
            return {}
        self._labels.update(new)
        fresh = [label for label in labels if label not in self._vectors]
        for start in range(0, len(fresh), ENCODE_CHUNK):
            if self.clock() >= deadline:
                self._stop("sbert_budget_exhausted", budget_s=self.budget_s)
                return {}
            part = fresh[start : start + ENCODE_CHUNK]
            self._vectors.update(zip(part, self.encode(part), strict=True))
        similarity = np.stack([self._vectors[c.label] for c in found]) @ self._queries.T
        codes = list(self._columns)
        closeness = np.stack([similarity[:, self._columns[code]].max(axis=1) for code in codes], axis=1)
        # одна подпись — один параметр: подпись достаётся параметру матрицы, к которому она ближе всего, даже если
        # тот в документе уже нашли правила; проигравший параметр берёт следующего кандидата
        owner = closeness.argmax(axis=1)

        picks: dict[str, tuple[Found, float]] = {}
        for code, param in self.params.items():
            column = codes.index(code)
            for index in np.argsort(-closeness[:, column], kind="stable"):
                score = float(closeness[index, column])
                if score < self.threshold:
                    break
                if owner[index] != column:
                    continue
                value = self._accept(param, found[index])
                if value is not None:
                    picks[code] = (self._found(param, found[index], value, score), score)
                    break
        return picks

    def _worth(self, label: str) -> bool:
        """Стоит ли подпись кодирования: не меньше двух содержательных слов (`generic` — «этаж», «Площадь»:
        номера строк и листов) и общая основа хотя бы с одним параметром."""
        return len(_WORD.findall(label)) >= 2 and bool(roots(label) & self._roots)

    def _accept(self, param: MatrixParam, candidate: Candidate) -> float | None:
        """Значение в единицах параметра, если кандидат проходит фильтры параметра, иначе `None`."""
        unit_class = UNIT_CLASS.get((param.unit or "").strip())
        if not compatible(unit_class, candidate.unit):
            return None
        raw = number(candidate.raw)
        if raw is None:
            return None
        value = raw * scale(param.unit, candidate.unit)
        if (param.min_value is not None and value < param.min_value) or (
            param.max_value is not None and value > param.max_value
        ):
            return None  # range — вне пределов матрицы
        if (param.unit or "").strip() in COUNT_UNITS and value != int(value):
            return None  # integer — дробное число у счётного параметра
        if (stems(candidate.label) - self._own[param.code]) & self.stops:
            return None  # stops — уточнение, меняющее смысл: «сносимого», «существующего», «подземной части»
        return value

    def _found(self, param: MatrixParam, candidate: Candidate, value: float, score: float) -> Found:
        log.debug("sbert_value", param=param.code, label=candidate.label, raw=candidate.raw, score=round(score, 3))
        return Found(
            rule_key=None,
            raw_value=candidate.raw,
            value=round(value, 6),
            page=candidate.page,
            bbox=candidate.bbox,
            snippet=candidate.snippet,
            unit=param.unit,
            method=METHOD,
        )
