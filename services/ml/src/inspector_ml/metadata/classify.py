"""Шифр документа, стадия и марка раздела (REQ-PRS-08).

Значения берутся из основной надписи, при неудаче — из нижней полосы листа и текста страницы.
Ничего не выдумываем: если поле не нашлось, оно остаётся `None`, и api возьмёт значение из реестра.
"""

from __future__ import annotations

import re
from itertools import pairwise

# Марки разделов из матрицы и «Перечня ИД». Порядок важен: длинные коды проверяются первыми.
DISCIPLINES = (
    "СПОЗУ",
    "ПЗУ",
    "ЭОМ",
    "НВК",
    "АТХ",
    "ООС",
    "ПОС",
    "ПОД",
    "ППМ",
    "ОДИ",
    "ИОС",
    "АР",
    "АС",
    "КР",
    "КЖ",
    "КМ",
    "ОВ",
    "ВК",
    "ЭС",
    "СС",
    "ГП",
    "ПБ",
    "ПЗ",
    "ТХ",
    "СМ",
    "ЗУ",
)

# Шифр: группы из букв и цифр через «-», «.» или «_», хотя бы одна цифра, например
# «П-2025-04.266-АР», «01-07.22-14-П-ПЗУ-кор.3», «ЖС-РД-270121-П-АР», «РД-2025-04-266-АР2».
DOCUMENT_CODE_RE = re.compile(r"\b[A-ZА-Я0-9]{1,8}(?:[-._][A-ZА-Я0-9]{1,8}){2,}\b", re.IGNORECASE)
STAGE_FIELD_RE = re.compile(r"Стади[яи][\s:]*([А-Я]{1,2})\b", re.IGNORECASE)
MARK_FIELD_RE = re.compile(r"Марка(?:\s+документа)?[\s:]*([А-Я]{2,6})\b", re.IGNORECASE)

# Марки, которые нельзя искать в свободном тексте: слишком короткие и встречаются как обычные слова
# («ПЗ» в «пояснительной записке», «СС» внутри шифра). Их берём только из шифра, имени файла
# или поля «Марка» — иначе том ПД уезжает в чужой раздел.
AMBIGUOUS = frozenset({"ПЗ", "СС", "ГП", "ПБ", "ТХ", "СМ", "ЗУ", "АС", "КМ", "ЭС"})

# Признаки исполнительной документации: акты, журналы, исполнительные схемы.
ID_MARKERS = (
    "акт освидетельствования",
    "аоср",
    "исполнительная схема",
    "исполнительная геодезическая",
    "общий журнал работ",
    "журнал бетонных работ",
    "паспорт качества",
    "реестр исполнительной",
)
RD_MARKERS = ("рабочая документация", "рабочие чертежи", "основной комплект")
PD_MARKERS = ("проектная документация", "раздел проектной документации")


def _has(text: str, markers: tuple[str, ...]) -> bool:
    lowered = text.lower()
    return any(marker in lowered for marker in markers)


def document_code(text: str) -> str | None:
    """Самый длинный кандидат в шифр: у шифров всегда несколько групп и цифры."""
    best: str | None = None
    for match in DOCUMENT_CODE_RE.finditer(text):
        value = match.group(0).strip(" .,;")
        if not any(ch.isdigit() for ch in value) or len(value) < 8:
            continue
        # даты и номера телефонов — не шифры
        if re.fullmatch(r"[\d.\-_]+", value):
            continue
        if best is None or len(value) > len(best):
            best = value
    return best


def _mark_from_tokens(value: str) -> str | None:
    """Марка из шифра или имени файла: «НВС-2025.03-4.3-КР3» → КР.

    Из нескольких совпадений берём самое длинное: в шифре «22-14-П-ПЗУ-ПЗ-кор» есть и «ПЗУ», и «ПЗ»,
    и правильный ответ — ПЗУ.
    """
    found = [
        candidate
        for part in re.split(r"[-._\s]", value)
        if (candidate := re.sub(r"\d+$", "", part).upper()) in DISCIPLINES
    ]
    return max(found, key=len) if found else None


def discipline(text: str, code: str | None = None, file_name: str | None = None) -> str | None:
    """Марка раздела: шифр, имя файла, поле «Марка» — и только потом свободный текст."""
    for source in (code, file_name):
        if source:
            mark = _mark_from_tokens(source)
            if mark:
                return mark

    field = MARK_FIELD_RE.search(text)
    if field and field.group(1).upper() in DISCIPLINES:
        return field.group(1).upper()

    upper = text.upper()
    for mark in DISCIPLINES:
        if mark not in AMBIGUOUS and re.search(rf"\b{mark}\b", upper):
            return mark
    return None


def _count(text: str, markers: tuple[str, ...]) -> int:
    lowered = text.lower()
    return sum(lowered.count(marker) for marker in markers)


#: Имя акта ИД: «АОСР №1.1_П от 05.06.2026», «АООК №3», «Акт …», «Исполнительная схема …».
ACT_NAME_RE = re.compile(r"^\s*(?:АОСР|АООК|АОУСИТО|акт|исполнительн)", re.IGNORECASE)
#: Буквы стадии в шифре и имени файла.
STAGE_TOKENS = {"П": "PD", "ПД": "PD", "Р": "RD", "РД": "RD"}


def doc_stage(text: str, code: str | None = None, file_name: str | None = None) -> str | None:
    """Стадия: ПД, РД или ИД.

    Порядок — от надёжного к косвенному (замер 25.09 на обучающих объектах: папка стадии против
    классификатора, 213 верных из 259 до правки):

    1. поле «Стадия» в основной надписи;
    2. имя акта («АОСР №1.1_П …») — ИД, хотя в имени и стоит «П»;
    3. буква стадии **прямо перед маркой** в шифре или имени: «ЖС-РД-270121-**П-ИОС**5.1» — ПД.
       «РД» в начале этого шифра — часть номера проекта, и прежнее правило «есть РД — значит РД»
       отправляло в РД весь ПД Алтуфьевского 2024 года;
    4. признаки ИД в тексте — не одно упоминание акта, а два и больше;
    5. перевес признаков РД или ПД в тексте, а не «кто проверен первым»: том ПД, где сказано про
       «основной комплект» рабочих чертежей, оставался бы РД;
    6. одиночная буква стадии в шифре или имени («РД-2025-04-266-АР2») — последней: «П-2025-04-266»
       бывает номером проекта и у рабочей документации.
    """
    field = STAGE_FIELD_RE.search(text)
    if field:
        value = field.group(1).upper()
        if value in {"П", "ПД"}:
            return "PD"
        if value in {"Р", "РД"}:
            return "RD"

    if any(source and ACT_NAME_RE.match(source) for source in (file_name, code)):
        return "ID"

    for source in (code, file_name):
        if stage := _stage_before_mark(source):
            return stage

    # Отдельные упоминания актов ещё не делают том исполнительной документацией
    if _count(text, ID_MARKERS) >= 2:
        return "ID"
    rd, pd = _count(text, RD_MARKERS), _count(text, PD_MARKERS)
    if rd != pd:
        return "RD" if rd > pd else "PD"

    for source in (code, file_name):
        if stage := _stage_token(source):
            return stage

    if rd:  # поровну и не ноль: как раньше, рабочая документация
        return "RD"
    if _has(text, ID_MARKERS):
        return "ID"
    return None


def _tokens(source: str | None) -> list[str]:
    return [p.upper() for p in re.split(r"[-._\s]", source or "") if p]


def _stage_before_mark(source: str | None) -> str | None:
    """Стадия, за которой сразу идёт марка раздела: «П-ИОС5.1», «Р-АР», «РД-КЖ0»."""
    parts = _tokens(source)
    for token, following in pairwise(parts):
        if token in STAGE_TOKENS and re.sub(r"\d+$", "", following) in DISCIPLINES:
            return STAGE_TOKENS[token]
    return None


def _stage_token(source: str | None) -> str | None:
    """Любая буква стадии в шифре или имени; «Р» и «РД» — первыми, как было."""
    parts = _tokens(source)
    if "РД" in parts or "Р" in parts:
        return "RD"
    if "П" in parts or "ПД" in parts:
        return "PD"
    return None


def doc_kind(text: str, stage: str | None) -> str | None:
    """Вид документа — человекочитаемая подпись для интерфейса."""
    lowered = text.lower()
    if "акт освидетельствования" in lowered or "аоср" in lowered:
        return "Акт освидетельствования скрытых работ"
    if "общий журнал работ" in lowered:
        return "Общий журнал работ"
    if "исполнительная схема" in lowered:
        return "Исполнительная схема"
    if stage == "RD":
        return "Основной комплект рабочих чертежей"
    if stage == "PD":
        return "Раздел проектной документации"
    return None
