"""Свободный поиск расхождений ПД ↔ РД языковой моделью (`SEMANTIC_DISSONANCE`).

Зачем это вообще. В публичном эталоне организаторов четыре проверки из пятнадцати — это
`FREE-HEATING-001`: «в помещении по ПД предусмотрен отопительный прибор, в РД его нет».
Правилами такое не берётся: параметра под это в матрице нет и не будет, а сравнивать нужно
смысл двух описаний. Ещё шесть проверок — про конфигурацию приборов в помещениях.
Отсюда [ADR-0008](../../../../docs/adr/0008-llm-scope.md), которым правило «сначала правила,
потом модели» снято для свободного поиска.

**Результат — гипотеза, а не находка.** `CONFIRMED_VIOLATION` модель не ставит никогда
(REQ-CMP-05), статусы проверок матрицы не трогает: гипотезы живут рядом с ними. В интерфейсе
инспектор их решает и при желании превращает в кандидата — обвязка на стороне api и фронта
уже есть.

**Что отсеивается до протокола.** Ответ модели проходит через `llm/grounding.py`:
цитата обязана найтись в документе (иначе нет ни гипотезы, ни доказательства), а каждое число
из ответа — встретиться в переданных фрагментах. Не сошлось — гипотезу выбрасываем и пишем
в журнал, почему. Лучше промолчать, чем выдумать.

**Модель не может уронить прогон.** Выключена, не поднята, ответила мусором, не уложилась
в таймаут — возвращается пустой список.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Any

from inspector_ml.compare import pagepairs
from inspector_ml.compare.keys import rule_group, suspicion_key
from inspector_ml.config import Settings
from inspector_ml.contracts.events import EvidenceFragment, PagePairResult, SuspicionResult
from inspector_ml.extract.api import LoadedDocument
from inspector_ml.llm import grounding
from inspector_ml.llm.client import LlmClient
from inspector_ml.logging import get_logger

log = get_logger(__name__)

DISCOVERY_METHOD = "SEMANTIC_DISSONANCE"
DEFAULT_PRIORITY = "MEDIUM"
PRIORITIES = {"HIGH", "MEDIUM", "LOW"}

#: Потолок уверенности гипотезы. Модель не калибрована, и выдавать её «уверенность» за
#: вероятность нельзя — это предположение для человека. Если распознавание доказательства хуже
#: потолка, берём его: гипотеза не надёжнее текста, на котором стоит.
CEILING = 0.5

#: Сколько пар разделов отдаём модели за один прогон. Каждая пара — отдельный запрос на десятки
#: секунд, а комплект бывает из сотни документов; берём самые содержательные и на этом
#: останавливаемся, чтобы не превратить сравнение в ожидание модели.
MAX_SECTIONS = 3
#: Больше гипотез на раздел инспектор всё равно не разберёт, а модель охотно продолжает список.
MAX_HYPOTHESES = 5

SYSTEM = """Ты помогаешь инспектору строительного надзора сверять проектную документацию (ПД)
с рабочей (РД). Тебе дают два фрагмента текста одного и того же раздела: из ПД и из РД.

Найди расхождения по существу: что предусмотрено в ПД и отсутствует или изменено в РД.
Интересуют прежде всего помещения и их оснащение (отопительные приборы, вентиляция),
а также состав и характеристики решений.

Жёсткие правила:
1. Опирайся только на приведённый текст. Никаких сведений извне, никаких норм и СП.
2. Любое число в ответе перепиши из текста дословно. Не считай, не округляй, не додумывай.
3. Поле pd_quote — дословный кусок из текста ПД, не пересказ. От 12 символов.
4. Если расхождений не видно, верни пустой список. Пустой ответ — нормальный ответ.
5. Не больше пяти гипотез — самые существенные.

Ответ строго в JSON:
{"hypotheses": [{"subject": "...", "pd_quote": "...", "rd_quote": "...",
                 "description": "...", "priority": "HIGH|MEDIUM|LOW"}]}

subject — о чём речь, например «Помещение 1.09». rd_quote можно опустить, если в РД
подтверждающего текста нет. description — одно-два предложения на русском."""

#: Листы-чертежи (27.09). Доказательство FREE-HEATING-001 в публичном эталоне — план отопления,
#: лист 21 тома ИОС5.4 «Примера нарушений»: номера помещений и подписи приборов («тёплый пол»)
#: лежат в текстовом слое чертежа, а разделы выше чертежи не берут (`readable`) и до листа 99 тома
#: не доходят по бюджету символов. Поэтому отдельно сравниваем пары листов ПД ↔ РД: листы с
#: подписями оснащения, сопоставленные по общим номерам помещений. Раздел не сравниваем: в ПД
#: отопление — «ИОС5.4», в РД — «ОВ2.1».
MAX_SHEET_PAIRS = 3
#: Столько общих номеров помещений нужно, чтобы считать два листа планом одного и того же места.
MIN_SHARED_ROOMS = 3
#: Номер помещения на плане: «267», «012», «1.109». Числа из размеров и отметок сюда тоже попадут,
#: но пару листов решает пересечение множеств, и шум в нём не совпадает.
ROOM = re.compile(r"(?<![\d.,/-])(\d{1,2}\.\d{2,3}|\d{3})(?![\d/-]|[.,]\d)")
#: Насколько близко (в долях листа) подпись помещения должна стоять к подписи оснащения, чтобы помещение
#: считалось оснащённым. На листе 21 тома ИОС5.4 «Примера нарушений» регулятор «теплый пол» стоит в 0,04
#: от подписей «267, 270» и «271, 272».
NEAR = 0.1
#: Оснащение, ради которого свободный поиск и нужен (FREE-HEATING, IOS4-078/079).
EQUIPMENT = re.compile(
    r"отоп|радиатор|конвектор|т[её]пл\w*\s+пол|приточн|вытяжн|вентиляц|кондиционир|фанкойл|тепловентилятор",
    re.IGNORECASE,
)

#: Подпись прибора — якорь «оснащённого» помещения. Слова «отопление», «вентиляция» сюда не годятся: они
#: в заголовках и легендах по всему листу, и оснащёнными становились почти все помещения.
DEVICE = re.compile(
    r"радиатор|конвектор|т[её]пл\w*\W{0,3}пол|фанкойл|тепловентилятор|воздухонагреват|решетк|диффузор|клапан",
    re.IGNORECASE,
)
#: Инженерная система по шифру: раздел ПД 5.4 — это «ОВ» рабочей документации, 5.2 и 5.3 — «ВК», 5.1 — «ЭЛ».
#: Планы одного этажа в разных системах делят номера помещений, и без этого лист отопления ПД
#: сравнивался с планом водопровода РД.
PD_SYSTEM = {"1": "ЭЛ", "2": "ВК", "3": "ВК", "4": "ОВ", "5": "СС", "6": "ГС", "7": "ТХ"}
RD_SYSTEM = re.compile(r"(?<![А-ЯA-Z])(ОВ|OB|ОB|OВ|ВК|BK|ЭО|ЭМ|ЭС|ЭН|СС|ГС|ТХ)", re.IGNORECASE)
RD_ALIASES = {"OB": "ОВ", "ОB": "ОВ", "OВ": "ОВ", "BK": "ВК", "ЭО": "ЭЛ", "ЭМ": "ЭЛ", "ЭС": "ЭЛ", "ЭН": "ЭЛ"}

SYSTEM_SHEET = """Ты помогаешь инспектору строительного надзора сверять проектную документацию (ПД)
с рабочей (РД). Тебе дают подписи с двух листов-чертежей: план из ПД и план из РД того же места.
Подписи идут вперемешку, как лежат на листе: номера и названия помещений, марки приборов и систем.

Найди помещения, у которых в ПД есть отопительный прибор, тёплый пол или вентиляционное решение,
а в РД его нет или оно другое. Сравнивай только помещения, номера которых есть на обоих листах.

Жёсткие правила:
1. Опирайся только на приведённый текст. Никаких сведений извне, никаких норм и СП.
2. Любое число в ответе перепиши из текста дословно. Не считай, не округляй, не додумывай.
3. Поле pd_quote — дословный кусок подписей ПД, не пересказ. От 12 символов.
4. Если расхождений не видно, верни пустой список. Пустой ответ — нормальный ответ.
5. Не больше пяти гипотез — самые существенные.

Ответ строго в JSON:
{"hypotheses": [{"subject": "...", "pd_quote": "...", "rd_quote": "...",
                 "description": "...", "priority": "HIGH|MEDIUM|LOW"}]}

subject — «Помещение <номер с листа>». rd_quote можно опустить, если на листе РД подтверждающей подписи нет.
description — одно-два предложения на русском."""

Sheet = tuple[LoadedDocument, dict[str, Any]]


def run(
    docs: Sequence[LoadedDocument],
    settings: Settings,
    object_id: object,
    page_pairs: Sequence[PagePairResult] = (),
) -> list[SuspicionResult]:
    """Гипотезы по комплекту. Пустой список — это нормальный и самый частый ответ."""
    client = LlmClient.from_settings(settings)
    if client is None:
        log.debug("semantic_skipped", reason="LLM_ENABLED=false")
        return []

    found: list[SuspicionResult] = []
    seen: set[str] = set()
    batches = [
        *(_sheet(client, settings, pd, rd, object_id, page_pairs) for pd, rd in sheet_pairs(docs)[:MAX_SHEET_PAIRS]),
        *(_section(client, settings, pd, rd, object_id, page_pairs) for pd, rd in sections(docs)[:MAX_SECTIONS]),
    ]
    for batch in batches:
        for result in batch:
            if result.suspicion_key not in seen:
                seen.add(result.suspicion_key)
                found.append(result)
    log.info("semantic_done", hypotheses=len(found), model=settings.llm_model)
    return found


def sheet_pairs(docs: Sequence[LoadedDocument]) -> list[tuple[Sheet, Sheet]]:
    """Пары листов-чертежей «ПД — РД» с общими номерами помещений; на листе ПД — подписи оснащения.

    Оснащение требуем только от ПД: проверяем «в ПД прибор есть, в РД нет», и лист РД как раз может
    его не показывать. В «Примере нарушений» план отопления РД — линии без текста, а помещения 267–272
    есть в текстовом слое только на листе экспликации — он и есть доказательство РД в эталоне
    организаторов. Лист РД с подписями оснащения при прочих равных выше.

    Лучшие пары — с наибольшим числом общих помещений; каждый лист — не больше чем в одной паре.
    Одинаковые по тексту листы не берём: сравнивать там нечего.
    """
    pd_sheets = _room_sheets(docs, "PD", need_equipment=True)
    rd_sheets = _room_sheets(docs, "RD", need_equipment=False)
    scored: list[tuple[int, float, int, int]] = []
    for i, (pd, _pd_page, pd_rooms, pd_text) in enumerate(pd_sheets):
        for j, (rd, _rd_page, rd_rooms, rd_text) in enumerate(rd_sheets):
            shared = len(pd_rooms & rd_rooms)
            if shared >= MIN_SHARED_ROOMS and pd_text != rd_text:
                same_system = system(pd) is not None and system(pd) == system(rd)
                bonus = (1000 if same_system else 0) + (MIN_SHARED_ROOMS if EQUIPMENT.search(rd_text) else 0)
                # при равенстве — лист РД, где общие помещения составляют большую долю всех номеров:
                # экспликация того же этажа точнее плана, на котором ещё сотня чисел
                scored.append((shared + bonus, shared / len(rd_rooms), i, j))
    scored.sort(key=lambda item: (-item[0], -item[1], item[2], item[3]))
    used_pd: set[int] = set()
    used_rd: set[int] = set()
    pairs: list[tuple[Sheet, Sheet]] = []
    for _score, _share, i, j in scored:
        if i in used_pd or j in used_rd:
            continue
        used_pd.add(i)
        used_rd.add(j)
        pairs.append(((pd_sheets[i][0], pd_sheets[i][1]), (rd_sheets[j][0], rd_sheets[j][1])))
    return pairs


def _room_sheets(
    docs: Sequence[LoadedDocument], stage: str, *, need_equipment: bool
) -> list[tuple[LoadedDocument, dict[str, Any], set[str], str]]:
    """Листы-чертежи стадии с хотя бы `MIN_SHARED_ROOMS` номерами помещений.

    С `need_equipment` (лист ПД) берутся только помещения рядом с подписью оснащения: на листе плана
    сотни трёхзначных чисел — размеры, количества, помещения других этажей, — и пару по ним выигрывает
    самый «числовой» лист, а не лист тех же помещений.
    """
    sheets = []
    for doc in docs:
        if doc.stage != stage:
            continue
        for page in doc.pages:
            if not page.get("is_drawing") or page.get("quality") == "LOW_QUALITY":
                continue
            text = grounding.page_text(page)
            rooms = _equipped_rooms(page) if need_equipment else set(ROOM.findall(text))
            if len(rooms) >= MIN_SHARED_ROOMS:
                sheets.append((doc, page, rooms, " ".join(text.split())))
    return sheets


def system(doc: LoadedDocument) -> str | None:
    """Инженерная система документа по шифру: «ИОС5.4» и «ОВ2.1» — обе «ОВ»."""
    code = doc.metadata.document_code or ""
    if doc.stage == "PD":
        match = re.search(r"И[ОO0]С\s*5\.(\d)", code, re.IGNORECASE)
        return PD_SYSTEM.get(match.group(1)) if match else None
    match = RD_SYSTEM.search(code)
    if not match:
        return None
    found = match.group(1).upper()
    return RD_ALIASES.get(found, found)


def _equipped_rooms(page: dict[str, Any]) -> set[str]:
    """Номера помещений из подписей, стоящих не дальше `NEAR` от подписи прибора."""
    blocks = [b for b in page.get("blocks") or [] if len(b.get("bbox") or []) == 4]
    anchors = [b["bbox"] for b in blocks if DEVICE.search(str(b.get("text") or ""))]
    rooms: set[str] = set()
    for block in blocks:
        x0, y0, x1, y1 = block["bbox"]
        if any(
            x0 <= ax1 + NEAR and x1 >= ax0 - NEAR and y0 <= ay1 + NEAR and y1 >= ay0 - NEAR
            for ax0, ay0, ax1, ay1 in anchors
        ):
            rooms.update(ROOM.findall(str(block.get("text") or "")))
    return rooms


def _sheet(
    client: LlmClient,
    settings: Settings,
    pd_sheet: Sheet,
    rd_sheet: Sheet,
    object_id: object,
    page_pairs: Sequence[PagePairResult],
) -> list[SuspicionResult]:
    (pd, pd_page), (rd, rd_page) = pd_sheet, rd_sheet
    limit = settings.llm_max_chars // 2
    pd_text = grounding.page_text(pd_page)[:limit]
    rd_text = grounding.page_text(rd_page)[:limit]
    prompt = (
        f"### ПД — {pd.metadata.document_code or 'документ'}, стр. {pd_page.get('page')}\n{pd_text}\n\n"
        f"### РД — {rd.metadata.document_code or 'документ'}, стр. {rd_page.get('page')}\n{rd_text}"
    )
    answer = client.ask_json(SYSTEM_SHEET, prompt)
    if answer is None:
        return []
    raw = answer.get("hypotheses")
    if not isinstance(raw, list):
        log.warning("semantic_bad_shape", keys=sorted(answer)[:5], mode="sheet")
        return []
    results: list[SuspicionResult] = []
    for item in raw[:MAX_HYPOTHESES]:
        if not isinstance(item, dict):
            continue
        item = _anchor_quotes(item, pd_page, rd_page)
        result = _hypothesis(item, pd, rd, (pd_text, rd_text), object_id, page_pairs, [pd_page], [rd_page])
        if result is not None:
            results.append(result)
    return results


def _anchor_quotes(item: dict[str, Any], pd_page: dict[str, Any], rd_page: dict[str, Any]) -> dict[str, Any]:
    """Цитата с чертежа — подпись самого помещения, если модель её пересказала.

    Подписи на листе рваные («267, 270 / Раздевальная и / санузул для МГН»), и дословную цитату модель
    почти не даёт: на живом прогоне первая же верная гипотеза «Помещение 267» отсеялась по цитате.
    Доказательством тогда становится подпись помещения из `subject` — но только если на листе ПД оно
    стоит рядом с подписью прибора (`_equipped_rooms`). Помещение, которое модель выдумала или взяла
    не с того места, по-прежнему не проходит; проверка чисел остаётся как есть.
    """
    rooms = ROOM.findall(str(item.get("subject") or ""))
    if not rooms:
        return item
    anchored = dict(item)
    if grounding.locate(str(item.get("pd_quote") or ""), [pd_page]) is None:
        equipped = _equipped_rooms(pd_page)
        room = next((r for r in rooms if r in equipped), None)
        block = _room_block(pd_page, room) if room else None
        if block is None:
            return item
        anchored["pd_quote"] = block
        log.info("semantic_quote_anchored", room=room, stage="PD")
    rd_quote = str(item.get("rd_quote") or "")
    if rd_quote and grounding.locate(rd_quote, [rd_page]) is None:
        anchored["rd_quote"] = _room_block(rd_page, rooms[0]) or ""
    return anchored


def _room_block(page: dict[str, Any], room: str) -> str | None:
    """Текст подписи на листе, в которой стоит номер помещения."""
    for block in page.get("blocks") or []:
        text = str(block.get("text") or "")
        if room in ROOM.findall(text):
            return text
    return None


def sections(docs: Sequence[LoadedDocument]) -> list[tuple[LoadedDocument, LoadedDocument]]:
    """Пары «документ ПД — документ РД» одного раздела, от самых содержательных к пустым.

    Раздел определяем по `discipline` из метаданных: сверять отопление с конструкциями
    бессмысленно. Документы без раздела пропускаем — угадывать не будем.
    """
    by_stage: dict[str, dict[str, list[LoadedDocument]]] = {}
    for doc in docs:
        discipline = (doc.metadata.discipline or "").strip()
        if discipline:
            by_stage.setdefault(doc.stage, {}).setdefault(discipline, []).append(doc)

    pairs: list[tuple[LoadedDocument, LoadedDocument]] = []
    for discipline, pd_docs in sorted(by_stage.get("PD", {}).items()):
        for rd in by_stage.get("RD", {}).get(discipline, []):
            for pd in pd_docs:
                pairs.append((pd, rd))
    pairs.sort(key=lambda pair: -min(_weight(pair[0]), _weight(pair[1])))
    return pairs


def _weight(doc: LoadedDocument) -> int:
    """Сколько в документе текста: чертёж без подписей модели сказать нечего."""
    return sum(len(grounding.page_text(page)) for page in readable(doc))


def readable(doc: LoadedDocument) -> list[dict[str, Any]]:
    """Страницы, с которых можно что-то прочитать: не чертежи и распознанные приемлемо."""
    return [p for p in doc.pages if not p.get("is_drawing") and p.get("quality") != "LOW_QUALITY"]


def excerpt(doc: LoadedDocument, limit: int) -> str:
    """Текст документа для запроса, обрезанный по бюджету символов."""
    parts: list[str] = []
    size = 0
    for page in readable(doc):
        text = grounding.page_text(page).strip()
        if not text:
            continue
        head = f"[стр. {page.get('page')}]\n{text}"
        if size + len(head) > limit:
            parts.append(head[: max(0, limit - size)])
            break
        parts.append(head)
        size += len(head)
    return "\n\n".join(parts)


def _section(
    client: LlmClient,
    settings: Settings,
    pd: LoadedDocument,
    rd: LoadedDocument,
    object_id: object,
    page_pairs: Sequence[PagePairResult],
) -> list[SuspicionResult]:
    # LLM_MAX_CHARS — на весь запрос: русский текст — около двух символов на токен, и 2 × 12 000 символов
    # (около 12 тыс. токенов) не помещались в контекст 8 тыс. у локальной Qwen3-8B — Ollama обрезала запрос
    pd_text = excerpt(pd, settings.llm_max_chars // 2)
    rd_text = excerpt(rd, settings.llm_max_chars // 2)
    if not pd_text or not rd_text:
        return []

    answer = client.ask_json(SYSTEM, f"### ПД\n{pd_text}\n\n### РД\n{rd_text}")
    if answer is None:
        return []

    raw = answer.get("hypotheses")
    if not isinstance(raw, list):
        log.warning("semantic_bad_shape", keys=sorted(answer)[:5])
        return []

    sources = (pd_text, rd_text)
    results: list[SuspicionResult] = []
    for item in raw[:MAX_HYPOTHESES]:
        if not isinstance(item, dict):
            continue
        result = _hypothesis(item, pd, rd, sources, object_id, page_pairs)
        if result is not None:
            results.append(result)
    return results


def _hypothesis(
    item: dict[str, Any],
    pd: LoadedDocument,
    rd: LoadedDocument,
    sources: Sequence[str],
    object_id: object,
    page_pairs: Sequence[PagePairResult],
    pd_pages: list[dict[str, Any]] | None = None,
    rd_pages: list[dict[str, Any]] | None = None,
) -> SuspicionResult | None:
    subject = str(item.get("subject") or "").strip()
    description = str(item.get("description") or "").strip()
    if not subject or not description:
        return None

    invented = grounding.ungrounded(f"{subject} {description}", sources)
    if invented:
        log.warning("semantic_rejected", reason="числа вне документа", numbers=sorted(invented), subject=subject[:60])
        return None

    pd_fragment = _fragment(pd, str(item.get("pd_quote") or ""), "EXPECTED", pd_pages)
    if pd_fragment is None:
        log.warning("semantic_rejected", reason="цитата ПД не найдена", subject=subject[:60])
        return None

    rd_quote = str(item.get("rd_quote") or "").strip()
    rd_fragment = None
    if rd_quote:
        rd_fragment = _fragment(rd, rd_quote, "ACTUAL", rd_pages)
        if rd_fragment is None:
            log.warning("semantic_rejected", reason="цитата РД не найдена", subject=subject[:60])
            return None

    evidence = [f for f in (pd_fragment, rd_fragment) if f is not None]
    confidences = [f.confidence for f in evidence if f.confidence is not None]
    priority = str(item.get("priority") or "").upper()

    return SuspicionResult.model_validate(
        {
            "suspicion_key": suspicion_key(object_id, DISCOVERY_METHOD, rule_group(subject)),
            "discovery_method": DISCOVERY_METHOD,
            "confidence": min([CEILING, *confidences]),
            "description": f"{subject}. {description}",
            "pd_reference": _reference(pd, pd_fragment),
            "rd_reference": _reference(rd, rd_fragment),
            "id_reference": None,
            "review_priority": priority if priority in PRIORITIES else DEFAULT_PRIORITY,
            "rule_id": None,
            "page_pair_key": pagepairs.key_for(evidence, page_pairs),
            "evidence": evidence,
        }
    )


def _fragment(
    doc: LoadedDocument, quote: str, role: str, pages: list[dict[str, Any]] | None = None
) -> EvidenceFragment | None:
    """Доказательство по цитате. Цитаты нет в документе — нет и фрагмента, а значит и гипотезы.

    `pages` — где искать, если страница уже известна: в томе на сотни листов перебор всех
    страниц на каждую цитату стоит минуты.
    """
    located = grounding.locate(quote, pages if pages is not None else readable(doc))
    if located is None:
        return None
    number, bbox, snippet = located
    page = next((p for p in doc.pages if p.get("page") == number), {})
    return EvidenceFragment.model_validate(
        {
            "role": role,
            "file_id": str(doc.file_id),
            "sha256": doc.sha256,
            "stage": doc.stage,
            "document_code": doc.metadata.document_code,
            "revision": doc.metadata.revision,
            "approval_status": _plain(doc.metadata.approval_status) or "UNKNOWN",
            "page": number,
            "bbox": bbox,
            "text_snippet": snippet,
            "source": page.get("source") or "TEXT_LAYER",
            "quality": page.get("quality") or "OK",
            "confidence": page.get("ocr_confidence"),
        }
    )


def _reference(doc: LoadedDocument, fragment: EvidenceFragment | None) -> str | None:
    if fragment is None:
        return None
    name = doc.metadata.document_code or str(doc.file_id)
    return f"{name}, стр. {fragment.page}"


def _plain(value: object) -> Any:
    return getattr(value, "root", value)
