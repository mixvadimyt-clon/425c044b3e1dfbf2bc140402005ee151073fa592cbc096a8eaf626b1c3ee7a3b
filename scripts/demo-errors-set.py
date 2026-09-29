#!/usr/bin/env python3
"""Контрольные комплекты ПД + РД + ИД с заранее внесёнными несоответствиями — для показа и приёмки.

Зачем. Живой комплект из датасета показывает честную картину, но не гарантирует ни одного
кандидата: из 132 параметров сейчас извлекаются два (M-002 и M-055), и в случайной выборке
файлов («П-СП», «РД-ЭМ», АОСР) нет ни общей площади, ни класса бетона — центр верификации
пустой, и на показе это выглядит как поломка. Здесь ответ известен заранее.

Комплект 1 (`--set 1`, по умолчанию) — жилой дом, корпус 2:

    M-002  Общая площадь здания       ПД 12 480,6 м² → РД 11 905,3 м² (−4,6 %, порог 1 %)  CANDIDATE
    M-055  Фундаментная плита         ПД B30 → РД B25, ИД B25 (понижение)                   CANDIDATE
    M-055  Плиты перекрытия           ПД B25 → РД B30 (повышение), ИД B22,5 (понижение)     CANDIDATE
    M-055  Вертикальные конструкции   ПД B35 = РД B35                                       NEGATIVE_VERIFIED

Комплект 2 (`--set 2`) — школа; все три исхода проверки и нарушение, найденное только в ИД:

    M-002  Общая площадь здания       ПД 7 850,0 → РД 7 862,5 (+0,16 %, в допуске),
                                      ИД (технический план) 8 105,3 (+3,25 %)               CANDIDATE
    M-055  Стены подвала              ПД B30 → РД B25                                       CANDIDATE
    M-055  Ростверк                   ПД B25 = РД B25 → ИД B20                              CANDIDATE
    M-055  Лестницы                   ПД B20 → РД B22,5 (повышение)                         NEGATIVE_VERIFIED
    M-055  Плиты перекрытия           ПД B25 = РД B25 = ИД B25                              NEGATIVE_VERIFIED
    M-055  Вертикальные конструкции   ПД B30; в РД таблица B30, указания B35                CLARIFICATION_REQUIRED

Комплект 3 (`--set 3`) — вся матрица, 132 параметра: документ на каждый из 16 разделов в ПД,
РД и ИД, ошибка в двух третях параметров, ответ по каждому — `<папка>.expected.json`. Он проверяет
покрытие, а не показ: сверяет `scripts/matrix-check.py`, подробности — docs/domain/matrix.md.

Все PDF — с текстовым слоем: разбор занимает секунды и не запускает распознавание, поэтому
комплекты проходят и на слабой машине без видеокарты. Объекты, организации и фамилии вымышлены,
в штампах и реестре это видно по «Демо» и «ул. Тестовая».

Две вещи в тексте документов не случайны — обе про то, как устроено извлечение M-055:

- **Порядок строк в таблицах классов бетона** — по убыванию места в словаре конструкций
  (`services/ml/.../extract/lexicon.py`). Если разбор склеит таблицу в один блок, конструкция
  для марки ищется в тексте перед ней, и первой по словарю должна оказаться своя строка.
- **Конструкция в актах ИД комплекта 2 названа в именительном падеже** («ростверк Рм-1 —
  бетонная смесь B20»): косвенные падежи вроде «ростверка» словарь пока не узнаёт.
  Так в актах тоже пишут; когда словарь починят, можно вернуть
  «устройство ростверка».

Нужен PyMuPDF — он есть в образе ML, поэтому проще всего запускать там (из корня репозитория):

    docker run --rm -v "$PWD:/w" -w /w --entrypoint /app/services/ml/.venv/bin/python \\
        inspector-ml scripts/demo-errors-set.py "dataset/Контрольный комплект"
    docker run ... inspector-ml scripts/demo-errors-set.py --set 2 "dataset/Контрольный комплект 2"
    docker run ... inspector-ml scripts/demo-errors-set.py --set 3 "dataset/Контрольный комплект 3"

Дальше — загрузить папку через интерфейс (вместе с registry.csv) или серверным импортом:
`./start.sh import "Контрольный комплект" "Корпус 2 (контрольный)"`.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import pymupdf

W, H = 595.0, 842.0  # A4 книжный
MM = 72 / 25.4
# рамка листа: 20 мм слева под подшивку, 5 мм с остальных сторон
LEFT, RIGHT, TOP, BOTTOM = 20 * MM, W - 5 * MM, 5 * MM, H - 5 * MM

# объект задаёт выбранный комплект (main); здесь — значения комплекта 1
OBJECT = "Многоквартирный жилой дом с подземной автостоянкой. Корпус 2"
ADDRESS = "г. Москва, ул. Тестовая, вл. 12"
ORG = "ООО «Демо-Проект»"

#: Шрифты с кириллицей: Arial с Windows, DejaVu из Linux или из OpenCV в образе ML.
FONT_CANDIDATES = (
    ("/fonts/arial.ttf", "/fonts/arialbd.ttf"),
    ("C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf"),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
)

FONT = FONT_B = ""


def find_fonts(explicit: str | None) -> tuple[str, str]:
    if explicit:
        return explicit, explicit
    candidates = list(FONT_CANDIDATES)
    for site in map(Path, sys.path):
        qt = site / "cv2" / "qt" / "fonts"
        candidates.append((str(qt / "DejaVuSans.ttf"), str(qt / "DejaVuSans-Bold.ttf")))
    for regular, bold in candidates:
        if Path(regular).is_file():
            return regular, bold if Path(bold).is_file() else regular
    raise SystemExit("не найден шрифт с кириллицей — укажите его: --font путь/к/шрифту.ttf")


def new_page(doc: pymupdf.Document) -> pymupdf.Page:
    page = doc.new_page(width=W, height=H)
    page.insert_font(fontname="ar", fontfile=FONT)
    page.insert_font(fontname="arb", fontfile=FONT_B)
    page.draw_rect(pymupdf.Rect(LEFT, TOP, RIGHT, BOTTOM), width=1.2)
    return page


def text(page, x, y, s, size=10, bold=False):
    page.insert_text((x, y), s, fontname="arb" if bold else "ar", fontsize=size)


def para(page, x, y, width, s, size=10, leading=1.35):
    """Абзац с переносом по словам. Возвращает y следующей строки."""
    font = pymupdf.Font(fontfile=FONT)
    line = ""
    for word in s.split():
        probe = f"{line} {word}".strip()
        if font.text_length(probe, fontsize=size) > width and line:
            text(page, x, y, line, size)
            y += size * leading
            line = word
        else:
            line = probe
    if line:
        text(page, x, y, line, size)
        y += size * leading
    return y


def table(page, x, y, widths, rows, size=9.5, row_h=20):
    """Таблица с сеткой, первая строка — шапка. Возвращает y под таблицей."""
    total = sum(widths)
    for r, row in enumerate(rows):
        top = y + r * row_h
        page.draw_rect(pymupdf.Rect(x, top, x + total, top + row_h), width=0.6)
        cx = x
        for c, (cell, w) in enumerate(zip(row, widths)):
            if c:
                page.draw_line((cx, top), (cx, top + row_h), width=0.6)
            text(page, cx + 4, top + row_h / 2 + size * 0.35, cell, size, bold=r == 0)
            cx += w
    return y + len(rows) * row_h


def stamp(page, code, title, stage, sheet, sheets, doc_kind):
    """Основная надпись (упрощённая форма 5 ГОСТ Р 21.101) внизу листа.

    Штамп разбор ищет в правом нижнем углу (x > 50 %, y > 68 % листа), поэтому содержательные
    таблицы стоят выше — иначе они ушли бы в «основную надпись» и значения из них не читались бы.
    """
    h = 40 * MM
    x0, y0, x1, y1 = LEFT, BOTTOM - h, RIGHT, BOTTOM
    page.draw_rect(pymupdf.Rect(x0, y0, x1, y1), width=1.2)
    lw = 65 * MM
    page.draw_line((x0 + lw, y0), (x0 + lw, y1), width=1.2)
    rows = ["Изм.  Кол.уч.  Лист  №док.  Подп.  Дата", "Разраб.   Петров А.С.", "Провер.   Сидорова Е.В.",
            "ГИП       Иванов И.И.", "Н.контр.  Кузнецов П.Р."]
    for i, r in enumerate(rows):
        yy = y0 + (i + 1) * h / 6
        page.draw_line((x0, yy), (x0 + lw, yy), width=0.5)
        text(page, x0 + 3, yy + 11, r, 7.5)
    rx = x0 + lw
    page.draw_line((rx, y0 + 11 * MM), (x1, y0 + 11 * MM), width=1.2)
    text(page, rx + 60, y0 + 20, code, 12, bold=True)
    page.draw_line((rx, y0 + 22 * MM), (x1, y0 + 22 * MM), width=0.8)
    para(page, rx + 4, y0 + 11 * MM + 12, (x1 - rx) - 8, OBJECT + ". " + ADDRESS, 7.5, 1.25)
    sx = x1 - 50 * MM
    page.draw_line((sx, y0 + 22 * MM), (sx, y1), width=0.8)
    para(page, rx + 4, y0 + 22 * MM + 12, sx - rx - 8, title, 8.5, 1.25)
    text(page, rx + 4, y1 - 6, doc_kind, 6.5)
    page.draw_line((sx, y0 + 30 * MM), (x1, y0 + 30 * MM), width=0.8)
    text(page, sx + 4, y0 + 22 * MM + 10, "Стадия     Лист     Листов", 7)
    text(page, sx + 12, y0 + 22 * MM + 20, f"{stage}             {sheet}            {sheets}", 8.5)
    text(page, sx + 18, y0 + 30 * MM + 18, ORG, 9, bold=True)


def title_page(doc, code, title, volume):
    p = new_page(doc)
    text(p, LEFT + 150, 140, "ПРОЕКТНАЯ ДОКУМЕНТАЦИЯ", 16, bold=True)
    para(p, LEFT + 40, 200, 400, OBJECT, 13)
    text(p, LEFT + 40, 250, ADDRESS, 11)
    para(p, LEFT + 40, 310, 420, title, 14)
    text(p, LEFT + 40, 360, f"Том {volume}    Шифр {code}", 11)
    text(p, LEFT + 40, 420, "Главный инженер проекта                              И.И. Иванов", 10)
    stamp(p, code, title, "П", 1, 2, "Проектная документация")


# ------------------------------------------------------------------ комплекты


@dataclass(frozen=True)
class Act:
    """Акт освидетельствования скрытых работ: материалы — текст п. 3, марка сразу после конструкции."""

    number: str
    date: str
    work: str
    materials: str


@dataclass(frozen=True)
class DemoSet:
    object: str
    address: str
    code: str  # шифр объекта: «2026-СК2» → «2026-СК2-П-ПЗ», «2026-СК2-РД-КЖ»
    developer: str
    pd_date: str
    rd_date: str
    pz_heading: str
    pz_rows: list[list[str]]
    pz_note: str
    kr_heading: str
    kr_rows: list[list[str]]
    kr_note: str
    ar_rows: list[list[str]]
    ar_note: str
    kzh_rows: list[list[str]]
    kzh_notes: list[str]
    acts: list[Act]
    ar_sheets: list[list[str]] | None = None
    #: ИД «Технический план здания»: строки таблицы характеристик
    tech_plan: list[list[str]] | None = None
    expected: str = ""


TEP_HEAD = ["№", "Наименование показателя", "Ед. изм.", "Показатель"]
CONCRETE_HEAD = ["Конструкция", "Класс бетона", "Морозост.", "Водонепр."]
AR_HEAD = ["Наименование показателя", "Ед. изм.", "Значение"]

SET_1 = DemoSet(
    object="Многоквартирный жилой дом с подземной автостоянкой. Корпус 2",
    address="г. Москва, ул. Тестовая, вл. 12",
    code="2026-СК2",
    developer="ООО «Демо-Девелопмент»",
    pd_date="10.02.2026",
    rd_date="20.03.2026",
    pz_heading="1. Технико-экономические показатели объекта",
    pz_rows=[
        ["1", "Площадь земельного участка", "м²", "6 850,0"],
        ["2", "Площадь застройки", "м²", "1 420,5"],
        ["3", "Общая площадь здания", "м²", "12 480,6"],
        ["4", "Строительный объём", "м³", "48 320,0"],
        ["5", "Количество этажей", "эт.", "10"],
        ["6", "Количество квартир", "шт.", "144"],
    ],
    pz_note="Показатели определены по поэтажным планам раздела «Архитектурные решения» "
    "в соответствии с приказом Минстроя России № 740/пр.",
    kr_heading="4.3. Материалы несущих конструкций",
    kr_rows=[
        ["Плиты перекрытия", "B25", "F75", "W4"],
        ["Вертикальные конструкции", "B35", "F100", "W6"],
        ["Фундаментная плита", "B30", "F150", "W8"],
    ],
    kr_note="Бетон тяжёлый по ГОСТ 26633-2015. Арматура класса А500С по ГОСТ 34028-2016. "
    "Толщина фундаментной плиты 800 мм, защитный слой рабочей арматуры 50 мм.",
    ar_sheets=[
        ["Лист", "Наименование", "Примечание"],
        ["1", "Общие данные", ""],
        ["2", "План 1-го этажа", ""],
        ["3", "План типового этажа", ""],
        ["4", "Фасады", ""],
    ],
    ar_rows=[
        ["Площадь застройки", "м²", "1 420,5"],
        ["Общая площадь здания", "м²", "11 905,3"],  # ВНЕСЕНО: −4,6 % к ПД
        ["Строительный объём", "м³", "48 320,0"],
        ["Количество этажей", "эт.", "10"],
    ],
    ar_note="Рабочая документация разработана в соответствии с заданием на проектирование "
    "и проектной документацией, получившей положительное заключение экспертизы.",
    kzh_rows=[
        ["Плиты перекрытия", "B30", "F75", "W4"],
        ["Вертикальные конструкции", "B35", "F100", "W6"],
        ["Фундаментная плита", "B25", "F150", "W8"],  # ВНЕСЕНО: понижение с B30
    ],
    kzh_notes=[
        "1. Бетон тяжёлый по ГОСТ 26633-2015, бетонная смесь по ГОСТ 7473-2010.",
        "2. Арматура класса А500С по ГОСТ 34028-2016, А240 по ГОСТ 34028-2016.",
        "3. Производство работ вести в соответствии с СП 70.13330.2012 «Несущие и ограждающие конструкции».",
    ],
    acts=[
        Act("14", "14.05.2026", "устройство монолитной железобетонной фундаментной плиты в осях 1–8 / А–Г",
            "бетонная смесь для фундаментной плиты: БСТ B25 F150 W8 П4 по ГОСТ 7473-2010, "
            "документ о качестве № 1187 от 12.05.2026"),
        Act("27", "18.06.2026",
            "устройство монолитной железобетонной плиты перекрытия на отм. +6,300 в осях 1–8 / А–Г",
            "бетонная смесь для плиты перекрытия: БСТ B22,5 F75 W4 П4 по ГОСТ 7473-2010, "
            "документ о качестве № 1422 от 16.06.2026"),
    ],
    expected="M-002 и два M-055 — CANDIDATE, M-055 «Вертикальные конструкции» — NEGATIVE_VERIFIED.",
)

# Порядок строк КР и КЖ — по убыванию места в словаре конструкций: стены подвала, лестницы,
# ростверк, плиты перекрытия, вертикальные конструкции.
SET_2 = DemoSet(
    object="Общеобразовательная школа на 550 мест с пищеблоком и спортивным залом",
    address="г. Москва, ул. Тестовая, вл. 14",
    code="2026-ШК",
    developer="ГКУ «Демо-Заказчик»",
    pd_date="12.01.2026",
    rd_date="02.03.2026",
    pz_heading="1.4. Технико-экономические показатели",
    pz_rows=[
        ["1", "Площадь земельного участка", "м²", "21 400,0"],
        ["2", "Площадь застройки", "м²", "3 120,4"],
        ["3", "Общая площадь здания", "м²", "7 850,0"],
        ["4", "Строительный объём", "м³", "36 910,0"],
        ["5", "Количество этажей", "эт.", "4"],
        ["6", "Вместимость", "чел.", "550"],
    ],
    pz_note="Показатели приведены по поэтажным планам раздела «Архитектурные решения» и заданию на проектирование.",
    kr_heading="4.2. Материалы несущих конструкций",
    kr_rows=[
        ["Стены подвала", "B30", "F150", "W8"],
        ["Лестницы", "B20", "F100", "W4"],
        ["Ростверк", "B25", "F150", "W6"],
        ["Плиты перекрытия", "B25", "F75", "W4"],
        ["Вертикальные конструкции", "B30", "F100", "W6"],
    ],
    kr_note="Бетон тяжёлый по ГОСТ 26633-2015. Арматура класса А500С по ГОСТ 34028-2016. "
    "Фундамент — свайный, сваи сечением 350×350 мм, объединённые монолитным ростверком.",
    ar_rows=[
        ["Площадь застройки", "м²", "3 120,4"],
        ["Общая площадь здания", "м²", "7 862,5"],  # +0,16 % к ПД — в допуске 1 %
        ["Строительный объём", "м³", "36 910,0"],
        ["Количество этажей", "эт.", "4"],
    ],
    ar_note="Общая площадь уточнена по рабочим чертежам: учтены помещения технического подполья. "
    "Отклонение от проектной документации — в пределах допуска.",
    kzh_rows=[
        ["Стены подвала", "B25", "F150", "W8"],  # ВНЕСЕНО: понижение с B30
        ["Лестницы", "B22,5", "F100", "W4"],  # повышение — не нарушение
        ["Ростверк", "B25", "F150", "W6"],
        ["Плиты перекрытия", "B25", "F75", "W4"],
        ["Вертикальные конструкции", "B30", "F100", "W6"],
    ],
    kzh_notes=[
        "1. Бетон тяжёлый по ГОСТ 26633-2015, бетонная смесь по ГОСТ 7473-2010.",
        "2. Арматура класса А500С по ГОСТ 34028-2016.",
        # ВНЕСЕНО: РД противоречит сама себе (в таблице B30) — выбирать значение система не вправе
        "3. Вертикальные конструкции бетонировать бетоном класса B35 F100 W6.",
        "4. Работы вести в соответствии с СП 70.13330.2012.",
    ],
    acts=[
        Act("8", "22.04.2026", "устройство монолитного железобетонного ростверка в осях 1–12 / А–Д",
            # ВНЕСЕНО: понижение с B25
            "ростверк Рм-1 в осях 1–12 / А–Д — бетонная смесь БСТ B20 F150 W6 П4 по ГОСТ 7473-2010, "
            "документ о качестве № 0934 от 20.04.2026"),
        Act("19", "03.06.2026", "устройство монолитной плиты перекрытия 1-го этажа в осях 1–12 / А–Д",
            "плита перекрытия П-1 на отм. +3,300 — бетонная смесь БСТ B25 F75 W4 П4 по ГОСТ 7473-2010, "
            "документ о качестве № 1276 от 01.06.2026"),
    ],
    tech_plan=[
        ["Характеристика", "Значение"],
        ["Назначение", "Нежилое"],
        ["Количество этажей", "4"],
        ["Общая площадь здания, м²", "8 105,3"],  # ВНЕСЕНО: +3,25 % к ПД
        ["Год завершения строительства", "2026"],
    ],
    expected="M-002, «Стены подвала» и «Ростверк» — CANDIDATE; «Лестницы» и «Плиты перекрытия» — "
    "NEGATIVE_VERIFIED; «Вертикальные конструкции» — CLARIFICATION_REQUIRED.",
)

SETS = {"1": SET_1, "2": SET_2}

# ------------------------------------------------------------------ комплект 3: вся матрица
#
# Комплект 3 (`--set 3`) проверяет не показ, а покрытие: по документу раздела на каждый из 16 разделов
# матрицы в ПД, РД и ИД, в каждом — все параметры раздела. Числа — в таблице показателей (строка
# называется первым якорем матрицы), остальное — строками «название: значение;». Ошибка внесена
# в две трети параметров; ожидаемый исход по каждому — в `<папка>.expected.json` рядом с комплектом,
# его сверяет `scripts/matrix-check.py`.

SECTIONS_ORDER = ("ПЗ", "СПЗУ", "АР", "КР", "ИОС1", "ИОС2", "ИОС3", "ИОС4", "ИОС5",
                  "ПОС", "ПОД", "ООС", "ППМ", "ОДИ", "ЗУ", "СМ")  # fmt: skip
#: Правдоподобная величина и знаков после запятой — по единице измерения параметра.
TYPICAL = {
    "м²": (4200.0, 1), "м³": (36500.0, 1), "м": (6.0, 2), "мм": (300.0, 0), "мм²": (1600.0, 0),
    "ед.": (9.0, 0), "шт.": (24.0, 0), "кВт": (850.0, 1), "м³/сут": (180.0, 1), "м³/ч": (45.0, 1),
    "Гкал/ч": (1.25, 3), "%": (35.0, 1), "‰": (20.0, 1), "мин": (60.0, 0), "мин (EI)": (60.0, 0),
    "л/с": (15.0, 1), "дни": (420.0, 0), "чел.": (150.0, 0), "тыс. руб.": (125000.0, 1),
    "Вт/(м·С)": (0.035, 3), "м²·С/Вт": (3.2, 2), "кВт·ч/м²": (95.0, 1), "А (Ампер)": (250.0, 0),
}  # fmt: skip
COUNTS = ("ед.", "шт.", "чел.", "дни")  # штуки — без дробной части
#: Строки, которые шаблон матрицы ждёт в особом порядке слов.
LINE_FORMAT = {
    "M-015": "{value} категория надежности электроснабжения;",
    # у M-009 и M-058 свои извлекатели ML: они читают фразу, как в настоящих ПЗ и КР, а не
    # строку таблицы «название | ед. | значение», — поэтому эти числа пишем фразой, а не в ТЭП
    "M-009": "За относительную отметку 0,000 принята абсолютная отметка {value} м;",
    "M-058": "Фундаментная плита толщиной {value} мм;",
    # M-041 — свой извлекатель: ширину эвакуационного выхода он берёт из фразы ПЗ и ПБ
    # («ширина выходов … принята 1,0 м») или из спецификации проёмов, а не из строки ТЭП
    "M-041": "Ширина эвакуационных выходов из лестничных клеток наружу принята {value} м;",
    # M-016 и M-074 — свои извлекатели: суточный расход — из фразы записки ВК, диаметр выпуска —
    # из подписи «Выпуск К1-1 Ø…» или фразы о выпусках, а не из строки ТЭП
    "M-016": "Общее водопотребление здания: {value} м3/сут;",
    "M-074": "Выпуск К1-1 хозяйственно-бытовой канализации из труб ВЧШГ Ø{value} мм;",
}
STAGE_CODE = {"П": "П", "Р": "РД", "И": "ИД"}
STAGE_KIND = {"П": "Проектная документация", "Р": "Рабочая документация", "И": "Исполнительная документация"}


def _num(value: float, decimals: int) -> str:
    """12480.6 → «12 480,6»: так пишут в ТЭП, и так число разбирает извлечение."""
    return f"{value:,.{decimals}f}".replace(",", " ").replace(".", ",")


def _set3_number(p: dict, trigger, inject: bool) -> dict:
    """Числовой параметр: ПД в пределах нормы, РД/ИД — за порогом или пределом триггера."""
    from inspector_ml.compare.triggers import convert

    unit = p["unit"]
    base, decimals = TYPICAL.get(unit, (100.0, 1))
    below = float(p["min_value"]) if p["min_value"] else trigger.below
    above = float(p["max_value"]) if p["max_value"] else trigger.above
    if trigger.below is not None and not p["min_value"]:
        below = convert(trigger.below, trigger.unit, unit)
    if trigger.above is not None and not p["max_value"]:
        above = convert(trigger.above, trigger.unit, unit)
    if below is not None and above is not None:
        base = (below + above) / 2
    elif below is not None:
        base = below * 1.5 if below > 0 else base
    elif above is not None:
        base = above * 0.5 if above > 0 else base
    if base < 10 and unit not in COUNTS:
        decimals = max(decimals, 2 if base >= 0.1 else 3)

    if below is not None:
        changed = below - max(abs(below) * 0.2, 10**-decimals * 5)
    elif above is not None:
        changed = above + max(abs(above) * 0.2, 10**-decimals * 5)
    else:
        step = base * max(0.2, 2 * (trigger.percent or 0) / 100)
        if trigger.absolute is not None:
            step = max(step, 2 * convert(trigger.absolute, trigger.unit, unit) + 10**-decimals * 5)
        if trigger.direction.value == "down":
            step = min(step, base * 0.9)  # значение не уходит в ноль и ниже
        changed = base - step if trigger.direction.value == "down" else base + step
    comparable = trigger.parsed or below is not None or above is not None
    return {
        "pd": _num(base, decimals),
        "rd": _num(changed if inject else base, decimals),
        "unit": unit,
        "expected": ("CANDIDATE" if inject else "NEGATIVE_VERIFIED") if comparable else "NOT_COMPARABLE",
    }


def _set3_plan(params: list[dict]) -> list[dict]:
    """Значения ПД / РД / ИД и ожидаемый исход по каждому параметру матрицы.

    Ошибка вносится в две трети параметров — по направлению их триггера (понижение, превышение,
    любое изменение, выход за предел), в остальной трети значения совпадают. ИД повторяет РД.
    Ожидание считаем простыми правилами, а не движком сравнения: иначе ошибка движка
    спряталась бы в ожидании.
    """
    from inspector_ml.compare.triggers import parse  # запуск — в образе ML, там пакет есть

    plan = []
    for i, p in enumerate(params):
        code, kind = p["code"], p["data_type"]
        trigger = parse(p["trigger_logic"])
        inject = i % 3 != 0
        verdict = "CANDIDATE" if inject else "NEGATIVE_VERIFIED"
        item = {"code": code, "section": p["section"], "name": p["parameter_name"], "kind": kind}
        if code == "M-055":
            item.update(pd="B30", rd="B25" if inject else "B30", expected=verdict)
        elif code == "M-009":
            # абсолютная отметка нуля правдоподобна только в 20–500 м: извлечение отсекает остальное
            item.update(pd="151,80", rd="152,40" if inject else "151,80", unit=p["unit"], expected=verdict)
        elif code == "M-058":
            # толщина фундаментной плиты — от 300 мм; нарушение — уменьшение, как в триггере
            item.update(pd="800", rd="600" if inject else "800", unit=p["unit"], expected=verdict)
        elif kind == "number":
            item.update(_set3_number(p, trigger, inject))
        elif kind == "enum" and p["enum_values"]:
            order = p["enum_values"].split("|")
            mid = len(order) // 2
            moved = order[mid + 1 if trigger.direction.value == "up" else mid - 1]
            expected = verdict if trigger.parsed else "NOT_COMPARABLE"
            item.update(pd=order[mid], rd=moved if inject else order[mid], expected=expected)
        elif kind == "coordinate":
            pd = "X 1000,00 Y 2000,00"
            item.update(pd=pd, rd="X 1001,00 Y 2000,00" if inject else pd, expected=verdict)
        else:
            pd = "исполнение 1 по проекту"
            item.update(pd=pd, rd="исполнение 2, изменено" if inject else pd, expected=verdict)
        item["id"] = item["rd"]
        plan.append(item)
    return plan


def _cell_lines(font: pymupdf.Font, s: str, width: float, size: float) -> list[str]:
    lines, line = [], ""
    for word in s.split():
        probe = f"{line} {word}".strip()
        if font.text_length(probe, fontsize=size) > width and line:
            lines.append(line)
            line = word
        else:
            line = probe
    return [*lines, line] if line else lines


TEP_WIDTHS, TEP_SIZE = (24, 330, 70, 90), 8.5


def _row_height(label: list[str]) -> float:
    return max(18.0, 6 + len(label) * TEP_SIZE * 1.25)


def _tep_table(page, x: float, y: float, rows: list[list[str]]) -> float:
    """Таблица показателей с переносом наименования внутри ячейки. Возвращает y под таблицей."""
    widths, size = TEP_WIDTHS, TEP_SIZE
    font = pymupdf.Font(fontfile=FONT)
    for r, row in enumerate(rows):
        label = _cell_lines(font, row[1], widths[1] - 8, size)
        h = _row_height(label)
        page.draw_rect(pymupdf.Rect(x, y, x + sum(widths), y + h), width=0.6)
        cx = x
        for c, (cell, w) in enumerate(zip(row, widths, strict=True)):
            if c:
                page.draw_line((cx, y), (cx, y + h), width=0.6)
            parts = label if c == 1 else [cell]
            for n, part in enumerate(parts):
                text(page, cx + 4, y + 4 + size + n * size * 1.25, part, size, bold=r == 0)
            cx += w
        y += h
    return y


def _section_doc(out: Path, code: str, stage: str, section: str, items: list[dict]) -> None:
    """Документ раздела: таблица числовых показателей, строки «название: значение;», таблица бетона."""
    kind = STAGE_KIND[stage]
    key = {"П": "pd", "Р": "rd", "И": "id"}[stage]
    title = f"Раздел {section}. Сводная ведомость показателей"
    doc = pymupdf.open()

    def page(heading: str) -> pymupdf.Page:
        p = new_page(doc)
        text(p, LEFT + 20, 50, f"{kind.upper()}. {heading}", 11, bold=True)
        return p

    numbers = [it for it in items if it["kind"] == "number" and it["code"] not in LINE_FORMAT]
    lines = [it for it in items if (it["kind"] != "number" or it["code"] in LINE_FORMAT) and it["code"] != "M-055"]
    rows = [[str(n), it["label"], it["unit"], it[key]] for n, it in enumerate(numbers, 1)]
    font = pymupdf.Font(fontfile=FONT)
    height = lambda row: _row_height(_cell_lines(font, row[1], TEP_WIDTHS[1] - 8, TEP_SIZE))  # noqa: E731
    while rows:
        p, y, chunk = page(f"Раздел {section}. Основные показатели"), 70.0 + height(TEP_HEAD), []
        # таблица кончается выше основной надписи: иначе строки уйдут в разбор штампа
        while rows and y + height(rows[0]) < 545:
            y += height(rows[0])
            chunk.append(rows.pop(0))
        _tep_table(p, LEFT + 10, 70, [TEP_HEAD, *chunk])
    if lines:
        p, y = page(f"Решения по разделу {section}"), 75.0
        for n, it in enumerate(lines, 1):
            line = LINE_FORMAT.get(it["code"], "{label}: {value};").format(label=it["label"], value=it[key])
            if y > 530:
                p, y = page(f"Решения по разделу {section} (продолжение)"), 75.0
            y = para(p, LEFT + 20, y, 470, f"{n}. {line}", 9.5) + 4
    for it in items:
        if it["code"] == "M-055":
            p = page("Материалы несущих конструкций")
            table(p, LEFT + 20, 70, [190, 90, 90, 90], [CONCRETE_HEAD, ["Фундаментная плита", it[key], "F150", "W8"]])
    # штамп — последним, когда известно число листов; страницы перечитываем: вставка новой
    # страницы делает прежние объекты страниц недействительными
    for n in range(doc.page_count):
        p = doc[n]
        p.insert_font(fontname="ar", fontfile=FONT)
        p.insert_font(fontname="arb", fontfile=FONT_B)
        stamp(p, code, title, stage, n + 1, doc.page_count, kind)
    doc.save(out / f"{code}.pdf")


def build_set3(out: Path) -> int:
    global OBJECT, ADDRESS
    OBJECT = "Многофункциональный жилой комплекс с подземной автостоянкой. Корпус 3"
    ADDRESS = "г. Москва, ул. Тестовая, вл. 16"
    matrix = Path(__file__).resolve().parent.parent / "data" / "matrix" / "params.csv"
    params = list(csv.DictReader(matrix.open(encoding="utf-8")))
    plan = _set3_plan(params)
    for it, p in zip(plan, params, strict=True):
        # число ищется строкой таблицы по якорю матрицы, остальное — шаблоном по названию
        anchor = p["semantic_anchors"].split("|")[0]
        it["label"] = anchor[:1].upper() + anchor[1:] if it["kind"] == "number" else it["name"]

    dates = {"П": "12.01.2026", "Р": "02.03.2026", "И": "15.07.2026"}
    statuses = {"П": "утверждена", "Р": "в производство работ", "И": ""}
    registry = []
    for stage, kind in STAGE_KIND.items():
        target = out / kind
        target.mkdir(parents=True, exist_ok=True)
        for section in SECTIONS_ORDER:
            items = [it for it in plan if it["section"] == section]
            if not items:
                continue
            code = f"2026-КТ3-{STAGE_CODE[stage]}-{section}"
            _section_doc(target, code, stage, section, items)
            registry.append((f"{code}.pdf", {"П": "ПД", "Р": "РД", "И": "ИД"}[stage], section, code,
                             "" if stage == "И" else "0", statuses[stage], dates[stage],
                             f"Раздел {section}. Сводная ведомость показателей"))
    with (out / "registry.csv").open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.writer(fh, delimiter=";")
        writer.writerow(["Имя файла", "Стадия", "Марка", "Шифр", "Изм.", "Статус", "Дата утверждения", "Наименование"])
        writer.writerows(registry)

    fields = ("expected", "section", "name", "pd", "rd", "id")
    expected = {it["code"]: {k: it[k] for k in fields} for it in plan}
    answer = out.parent / f"{out.name}.expected.json"
    answer.write_text(json.dumps(expected, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    counts = {s: sum(it["expected"] == s for it in plan) for s in ("CANDIDATE", "NEGATIVE_VERIFIED", "NOT_COMPARABLE")}
    print(f"Готово: комплект 3 в {out} — {len(registry)} документов и реестр, {len(plan)} параметров "
          f"(шрифт {Path(FONT).name})")
    print(f"Ожидается: {counts}; ответ по каждому параметру — {answer.name}")
    return 0


# ------------------------------------------------------------------ документы


def pz(out: Path, s: DemoSet) -> str:
    """ПД, раздел 1 «Пояснительная записка»: ТЭП с общей площадью — эталон."""
    code = f"{s.code}-П-ПЗ"
    title = "Раздел 1. Пояснительная записка"
    doc = pymupdf.open()
    title_page(doc, code, title, 1)
    p = new_page(doc)
    text(p, LEFT + 20, 60, s.pz_heading, 12, bold=True)
    y = table(p, LEFT + 20, 80, [30, 260, 60, 110], [TEP_HEAD, *s.pz_rows])
    para(p, LEFT + 20, y + 30, 460, s.pz_note, 10)
    stamp(p, code, title, "П", 2, 2, "Проектная документация")
    doc.save(out / f"{code}.pdf")
    return code


def kr(out: Path, s: DemoSet) -> str:
    """ПД, раздел 4 «Конструктивные решения»: классы бетона по конструкциям — эталон."""
    code = f"{s.code}-П-КР"
    title = "Раздел 4. Конструктивные и объёмно-планировочные решения"
    doc = pymupdf.open()
    title_page(doc, code, title, 4)
    p = new_page(doc)
    text(p, LEFT + 20, 60, s.kr_heading, 12, bold=True)
    y = table(p, LEFT + 20, 80, [190, 90, 90, 90], [CONCRETE_HEAD, *s.kr_rows])
    para(p, LEFT + 20, y + 30, 460, s.kr_note, 10)
    stamp(p, code, title, "П", 2, 2, "Проектная документация")
    doc.save(out / f"{code}.pdf")
    return code


def ar(out: Path, s: DemoSet) -> str:
    """РД, АР «Общие данные»: основные показатели, в том числе общая площадь."""
    code = f"{s.code}-РД-АР"
    title = "Архитектурные решения. Общие данные"
    doc = pymupdf.open()
    p = new_page(doc)
    text(p, LEFT + 20, 50, "РАБОЧАЯ ДОКУМЕНТАЦИЯ. Общие данные", 12, bold=True)
    y = 45
    if s.ar_sheets:
        text(p, LEFT + 20, 75, "Ведомость рабочих чертежей основного комплекта", 10, bold=True)
        y = table(p, LEFT + 20, 85, [50, 300, 110], s.ar_sheets)
    text(p, LEFT + 20, y + 30, "Основные показатели", 10, bold=True)
    y = table(p, LEFT + 20, y + 40, [290, 60, 110], [AR_HEAD, *s.ar_rows])
    para(p, LEFT + 20, y + 25, 460, s.ar_note, 10)
    stamp(p, code, title, "Р", 1, 1, "Рабочая документация")
    doc.save(out / f"{code}.pdf")
    return code


def kzh(out: Path, s: DemoSet) -> str:
    """РД, КЖ «Общие указания»: классы бетона по конструкциям и указания."""
    code = f"{s.code}-РД-КЖ"
    title = "Конструкции железобетонные. Общие указания"
    doc = pymupdf.open()
    p = new_page(doc)
    text(p, LEFT + 20, 50, "РАБОЧАЯ ДОКУМЕНТАЦИЯ. Общие указания", 12, bold=True)
    text(p, LEFT + 20, 75, "Материалы конструкций", 10, bold=True)
    y = table(p, LEFT + 20, 85, [190, 90, 90, 90], [CONCRETE_HEAD, *s.kzh_rows]) + 26
    for note in s.kzh_notes:
        y = para(p, LEFT + 20, y + 4, 460, note, 10)
    stamp(p, code, title, "Р", 1, 1, "Рабочая документация")
    doc.save(out / f"{code}.pdf")
    return code


def aosr(out: Path, s: DemoSet, act: Act) -> str:
    """ИД: акт освидетельствования скрытых работ."""
    name = f"АОСР №{act.number} от {act.date}"
    doc = pymupdf.open()
    p = new_page(doc)
    text(p, LEFT + 110, 55, f"АКТ освидетельствования скрытых работ № {act.number}", 12, bold=True)
    text(p, LEFT + 20, 80, "г. Москва", 10)
    text(p, RIGHT - 110, 80, f"{act.date} г.", 10)
    y = para(p, LEFT + 20, 110, 470, f"Объект капитального строительства: {OBJECT}, {ADDRESS}.", 10)
    y = para(p, LEFT + 20, y + 4, 470, f"Застройщик: {s.developer}. Лицо, осуществляющее строительство: "
             "ООО «Демо-Строй». Лицо, осуществляющее подготовку проектной документации: " + ORG + ".", 10)
    y = para(p, LEFT + 20, y + 12, 470, f"1. К освидетельствованию предъявлены следующие работы: {act.work}.", 10)
    y = para(p, LEFT + 20, y + 4, 470, f"2. Работы выполнены по проектной документации: {s.code}-РД-КЖ, лист 1.", 10)
    y = para(p, LEFT + 20, y + 4, 470,
             f"3. При выполнении работ применены: {act.materials}; арматура А500С, сертификат соответствия № 0457-26.", 10)
    y = para(p, LEFT + 20, y + 4, 470,
             "4. Предъявлены документы, подтверждающие соответствие работ предъявляемым к ним требованиям: "
             "исполнительная геодезическая схема, протокол испытаний контрольных образцов.", 10)
    y = para(p, LEFT + 20, y + 4, 470, "5. Работы выполнены в соответствии с СП 70.13330.2012.", 10)
    y = para(p, LEFT + 20, y + 4, 470, "6. Разрешается производство последующих работ.", 10)
    y += 20
    for who in ("Представитель застройщика          ____________  Смирнов К.Л.",
                "Представитель лица, осуществляющего строительство  ____________  Орлов Д.В.",
                "Представитель проектировщика        ____________  Петров А.С."):
        text(p, LEFT + 20, y, who, 9.5)
        y += 22
    doc.save(out / f"{name}.pdf")
    return name


def tech_plan(out: Path, rows: list[list[str]]) -> str:
    """ИД: технический план здания — фактическая общая площадь по обмеру."""
    name = "Технический план здания"
    doc = pymupdf.open()
    p = new_page(doc)
    text(p, LEFT + 150, 55, "ТЕХНИЧЕСКИЙ ПЛАН ЗДАНИЯ", 13, bold=True)
    y = para(p, LEFT + 20, 85, 470, f"Объект: {OBJECT}, {ADDRESS}.", 10)
    y = para(p, LEFT + 20, y + 4, 470, "Подготовлен в результате выполнения кадастровых работ в связи с созданием "
             "здания. Кадастровый инженер: Соколова М.А.", 10)
    text(p, LEFT + 20, y + 20, "Характеристики объекта недвижимости", 10, bold=True)
    y = table(p, LEFT + 20, y + 30, [300, 160], rows)
    para(p, LEFT + 20, y + 25, 470, "Площадь определена по результатам обмера в соответствии "
         "с требованиями приказа Росреестра № П/0393.", 10)
    doc.save(out / f"{name}.pdf")
    return name


def main() -> int:
    global FONT, FONT_B, OBJECT, ADDRESS
    ap = argparse.ArgumentParser(description="Контрольный комплект ПД + РД + ИД с внесёнными несоответствиями")
    ap.add_argument("out", type=Path, help="куда собрать, например «dataset/Контрольный комплект»")
    ap.add_argument("--set", choices=[*sorted(SETS), "3"], default="1",
                    help="какой комплект: 1 — жилой дом, 2 — школа, 3 — вся матрица, 132 параметра")
    ap.add_argument("--font", help="TTF со шрифтом с кириллицей, если стандартные не нашлись")
    args = ap.parse_args()
    FONT, FONT_B = find_fonts(args.font)
    if args.set == "3":
        return build_set3(args.out)
    s = SETS[args.set]
    OBJECT, ADDRESS = s.object, s.address

    folder = {"ПД": "Проектная документация", "РД": "Рабочая документация", "ИД": "Исполнительная документация"}
    dirs = {stage: args.out / name for stage, name in folder.items()}
    for d in dirs.values():
        d.mkdir(parents=True, exist_ok=True)

    pd_ok, rd_ok = "утверждена", "в производство работ"
    rows = [
        (f"{pz(dirs['ПД'], s)}.pdf", "ПД", "ПЗ", f"{s.code}-П-ПЗ", "0", pd_ok, s.pd_date, "Раздел 1. Пояснительная записка"),
        (f"{kr(dirs['ПД'], s)}.pdf", "ПД", "КР", f"{s.code}-П-КР", "0", pd_ok, s.pd_date,
         "Раздел 4. Конструктивные и объёмно-планировочные решения"),
        (f"{ar(dirs['РД'], s)}.pdf", "РД", "АР", f"{s.code}-РД-АР", "0", rd_ok, s.rd_date, "Архитектурные решения"),
        (f"{kzh(dirs['РД'], s)}.pdf", "РД", "КЖ", f"{s.code}-РД-КЖ", "0", rd_ok, s.rd_date, "Конструкции железобетонные"),
    ]
    for act in s.acts:
        name = aosr(dirs["ИД"], s, act)
        rows.append((f"{name}.pdf", "ИД", "КЖ", f"АОСР-{act.number}", "", "", act.date,
                     f"Акт освидетельствования скрытых работ № {act.number}"))
    if s.tech_plan:
        name = tech_plan(dirs["ИД"], s.tech_plan)
        rows.append((f"{name}.pdf", "ИД", "", f"ТП-{s.code}", "", "", "", "Технический план здания"))

    registry = args.out / "registry.csv"
    with registry.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.writer(fh, delimiter=";")
        writer.writerow(["Имя файла", "Стадия", "Марка", "Шифр", "Изм.", "Статус", "Дата утверждения", "Наименование"])
        writer.writerows(rows)

    print(f"Готово: комплект {args.set} в {args.out} — {len(rows)} файлов и реестр (шрифт {Path(FONT).name})")
    print(f"Ожидается: {s.expected}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
