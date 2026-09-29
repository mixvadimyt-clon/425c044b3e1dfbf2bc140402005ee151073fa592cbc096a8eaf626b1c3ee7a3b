"""Изменённые числа в совпадающем тексте ПД и РД (`suspicion/number_diff.py`).

Основной пример — пара ИОС3.2, пришедшая со стенда 26.09: текст один, в РД поменяли R0 грунта,
суточный и секундный расход. Двух из этих величин в матрице нет вовсе.
"""

from __future__ import annotations

import uuid

from inspector_ml.contracts.events import DocumentMetadata
from inspector_ml.extract.api import LoadedDocument
from inspector_ml.suspicion import number_diff

PD_TEXT = (
    "1. Устройство выпусков хозяйственно – бытовой канализации из труб ВЧШГ Ø100мм по ГОСТ ISO 2531-2022 "
    "с внутренним ЦПП и наружным покрытием из сплава цинка с алюминием с минимальной массой 400г/м2. "
    "Трубопровод на выпусках прокладывается открытым способом работ в стальном футляре Ø325х7мм по ГОСТ 10704-91. "
    "2. Основанием трубопроводу будут служить грунты ИГЭ-2: суглинок коричневый, полутвердый, с прослоями супеси "
    "R0=270кПа. Трубопровод прокладывается выше уровня грунтовых вод. 3. Расчётные расходы в соответствии с "
    "балансом водопотребления и водоотведения составят: Q = 123,576м3/сут.; q = 8,397 л/с. Проектируемые "
    "канализационные сети безнапорные."
)


def page(text: str, number: int = 1) -> dict:
    """Страница: каждое предложение — отдельный блок, как в разборе текстового слоя."""
    blocks = [
        {"id": f"b{i}", "type": "text", "text": sentence, "bbox": [0.1, 0.05 + 0.03 * i, 0.9, 0.07 + 0.03 * i]}
        for i, sentence in enumerate(part for part in text.split(". ") if part)
    ]
    return {"page": number, "source": "TEXT_LAYER", "quality": "OK", "blocks": blocks}


def doc(stage: str, *pages: dict, code: str = "19-0322-ОК-1/Н-ИОС3.2-ПЗ") -> LoadedDocument:
    return LoadedDocument(
        file_id=uuid.uuid4(),
        sha256=stage.lower() * 32,
        metadata=DocumentMetadata(doc_stage=stage, document_code=code),
        parsed={"pages": list(pages)},
    )


def descriptions(pd_text: str, rd_text: str, **kwargs) -> list[str]:
    found = number_diff.run([doc("PD", page(pd_text)), doc("RD", page(rd_text))], "obj", **kwargs)
    return [s.description.split(". Текст")[0] for s in found]


def test_three_changed_numbers_of_the_stand_pair() -> None:
    rd = PD_TEXT.replace("R0=270кПа", "R0=300кПа").replace("123,576", "125,576").replace("8,397", "11,397")

    assert descriptions(PD_TEXT, rd) == [
        "с прослоями супеси R0 — в ПД 270 кПа, в РД 300 кПа",
        "водопотребления и водоотведения составят: Q — в ПД 123,576 м3/сут, в РД 125,576 м3/сут",
        "q — в ПД 8,397 л/с, в РД 11,397 л/с",
    ]


def test_hypothesis_has_evidence_on_both_stages() -> None:
    rd = PD_TEXT.replace("R0=270кПа", "R0=300кПа")
    [found] = number_diff.run([doc("PD", page(PD_TEXT)), doc("RD", page(rd))], "obj")

    roles = [(str(e.role.root), str(e.stage.root), e.page) for e in found.evidence]
    assert roles == [("EXPECTED", "PD", 1), ("ACTUAL", "RD", 1)]
    assert "270" in found.evidence[0].text_snippet and "300" in found.evidence[1].text_snippet
    assert found.confidence <= number_diff.CONFIDENCE
    assert str(found.discovery_method.root) == "SEMANTIC_DISSONANCE"


def test_same_text_gives_nothing() -> None:
    assert descriptions(PD_TEXT, PD_TEXT) == []


def test_changed_words_are_not_a_number_change() -> None:
    """Слова поменялись — это другой текст, а не то же с другим числом."""
    rd = PD_TEXT.replace("с прослоями супеси R0=270кПа", "с линзами песка средней крупности R0=300кПа")

    assert descriptions(PD_TEXT, rd) == []


def test_dates_years_codes_and_sheet_numbers_are_ignored() -> None:
    pd = PD_TEXT + " Договор № 15 от 29.12.2022 г. Лист 4. Шифр 19-0322-ОК-1/Н-ИОС3.2 том 5.3.2 по ГОСТ 9.602-2016."
    rd = PD_TEXT + " Договор № 16 от 30.12.2023 г. Лист 5. Шифр 19-0322-ОК-2/Н-ИОС3.4 том 5.3.4 по ГОСТ 9.603-2016."

    assert descriptions(pd, rd) == []


def test_other_datasheet_by_the_same_form_is_not_compared() -> None:
    """Лист данных другой установки по тому же бланку: поменялась бо́льшая часть чисел."""
    form = (
        "Установка приточная. Производительность {0} м3/ч. Свободный напор {1} Па. Скорость в сечении {2} м/с. "
        "Мощность двигателя {3} кВт. Расход теплоносителя {4} м3/ч. Потеря давления по воде {5} кПа."
    )
    pd = form.format(4510, 390, 3.1, 2.2, 0.63, 1.3)
    rd = form.format(960, 180, 1.8, 0.75, 4.41, 16.8)

    assert descriptions(pd, rd) == []


def test_change_already_found_by_the_engine_is_not_repeated() -> None:
    rd = PD_TEXT.replace("123,576", "125,576")

    assert descriptions(PD_TEXT, rd, known=[("123.576", "125.576")]) == []


def test_page_of_rd_goes_to_one_page_of_pd() -> None:
    """Две страницы ПД похожи на одну страницу РД — сравнивается только самая похожая пара."""
    rd_text = PD_TEXT.replace("R0=270кПа", "R0=300кПа")
    near = PD_TEXT
    far = PD_TEXT.replace("Проектируемые канализационные сети безнапорные.", "Сети напорные из труб ПЭ100.")
    found = number_diff.run([doc("PD", page(near, 1), page(far, 2)), doc("RD", page(rd_text))], "obj")

    assert [e.page for s in found for e in s.evidence if str(e.role.root) == "EXPECTED"] == [1]


def test_nothing_without_both_stages() -> None:
    assert number_diff.run([doc("PD", page(PD_TEXT))], "obj") == []
