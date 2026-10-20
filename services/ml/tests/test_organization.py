"""Организация-разработчик по штампу и титулу (`metadata/organization.py`).

Строки взяты из корпуса: штампы и титулы ПД/РД Полярной, Новослободской, Алтуфьевского и ЖК на
Сущёвском валу; фамилии заменены.
"""

from __future__ import annotations

import pytest

from inspector_ml.contracts.events import DocumentMetadata
from inspector_ml.metadata.facts import describe
from inspector_ml.metadata.organization import developer_org, organizations

STAMP = [0.80, 0.95, 0.95, 0.97]  # графа 9 основной надписи: внизу справа
BODY = [0.10, 0.10, 0.90, 0.50]


def page(number: int, *, stamp: str = "", body: str = "") -> dict:
    blocks = []
    if body:
        blocks.append({"id": f"p{number}-b0", "type": "text", "text": body, "bbox": BODY})
    if stamp:
        blocks.append({"id": f"p{number}-b1", "type": "text", "text": stamp, "bbox": STAMP})
    return {"page": number, "source": "TEXT_LAYER", "blocks": blocks}


class TestLines:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("ООО «ГЕНПРОЕКТ»", ["ООО «ГЕНПРОЕКТ»"]),
            ('ООО"ТСП"', ["ООО «ТСП»"]),
            ("ООО \n“ПОССТРОЙ”", ["ООО «ПОССТРОЙ»"]),  # форма и название в разных строках
            ("Общество с ограниченной ответственностью «Моспроекткомплекс»", ["ООО «Моспроекткомплекс»"]),
            ('ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ\n"СТАНДАРТПРОЕКТ"', ["ООО «СТАНДАРТПРОЕКТ»"]),
            ('ООО "АПСАЙД ИНЖИНИРИНГ", ОГРН 1167746504540, ИНН 7743157043', ["ООО «АПСАЙД ИНЖИНИРИНГ»"]),
            ("ООО «Архитектурный Диалог с\nМегаполисом»", ["ООО «Архитектурный Диалог с Мегаполисом»"]),
            ("ООО «В Е Л Е С»", ["ООО «ВЕЛЕС»"]),  # набрано вразрядку
            ("ООО «НПП «ЭПОТОС»»", ["ООО «НПП «ЭПОТОС»»"]),
            ("ГАУ Институт Генплана Москвы»", ["ГАУ «Институт Генплана Москвы»"]),  # OCR потерял открывающую
            ("ПАО «Северсталь»»", ["ПАО «Северсталь»"]),
            ("ООО Апсайд Инжиниринг", ["ООО «Апсайд Инжиниринг»"]),
            ("Генеральный директор ООО ″Моспроекткомплекс″     Петров П.П.", ["ООО «Моспроекткомплекс»"]),
            ("Разработчик: ООО «ВСМ»", ["ООО «ВСМ»"]),
            # род деятельности отдельной строкой между формой и названием
            (
                "ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ\nПРОЕКТНАЯ КОМПАНИЯ\n«ГЕОСТРОЙПРОЕКТ»",
                ["ООО «ПРОЕКТНАЯ КОМПАНИЯ «ГЕОСТРОЙПРОЕКТ»»"],
            ),
            ('ООО Фирма "Русь Трей"', ["ООО «Фирма «Русь Трей»»"]),
        ],
    )
    def test_found(self, text: str, expected: list[str]) -> None:
        assert organizations(text) == expected

    @pytest.mark.parametrize(
        "text",
        [
            'Заказчик: ООО "ФИРМА РУСЬ ТРЕЙ"',
            "Заказчик:\nООО «Апсайд Инжиниринг»",  # роль строкой выше
            'АНО "РСИ"\nЗаказчик:',  # роль строкой ниже, как в штампе топоплана
            'В ПРОИЗВОДСТВО РАБОТ\nООО "Апсайд Инжиниринг"',  # штамп выдачи в работу — заказчик
            'Масштаб 1:500\nООО "Планета Изысканий"',  # штамп топографической подосновы
            '© ГБУ "Мосгоргеотрест"',
            "ООО «СЗ «Апсайд Новослободская»",  # специализированный застройщик — заказчик
            "ООО «С3 Апсайд Новослободская»",  # то же после OCR: цифра 3 вместо «З»
            "гуп «Мосводосток» или по его указанию",  # перенос строки в тексте записки
            "АО «Мосводоканал» выдал технические условия",  # за названием — фраза, а не реквизиты
            "4.2. АО «Мосводоканал» имеет право:",
            "выполненного ООО «Планета Изысканий» в 2022 г.;",
            "за рамки зон контроля конкретного ИП. Для точечных ИП зона контроля",  # ИП — измерительный прибор
            "ООО",
        ],
    )
    def test_not_a_developer(self, text: str) -> None:
        assert organizations(text) == []

    def test_sole_proprietor_without_surname(self) -> None:
        """У индивидуального предпринимателя название — фамилия человека: её не сохраняем (152-ФЗ)."""
        assert organizations("ИП «Иванов И.И.»") == ["ИП"]


class TestDeveloper:
    def test_executive_documentation_is_left_empty(self) -> None:
        pages = [page(1, stamp="ООО «ГЕНПРОЕКТ»"), page(2, stamp="ООО «ГЕНПРОЕКТ»")]

        assert developer_org(pages, "ID") == (None, 0.0)

    def test_stamp_and_cover_agree(self) -> None:
        pages = [page(1, body="ООО «ГЕНПРОЕКТ»"), page(2, stamp="ООО «ГЕНПРОЕКТ»"), page(3, stamp="ООО «ГЕНПРОЕКТ»")]

        assert developer_org(pages, "PD") == ("ООО «ГЕНПРОЕКТ»", 0.9)

    def test_subcontractor_in_stamp_beats_general_designer_on_cover(self) -> None:
        """Том субподрядчика: на титуле генпроектировщик, в графе 9 — тот, кто том выпустил."""
        pages = [
            page(1, body="Общество с ограниченной ответственностью\n«БратКом-групп»"),
            page(2, body="Общество с ограниченной ответственностью\n«БратКом-групп»"),
            page(3, body="Состав тома"),
            *(page(number, stamp="ООО«ТСП»") for number in range(4, 8)),
        ]

        assert developer_org(pages, "PD") == ("ООО «ТСП»", 0.8)

    def test_letter_in_appendix_does_not_win(self) -> None:
        """Бланк письма с ТУ — организация на одном листе; разработчик берётся с титула."""
        pages = [
            page(1, body="ООО «ГЕНПРОЕКТ»"),
            *(page(number, body="Пояснительная записка") for number in range(2, 9)),
            page(9, stamp='ПАО "МГТС"'),
        ]

        assert developer_org(pages, "PD") == ("ООО «ГЕНПРОЕКТ»", 0.6)

    def test_last_cover_page_wins(self) -> None:
        """За титулом генпроектировщика идёт титул того, кто выпустил том."""
        pages = [
            page(1, body="ООО «ГЕНПРОЕКТ»"),
            page(2, body="ООО «ГЕНПРОЕКТ»"),
            page(3, body="ООО «ВЕЛЕС»"),
        ]

        assert developer_org(pages, "PD") == ("ООО «ВЕЛЕС»", 0.6)

    def test_truncated_stamp_takes_full_name_from_cover(self) -> None:
        pages = [
            page(1, body="ООО «Архитектурный Диалог с Мегаполисом»"),
            page(2, stamp="ООО «Архитектурный Диалог с"),
            page(3, stamp="ООО «Архитектурный Диалог с"),
        ]

        assert developer_org(pages, "RD") == ("ООО «Архитектурный Диалог с Мегаполисом»", 0.9)

    def test_nothing_found(self) -> None:
        assert developer_org([page(1, body="Пояснительная записка")], "PD") == (None, 0.0)


def test_describe_adds_developer_with_confidence() -> None:
    pages = [page(1, body="Проектная документация. Раздел 4. Конструктивные решения\nООО «ГЕНПРОЕКТ»")]
    metadata = describe(pages, file_name="22-14-П-КР1.pdf")

    assert metadata["developer_org"] == "ООО «ГЕНПРОЕКТ»"
    assert metadata["field_confidence"]["developer_org"] == 0.6
    assert "doc_stage" in metadata["field_confidence"]  # уверенности полей контракта не потерялись


def test_developer_survives_the_contract_model() -> None:
    """С событий 0.7.0 `DocumentMetadata` поле знает и не отбрасывает: api получает его в `ParseResult`."""
    pages = [page(1, body="Проектная документация. Раздел 4. Конструктивные решения\nООО «ГЕНПРОЕКТ»")]
    metadata = DocumentMetadata.model_validate(describe(pages, file_name="22-14-П-КР1.pdf"))

    assert metadata.developer_org == "ООО «ГЕНПРОЕКТ»"
    assert metadata.field_confidence["developer_org"] == 0.6
