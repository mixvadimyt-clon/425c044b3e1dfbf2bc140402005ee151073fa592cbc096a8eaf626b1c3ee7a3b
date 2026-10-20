"""M-058 «Толщина монолитной фундаментной плиты / ростверка».

Атомарная точка — конструкция («Фундаментная плита», «Ростверк»), значение — толщина в мм.
Ключи те же, что у класса бетона M-055: инспектор видит одну и ту же конструкцию под одним
именем в обоих параметрах.

Как толщину пишут в настоящих документах (объекты обучающей части: Новослободская, «Пример
нарушений на чертежах»; эталон организаторов KR-058 — ПД КР2 стр. 53, РД КЖ1.1.1 стр. 3 и 7):

1. **Толщина, потом конструкция:** «Толщина фундаментной плиты определена по расчету,
   составляет 1000мм и 1200мм», «- Толщина фундаментной плиты -1000, 1200мм - Перекрытия…».
2. **Конструкция, потом «толщиной»:** «Фундамент жилого дома предусмотрен в виде монолитной
   железобетонной плиты толщиной 1200 и 1500 мм», «Фундаменты – монолитная ж/б плита толщиной
   600мм».
3. **Размер на чертеже:** «Монолитная ж.б. фундаментная плита, h=1200 мм».

Ловушки там же, и каждая дала бы ложное «уменьшение толщины»:

- «Под телом фундаментной плиты выполнена бетонная подготовка … толщиной 100 мм» — толщина
  принадлежит последней названной конструкции, а это подготовка;
- «Фундаментная плита приямка, h=900 мм» — приямок, отдельный элемент;
- «H плиты 400мм» на листе КЖ — какой плиты, из строки не видно;
- «переходные плиты … толщиной 800 мм», «δ=200 мм» у утеплителя — не фундамент.

Поэтому толщина засчитывается, только если **ближайшая** конструкция рядом с ней — наша,
а между ними не названо ничего другого (подготовка, стяжка, стены, приямок…).

**Одно значение на конструкцию в документе — наименьшая толщина.** Плита бывает разной толщины
по зонам («1000 и 1200 мм»), а движок сравнения при нескольких разных значениях одной стадии
просит инспектора выбрать источник. Триггер матрицы — уменьшение толщины, и за него отвечает
самая тонкая зона. Все толщины остаются в `raw_value` дословно: «1000мм и 1200мм».
"""

from __future__ import annotations

import re
from typing import Any

from inspector_ml.contracts.events import MatrixParam
from inspector_ml.extract.base import Found
from inspector_ml.extract.normalize import collapse

UNIT = "мм"
#: Правдоподобная толщина фундаментной плиты или ростверка, мм. Тоньше — это подготовка, стяжка
#: или утеплитель рядом; толще — отметка или длина, прочитанная как толщина.
MIN_MM, MAX_MM = 300, 4000
#: Сколько символов перед толщиной просматриваем в поисках конструкции.
LOOKBACK = 160
#: Насколько далеко от толщины может стоять название конструкции («плита толщиной» — вплотную,
#: «плита, выполненная из бетона В30, толщиной» — через оборот).
NEAR = 40

#: Наша конструкция. «Фундамент … в виде монолитной железобетонной плиты» — тоже она: так пишут
#: в пояснительной записке, и прилагательного «фундаментная» рядом с «плитой» там нет.
ELEMENT = re.compile(
    r"(?P<slab>фундаментн\w*\s+плит(?!к)\w*|плит(?!к)\w*\s+фундаментн\w*|фундамент\w*[^.;\d]{0,80}?\bплит(?!к)\w*)"
    r"|(?P<grillage>ростверк\w*)",
    re.IGNORECASE,
)
KEYS = {"slab": "Фундаментная плита", "grillage": "Ростверк"}

#: Другая конструкция или слой. Если он назван между нашей конструкцией и толщиной, толщина — его.
OTHER = re.compile(
    r"подготовк|стяжк|утепл|гидроизол|мембран|щеб[её]н|песк|песчан|основани|засыпк|слой|сло[ея]м"
    r"|стен|перекрыт|покрыт|колонн|пилон|балк|лестниц|капител|приямк|лифт|канал|шв|плитк|панел"
    r"|перемычк|бортик|подколонник|зазор|отмостк",
    re.IGNORECASE,
)

_NUMBER = r"(?:\d{1,2}\s\d{3}|\d{3,4})"
#: Толщины подряд, с единицей в конце: «600мм», «1200 и 1500 мм», «1000мм и 1200мм», «-1000, 1200мм».
VALUES = rf"(?P<values>{_NUMBER}(?:\s*мм)?(?:\s*(?:,|и|или|/)\s*{_NUMBER}(?:\s*мм)?)*\s*мм)(?![а-яa-z])"
#: «Толщина <конструкции> … <значения>»: между ними допускаются слова без цифр в пределах фразы.
THICKNESS_FIRST = re.compile(r"толщин\w*\s+", re.IGNORECASE)
AFTER_ELEMENT = re.compile(rf"[^\d.;]{{0,40}}?[-:]?\s*{VALUES}", re.IGNORECASE)
#: «<конструкция> толщиной <значения>» и «<конструкция>, h=<значение>».
THICKNESS_AFTER = re.compile(rf"(?:толщин\w*|\bh\s*=)\s*(?:не\s+менее\s+)?[-:]?\s*{VALUES}", re.IGNORECASE)
#: Точки внутри сокращений не конец фразы: «ж/б.», «ж.б.», «ж. б.».
ABBREVIATION = re.compile(r"ж\s?[./]\s?б\.?", re.IGNORECASE)


def extract(param: MatrixParam, pages: list[dict[str, Any]]) -> list[Found]:
    """Толщина фундаментной плиты и ростверка в документе: по одному значению на конструкцию.

    `param` не используется: единица и пределы толщины — свойство конструкции, а не матрицы.
    Аргумент нужен ради единого интерфейса извлекателей ([api.py](api.py)).
    """
    thinnest: dict[str, tuple[float, Found]] = {}
    for page in pages:
        # Штамп не пропускаем, в отличие от прочих разборов: разметка страницы принимает за штамп
        # абзац внизу листа («…Толщина фундаментной плиты 600 мм.» — «Пример нарушений»,
        # Том 5.3.4, стр. 8), а в настоящем штампе толщины с единицей не бывает.
        for block in page.get("blocks") or []:
            for thickness, found in _mentions(page["page"], block):
                key = str(found.rule_key)
                if key not in thinnest or thickness < thinnest[key][0]:
                    thinnest[key] = (thickness, found)
    return [found for _, found in thinnest.values()]


def _mentions(page: int, block: dict[str, Any]) -> list[tuple[float, Found]]:
    """Упоминания толщины нашей конструкции в блоке текста: наименьшая толщина и где нашли."""
    text = collapse(block["text"])
    # сокращения маскируем той же длины, чтобы позиции совпадали с исходным текстом
    masked = ABBREVIATION.sub(lambda m: re.sub(r"[./]", " ", m.group()), text)
    found: list[tuple[float, Found]] = []

    for marker in THICKNESS_FIRST.finditer(masked):
        element = ELEMENT.search(masked, marker.end(), marker.end() + NEAR)
        if element is None or _foreign(masked, marker.end(), element.start()):
            continue
        values = AFTER_ELEMENT.match(masked, element.end())
        if values is None or _foreign(masked, element.end(), values.start("values")):
            continue
        found += _found(page, block, text, _key(element), values)

    for values in THICKNESS_AFTER.finditer(masked):
        element = _nearest_element(masked, values.start())
        if element is not None:
            found += _found(page, block, text, _key(element), values)
    return found


def _nearest_element(text: str, position: int) -> re.Match[str] | None:
    """Наша конструкция, названная перед толщиной последней, — если между ними нет другой."""
    last = None
    for match in ELEMENT.finditer(text, max(0, position - LOOKBACK), position):
        last = match
    if last is None or position - last.end() > NEAR:
        return None
    # «фундамент … плита» охватывает слова между ними — там тоже не должно быть чужой конструкции
    return None if OTHER.search(text, last.start(), position) else last


def _foreign(text: str, start: int, end: int) -> bool:
    """Между толщиной и конструкцией стоит число или названа другая конструкция — значит, они не пара."""
    gap = text[start:end]
    return any(ch.isdigit() for ch in gap) or OTHER.search(gap) is not None


def _key(element: re.Match[str]) -> str:
    return KEYS[next(name for name, value in element.groupdict().items() if value)]


def _found(page: int, block: dict[str, Any], text: str, key: str, match: re.Match[str]) -> list[tuple[float, Found]]:
    """Толщина одного упоминания — наименьшая из перечисленных; `raw_value` — все, как в тексте."""
    raw = text[match.start("values") : match.end("values")]
    values = [float(v.replace(" ", "")) for v in re.findall(_NUMBER, raw)]
    values = [v for v in values if MIN_MM <= v <= MAX_MM]
    if not values:
        return []
    thickness = min(values)
    return [
        (
            thickness,
            Found(
                rule_key=key,
                raw_value=raw,
                value=thickness,
                page=page,
                bbox=block["bbox"],
                snippet=text[max(0, match.start() - 120) : match.end() + 40],
                unit=UNIT,
                method="regex",
            ),
        )
    ]
