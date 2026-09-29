"""Организация-разработчик документа — по основной надписи и титулу (ПД и РД).

По ГОСТ Р 21.101 наименование организации, выпустившей документ, стоит в графе 9 основной
надписи — отдельной строкой: «ООО «ГЕНПРОЕКТ»». На титульном листе оно вверху
(«Общество с ограниченной ответственностью «Моспроекткомплекс»»), а внизу подпись
«Генеральный директор ООО «Моспроекткомплекс» …».

Берём только упоминания, у которых перед организацией в строке **ничего нет** или стоит роль
разработчика («Разработчик», «Генеральный проектировщик», «Генеральный директор», «ГИП»).
Отсекаются:

- заказчик, застройщик, «Согласовано», подрядчики — это не разработчик;
- «© ГБУ «Мосгоргеотрест»» на чертежах ПЗУ — правообладатель топоосновы;
- упоминания внутри текста («по проекту, разработанному ООО …», «4.2. АО … имеет право»);
- «ИП» без названия в кавычках — в тексте это чаще «измерительный прибор», чем предприниматель.

Для **ИД** поле не заполняется: в актах несколько организаций в разных ролях (застройщик,
строительный контроль, лицо, осуществляющее строительство), графы 9 нет, и «разработчик»
был бы нашей догадкой. Фамилии подписантов не сохраняются (152-ФЗ): из строки берётся только
правовая форма и название.
"""

from __future__ import annotations

import re
from collections import Counter
from typing import Any

from inspector_ml.layout.title_block import page_text, title_block_text

#: Полное наименование правовой формы → сокращение, под которым выдаём.
FULL_FORMS = {
    "общество с ограниченной ответственностью": "ООО",
    "публичное акционерное общество": "ПАО",
    "открытое акционерное общество": "ОАО",
    "закрытое акционерное общество": "ЗАО",
    "акционерное общество": "АО",
    "федеральное государственное унитарное предприятие": "ФГУП",
    "государственное унитарное предприятие": "ГУП",
    "государственное бюджетное учреждение": "ГБУ",
    "государственное автономное учреждение": "ГАУ",
    "государственное казённое учреждение": "ГКУ",
    "государственное казенное учреждение": "ГКУ",
    "муниципальное унитарное предприятие": "МУП",
    "автономная некоммерческая организация": "АНО",
}
SHORT_FORMS = ("ООО", "ПАО", "ОАО", "ЗАО", "АО", "ФГУП", "ФГБУ", "ГУП", "ГБУ", "ГАУ", "ГКУ", "МУП", "МБУ", "АНО", "ИП")
_FULL = "|".join(sorted((re.escape(form) for form in FULL_FORMS), key=len, reverse=True))
_SHORT = "|".join(SHORT_FORMS)
QUOTES = "«»\"“”„″'*"
# Полные формы — в любом регистре, сокращения — только заглавными: «гуп «Мосводосток» или по его
# указанию» — это перенос строки в тексте пояснительной записки, а не графа штампа.
FORM_RE = re.compile(rf"(?<![А-ЯЁа-яё])(?P<form>(?i:{_FULL})|{_SHORT})(?![А-ЯЁа-яё])")
#: Роли, после которых стоит не разработчик.
FOREIGN_ROLE = re.compile(
    r"заказчик|застройщик|согласовано|подрядчик|инвестор|строительн\w* контрол|лицо,? осуществляющ|"
    r"выполнен|разработанн|утвержд|владел|собственник|арендатор|эксплуатир|поставщик|изготовител",
    re.IGNORECASE,
)
#: Роли разработчика — после них организация наша.
OWN_ROLE = re.compile(
    r"^(?:разработчик|разработано|проектная организация|генеральный проектировщик|проектировщик|"
    r"генеральный директор|директор|главный инженер(?: проекта)?|гип)\b[\s:.,\-–—]*",
    re.IGNORECASE,
)
#: Роль в конце предыдущей строки: «Заказчик:» / «ООО «Апсайд Инжиниринг»».
# «В ПРОИЗВОДСТВО РАБОТ» — штамп заказчика или стройконтроля на выданном в работу листе (Приказ 344/пр)
FOREIGN_ROLE_ABOVE = re.compile(
    r"(?:заказчик|застройщик|согласовано|подрядчик|инвестор|в\s+производство\s+работ)\W*$", re.IGNORECASE
)
#: Подпись роли строкой ниже, как в штампе топоплана: «АНО «РСИ»» / «Заказчик:».
FOREIGN_ROLE_BELOW = re.compile(r"^\W*(?:заказчик|застройщик|подрядчик|инвестор)", re.IGNORECASE)
#: Штамп топографической подосновы: «Масштаб 1:500» / «ООО «Планета Изысканий»» — это изыскатель.
SURVEY_ABOVE = re.compile(r"^\W*масштаб(?![А-ЯЁа-яё])", re.IGNORECASE)
#: «СЗ …» — специализированный застройщик: это заказчик, а не проектировщик.
CUSTOMER_NAME = re.compile(r"«\s*(?:[СC][З3]|Специализированный застройщик)(?![А-ЯЁа-яё])", re.IGNORECASE)
#: После названия в строке допустимы только реквизиты — иначе это фраза текста, а не графа штампа.
REQUISITES = re.compile(r"(?:ОГРН|ИНН|КПП|СРО|тел|\d{6},)", re.IGNORECASE)
#: Где название заканчивается, если нет закрывающей кавычки: реквизиты, адрес, скобки.
NAME_END = re.compile(r",|\s(?:ОГРН|ИНН|КПП|СРО|г\.|тел)|\(|\s{2,}", re.IGNORECASE)
MIN_NAME = 2
#: Столько отдельных букв подряд — название набрано вразрядку.
MIN_SPACED = 3
MAX_NAME = 60
#: Род деятельности между правовой формой и названием: «ПРОЕКТНАЯ КОМПАНИЯ», «Научно-производственное
#: предприятие» — до трёх слов с заглавной буквы.
DESCRIPTOR = re.compile(r"[А-ЯЁ][А-ЯЁа-яё\-]+(?:\s+[А-ЯЁа-яё\-]+){0,2}")
DESCRIBED_NAME = re.compile(rf"(?P<descriptor>{DESCRIPTOR.pattern})\s+(?P<quoted>[{re.escape(QUOTES)}].*)")
#: Название без кавычек принимаем, только если строка — одна организация: «ООО Апсайд Инжиниринг».
MAX_BARE_WORDS = 4
#: Сколько первых листов считаем титулом.
COVER_PAGES = 3
#: На скольких листах организация должна стоять в штампе, чтобы быть графой 9, а не бланком письма.
MIN_STAMP_PAGES = 2


def developer_org(pages: list[dict[str, Any]], stage: str | None) -> tuple[str | None, float]:
    """Организация-разработчик и уверенность. Для ИД и без находок — `(None, 0.0)`.

    **Штамп важнее титула.** На титуле тома часто стоит генеральный проектировщик
    («БратКом-групп»), а том выпустил субподрядчик — его и называет графа 9 («ТСП»).
    Но графа 9 повторяется на многих листах, поэтому из штампа берётся организация, которая
    стоит **хотя бы на двух листах**: в приложения пояснительных записок вшиты письма
    с техническими условиями и сертификаты, и на их бланке организация («АО «ОЭК»»,
    «ЗАО «Рувинил»») тоже стоит отдельной строкой внизу справа — но на одном листе.
    Штамп и титул совпали — уверенность выше; штамп обрезан переносом — берётся полное
    название с титула.
    """
    if stage == "ID":
        return None, 0.0
    stamp_orgs = [organizations(title_block_text(page)) for page in pages]
    cover_orgs = [organizations(page_text(page)) for page in pages[:COVER_PAGES]]
    stamp = _ranked(stamp_orgs)
    cover_name = _cover_org(cover_orgs)
    if stamp and stamp[1] >= MIN_STAMP_PAGES:
        name, confidence = stamp[0], 0.9 if cover_name and _same(stamp[0], cover_name) else 0.8
    elif cover_name:
        name, confidence = cover_name, 0.9 if stamp and _same(stamp[0], cover_name) else 0.6
    elif stamp:
        name, confidence = stamp[0], 0.5
    else:
        return None, 0.0
    # название, обрезанное переносом в штампе, — полным, если оно встретилось где-то целиком
    seen = [org for orgs in (*stamp_orgs, *cover_orgs) for org in orgs if _same(org, name)]
    return max(seen, key=len, default=name), confidence


def _cover_org(cover: list[list[str]]) -> str | None:
    """Организация с титула — с **последнего** титульного листа, где она есть.

    Том субподрядчика открывается титулом генерального проектировщика («БратКом-групп»,
    листы 1–2), а за ним идёт титул того, кто том выпустил («Технологии строительного
    проектирования», лист 3). Чем ближе к содержанию, тем вернее.
    """
    for orgs in reversed(cover):
        found = _ranked([orgs])
        if found:
            return found[0]
    return None


def _same(first: str, second: str) -> bool:
    """Одна организация: совпадают без учёта регистра и кавычек или одна обрезана переносом."""
    a, b = _key(first), _key(second)
    shorter, longer = sorted((a, b), key=len)
    return a == b or (len(shorter) >= MIN_PREFIX and longer.startswith(shorter))


def organizations(text: str) -> list[str]:
    """Организации-разработчики, упомянутые в тексте, в каноническом виде: «ООО «ГЕНПРОЕКТ»»."""
    found: list[str] = []
    lines = _joined_lines(text)
    for index, line in enumerate(lines):
        previous = lines[index - 1] if index else ""
        following = lines[index + 1] if index + 1 < len(lines) else ""
        foreign_around = (
            FOREIGN_ROLE_ABOVE.search(previous) or SURVEY_ABOVE.search(previous) or FOREIGN_ROLE_BELOW.search(following)
        )
        for match in FORM_RE.finditer(line):
            prefix = line[: match.start()]
            if (foreign_around and not prefix.strip()) or not _own_prefix(prefix):
                continue
            parsed = _name(line[match.end() :])
            if parsed is None:
                continue
            name, tail = parsed
            if not _tail_ok(tail, signed=bool(prefix.strip())) or CUSTOMER_NAME.match(name):
                continue
            form = match.group("form")
            short = FULL_FORMS.get(form.casefold(), form)
            if short == "ИП":
                # у индивидуального предпринимателя название — фамилия человека (152-ФЗ)
                found.append("ИП")
            else:
                found.append(f"{short} {name}")
            break  # одна организация на строку: дальше в строке — реквизиты или другая роль
    return found


def _joined_lines(text: str) -> list[str]:
    """Строки текста, где название организации, перенесённое на следующую строку, склеено.

    Переносы, которые встречаются в штампах и на титулах: правовая форма в конце строки
    («Общество с ограниченной ответственностью» / «"СТАНДАРТПРОЕКТ"»), незакрытая кавычка
    («ООО «Архитектурный Диалог» / «с Мегаполисом»») и род деятельности отдельной строкой
    между формой и названием («ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ» / «ПРОЕКТНАЯ КОМПАНИЯ» /
    ««ГЕОСТРОЙПРОЕКТ»»).
    """
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    joined: list[str] = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if index + 2 < len(lines) and _descriptor_between(line, lines[index + 1], lines[index + 2]):
            line = f"{line} {lines[index + 1]} {lines[index + 2]}"
            index += 2
        elif index + 1 < len(lines) and _continues(line, lines[index + 1]):
            line = f"{line} {lines[index + 1]}"
            index += 1
        joined.append(line)
        index += 1
    return joined


def _descriptor_between(line: str, middle: str, following: str) -> bool:
    """Форма в конце строки, затем род деятельности заглавными, затем название в кавычках."""
    matches = list(FORM_RE.finditer(line))
    return (
        bool(matches)
        and not line[matches[-1].end() :].strip()
        and DESCRIPTOR.fullmatch(middle) is not None
        and following[:1] in QUOTES
    )


def _continues(line: str, following: str) -> bool:
    """Продолжается ли название организации из `line` в `following`."""
    matches = list(FORM_RE.finditer(line))
    if not matches:
        return False
    tail = line[matches[-1].end() :].strip()
    if not tail:
        return following[:1] in QUOTES
    if tail[0] not in QUOTES or _closing(tail[1:]) is not None:
        return False
    return any(char in following[:MAX_NAME] for char in "»\"“”″")


def _own_prefix(prefix: str) -> bool:
    """Перед организацией пусто или роль разработчика — и нет чужой роли."""
    prefix = prefix.strip(" \t-–—•:.,;")
    if not prefix:
        return True
    if prefix.startswith("©") or FOREIGN_ROLE.search(prefix):
        return False
    return OWN_ROLE.match(prefix) is not None and not OWN_ROLE.sub("", prefix).strip()


def _name(rest: str) -> tuple[str, str] | None:
    """Название после правовой формы и то, что в строке идёт за ним.

    Название — в кавычках или, если кавычек нет, несколько слов с заглавной до реквизитов.
    """
    rest = rest.strip()
    if not rest:
        return None
    if rest[0] in QUOTES:
        body = rest[1:]
        end = _closing(body)
        if end is not None:
            name, tail = body[:end].strip(), body[end + 1 :]
        else:  # закрывающую кавычку OCR потерял: до реквизитов или конца строки
            parts = NAME_END.split(body, maxsplit=1)
            name, tail = parts[0].strip(" " + QUOTES), body[len(parts[0]) :]
        if not MIN_NAME <= len(name) <= MAX_NAME or not re.search(r"[А-ЯЁA-Z]", name):
            return None
        return f"«{_balanced(_guillemets(_unspaced(name)))}»", tail
    described = DESCRIBED_NAME.match(rest)
    if described:  # «ПРОЕКТНАЯ КОМПАНИЯ «ГЕОСТРОЙПРОЕКТ»» — род деятельности, затем название
        inner = _name(described.group("quoted"))
        if inner is not None:
            return f"«{described.group('descriptor')} {inner[0]}»", inner[1]
    # без кавычек: вся строка — название из нескольких слов с заглавной
    head = NAME_END.split(rest, maxsplit=1)[0]
    words = head.split()
    if 1 <= len(words) <= MAX_BARE_WORDS and all(word[:1].isupper() for word in words):
        return f"«{_balanced(' '.join(words).strip(QUOTES))}»", rest[len(head) :]
    return None


def _tail_ok(tail: str, *, signed: bool) -> bool:
    """За названием — ничего, реквизиты или (после «Генеральный директор …») фамилия подписанта."""
    tail = tail.strip(" .,;:" + QUOTES)
    return not tail or signed or REQUISITES.match(tail) is not None


def _closing(body: str) -> int | None:
    """Где закрывается кавычка названия; вложенные «…» учитываются."""
    depth = 0
    for index, char in enumerate(body):
        if char == "«":
            depth += 1
        elif char in "»\"“”″*'":
            if depth == 0:
                return index
            depth -= 1
    return None


def _balanced(name: str) -> str:
    """Внутренние кавычки парами: лишнюю закрывающую убрать, недостающую дописать.

    OCR теряет то открывающую («ГАУ Институт Генплана Москвы»»), то закрывающую кавычку
    («СЗ «Апсайд Новослободская»).
    """
    while name.count("»") > name.count("«") and name.endswith("»"):
        name = name[:-1].rstrip()
    return name + "»" * (name.count("«") - name.count("»"))


def _unspaced(name: str) -> str:
    """Название, набранное вразрядку («В Е Л Е С»), — слитно."""
    letters = name.split()
    return "".join(letters) if len(letters) >= MIN_SPACED and all(len(letter) == 1 for letter in letters) else name


def _guillemets(name: str) -> str:
    """Внутренние прямые и «лапки» — ёлочками, по очереди открывающая и закрывающая."""
    result: list[str] = []
    opened = False
    for char in name:
        if char in "\"“”„″":
            result.append("»" if opened else "«")
            opened = not opened
        else:
            result.append(char)
    return "".join(result)


def _key(org: str) -> str:
    return re.sub(r"[«»\s]", "", org).casefold()


#: Обрезанное название засчитывается полному, если совпадает с его началом хотя бы на столько символов.
MIN_PREFIX = 8


def _ranked(per_page: list[list[str]]) -> tuple[str, int] | None:
    """Организация, которая встречается на наибольшем числе листов, и это число.

    При равенстве — та, что встретилась раньше.

    Написания, различающиеся регистром и кавычками, — одна организация. Название, обрезанное
    переносом строки («ООО «Архитектурный Диалог с»»), засчитывается полному, которое с него
    начинается, и выдаётся полное.
    """
    by_key: dict[str, Counter[str]] = {}  # порядок ключей — порядок появления
    for orgs in per_page:
        for org in dict.fromkeys(orgs):  # лист считается один раз
            by_key.setdefault(_key(org), Counter())[org] += 1
    if not by_key:
        return None
    keys = sorted(by_key, key=len, reverse=True)
    pages: Counter[str] = Counter()
    for key in keys:
        # самое длинное название, которое начинается с этого, — первое в списке по убыванию длины
        full = next((other for other in keys if other != key and len(key) >= MIN_PREFIX and other.startswith(key)), key)
        pages[full] += sum(by_key[key].values())
    order = {key: index for index, key in enumerate(by_key)}
    best = max(pages, key=lambda key: (pages[key], -order[key]))
    return by_key[best].most_common(1)[0][0], pages[best]
