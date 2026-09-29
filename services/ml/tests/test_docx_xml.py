"""Разбор DOCX и XML: `ingest/docx.py`, `ingest/xmldoc.py`, `ingest/flow.py` и задача разбора.

Файлы собираются в тесте из нескольких строк XML: так видно, какая разметка Word во что превращается,
и в репозитории нет двоичных фикстур.
"""

from __future__ import annotations

import zipfile
from collections.abc import Callable, Iterator
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from helpers import parse_envelope, store, submit, wait_for_job
from inspector_ml.api.app import create_app
from inspector_ml.config import Settings
from inspector_ml.extract.api import extractor_for
from inspector_ml.ingest.docx import parse_docx
from inspector_ml.ingest.flow import LINES_PER_PAGE, Flow
from inspector_ml.ingest.pdf import CorruptedDocumentError
from inspector_ml.ingest.xmldoc import parse_xml
from inspector_ml.jobs.callback import CallbackSender
from inspector_ml.jobs.runner import JobRunner
from inspector_ml.matrix import load_params

NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def p(text: str, *, page_break: bool = False, break_before: bool = False) -> str:
    props = "<w:pPr><w:pageBreakBefore/></w:pPr>" if break_before else ""
    br = '<w:r><w:br w:type="page"/></w:r>' if page_break else ""
    return f'<w:p>{props}{br}<w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>'


def tbl(rows: list[list[str | tuple[str, int]]]) -> str:
    """Таблица Word; ячейка `(текст, n)` объединена по горизонтали на n колонок (`w:gridSpan`)."""
    out = []
    for row in rows:
        cells = []
        for cell in row:
            text, span = cell if isinstance(cell, tuple) else (cell, 1)
            props = f'<w:tcPr><w:gridSpan w:val="{span}"/></w:tcPr>' if span > 1 else ""
            cells.append(f"<w:tc>{props}{p(text)}</w:tc>")
        out.append(f"<w:tr>{''.join(cells)}</w:tr>")
    return f"<w:tbl>{''.join(out)}</w:tbl>"


@pytest.fixture
def make_docx(tmp_path: Path) -> Callable[..., Path]:
    def make(body: str, *, header: str | None = None, name: str = "doc.docx") -> Path:
        path = tmp_path / name
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("[Content_Types].xml", "<Types/>")
            archive.writestr(
                "word/document.xml",
                f'<?xml version="1.0" encoding="UTF-8"?><w:document {NS}><w:body>{body}</w:body></w:document>',
            )
            if header is not None:
                archive.writestr("word/header1.xml", f"<w:hdr {NS}>{header}</w:hdr>")
        return path

    return make


@pytest.fixture
def make_xml(tmp_path: Path) -> Callable[..., Path]:
    def make(text: str, *, name: str = "doc.xml") -> Path:
        path = tmp_path / name
        path.write_text(text, encoding="utf-8")
        return path

    return make


TEP = [
    ["Наименование", "Ед. изм.", "Значение"],
    ["Площадь застройки", "м²", "4 200,0"],
    [("Технико-экономические показатели", 3)],
]


class TestDocx:
    def test_paragraphs_and_table_become_pages(self, make_docx: Callable[..., Path]) -> None:
        path = make_docx(p("Пояснительная записка") + tbl(TEP) + p("Второй лист", page_break=True))

        parsed = parse_docx(path, "a" * 64, "0.5.0")

        assert parsed["format"] == "DOCX"
        assert [page["page"] for page in parsed["pages"]] == [1, 2]
        first, second = parsed["pages"]
        assert {page["source"] for page in parsed["pages"]} == {"DOCX"}
        assert first["blocks"][0]["text"] == "Пояснительная записка"
        assert "Площадь застройки м² 4 200,0" in [b["text"] for b in first["blocks"]]
        assert second["blocks"][0]["text"] == "Второй лист"

    def test_table_cells_keep_columns_under_merged_cells(self, make_docx: Callable[..., Path]) -> None:
        path = make_docx(tbl(TEP))

        [table] = parse_docx(path, "a" * 64, "0.5.0")["pages"][0]["tables"]

        cells = {(c["row"], c["col"]): c["text"] for c in table["cells"]}
        assert cells[(1, 2)] == "4 200,0"
        assert cells[(2, 0)] == "Технико-экономические показатели"
        assert (2, 1) not in cells  # объединённая ячейка не плодит пустых
        rows = {c["row"]: c["bbox"][1] for c in table["cells"]}
        assert all(c["bbox"][1] == rows[c["row"]] for c in table["cells"])  # ячейки строки — на одной высоте

    def test_value_found_by_matrix_like_in_pdf(self, make_docx: Callable[..., Path]) -> None:
        """Площадь застройки из ТЭП в Word находится тем же извлечением, что и в PDF."""
        path = make_docx(p("Технико-экономические показатели") + tbl(TEP))
        pages = parse_docx(path, "a" * 64, "0.5.0")["pages"]

        found = extractor_for("M-001")(load_params()["M-001"], pages)

        assert [f.value for f in found] == [4200.0]

    def test_own_extractor_reads_paragraph(self, make_docx: Callable[..., Path]) -> None:
        path = make_docx(p("Общее водопотребление здания: 53,22 м3/сут, 26,07 м3/ч, 9,56 л/с"))
        pages = parse_docx(path, "a" * 64, "0.5.0")["pages"]

        found = extractor_for("M-016")(load_params()["M-016"], pages)

        assert [(f.rule_key, f.value) for f in found] == [("Водопотребление", 53.22)]

    def test_header_goes_as_title_block(self, make_docx: Callable[..., Path]) -> None:
        stamp = tbl([["2026-ОК3-ПД-ПЗ", ("Пояснительная записка", 2)]]) + p("Стадия П")
        path = make_docx(p("Текст"), header=stamp, name="ПЗ.docx")

        parsed = parse_docx(path, "a" * 64, "0.5.0")

        titles = [b["text"] for b in parsed["pages"][0]["blocks"] if b["type"] == "title_block"]
        assert titles == ["2026-ОК3-ПД-ПЗ Пояснительная записка", "Стадия П"]
        assert parsed["metadata"]["file_size"] == path.stat().st_size
        assert parsed["metadata"].get("pdf_version") is None

    def test_content_controls_and_break_before(self, make_docx: Callable[..., Path]) -> None:
        """Титульный лист Word лежит в `w:sdt`; «с новой страницы» — свойство абзаца."""
        body = f"<w:sdt><w:sdtContent>{p('Титульный лист')}</w:sdtContent></w:sdt>" + p("Раздел 1", break_before=True)
        parsed = parse_docx(make_docx(body), "a" * 64, "0.5.0")

        assert [[b["text"] for b in page["blocks"]] for page in parsed["pages"]] == [["Титульный лист"], ["Раздел 1"]]

    def test_not_a_docx_is_corrupted(self, tmp_path: Path) -> None:
        path = tmp_path / "broken.docx"
        path.write_bytes(b"PK\x03\x04 not really a zip")

        with pytest.raises(CorruptedDocumentError):
            parse_docx(path, "a" * 64, "0.5.0")


class TestXml:
    FORM = """<?xml version="1.0" encoding="UTF-8"?>
<Акт номер="12" xmlns="urn:example">
  <Объект>Жилой дом</Объект>
  <Показатель><Наименование>Площадь застройки</Наименование><Значение>4200,0 м²</Значение></Показатель>
</Акт>"""

    def test_pairs_and_attributes_become_rows(self, make_xml: Callable[..., Path]) -> None:
        parsed = parse_xml(make_xml(self.FORM), "b" * 64, "0.5.0")

        assert parsed["format"] == "XML"
        [page] = parsed["pages"]
        texts = [b["text"] for b in page["blocks"]]
        assert texts == ["Акт: документ XML", "Акт.номер: 12", "Объект: Жилой дом", "Площадь застройки: 4200,0 м²"]
        cells = {(c["row"], c["col"]): c["text"] for c in page["tables"][0]["cells"]}
        assert cells[(2, 0)] == "Площадь застройки" and cells[(2, 1)] == "4200,0 м²"

    def test_value_found_by_matrix(self, make_xml: Callable[..., Path]) -> None:
        pages = parse_xml(make_xml(self.FORM), "b" * 64, "0.5.0")["pages"]

        found = extractor_for("M-001")(load_params()["M-001"], pages)

        assert [f.value for f in found] == [4200.0]

    def test_broken_xml_is_corrupted(self, make_xml: Callable[..., Path]) -> None:
        with pytest.raises(CorruptedDocumentError):
            parse_xml(make_xml("<Акт><Объект>не закрыт</Акт>"), "b" * 64, "0.5.0")

    def test_external_entities_are_not_loaded(self, make_xml: Callable[..., Path], tmp_path: Path) -> None:
        secret = tmp_path / "secret.txt"
        secret.write_text("секрет", encoding="utf-8")
        text = f'<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x SYSTEM "file:///{secret.as_posix()}">]><a>&x;</a>'

        try:
            parsed = parse_xml(make_xml(text), "b" * 64, "0.5.0")
        except CorruptedDocumentError:
            return
        assert "секрет" not in str(parsed["pages"])


class TestFlow:
    def test_long_table_continues_on_next_page(self) -> None:
        flow = Flow(source="DOCX")
        flow.table([[f"строка {i}", str(i)] for i in range(LINES_PER_PAGE + 5)])

        pages = flow.result()

        assert len(pages) == 2
        assert [len(page["tables"]) for page in pages] == [1, 1]
        assert pages[1]["tables"][0]["cells"][0]["row"] == 0  # продолжение — своя таблица со своей нумерацией
        assert all(0 <= v <= 1 for page in pages for b in page["blocks"] for v in b["bbox"])

    def test_empty_document_has_no_pages(self) -> None:
        assert Flow(source="XML").result() == []


@pytest.fixture
def job_client(settings: Settings) -> Iterator[TestClient]:
    callback = CallbackSender(
        internal_token=settings.internal_token,
        delays=(0, 0, 0),
        client=httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(204))),
    )
    runner = JobRunner(settings, callback=callback)
    with TestClient(create_app(settings, runner=runner)) as client:
        yield client


class TestParseJob:
    def test_docx_job_is_parsed_and_cached(
        self, job_client: TestClient, settings: Settings, make_docx: Callable[..., Path]
    ) -> None:
        sha, key = store(settings, make_docx(p("Пояснительная записка") + tbl(TEP)))
        envelope = parse_envelope(sha, key, name="ПЗ.docx")
        envelope["payload"]["file"]["format"] = "DOCX"

        submit(job_client, envelope)
        payload = wait_for_job(job_client, envelope["message_id"])["result"]["payload"]

        assert payload["status"] == "OK", payload
        assert payload["quality"]["pages_total"] == 1
        assert payload["quality"]["pages_ocr"] == 0
        assert (settings.storage_dir / payload["parsed_ref"]["key"]).exists()

    def test_xml_job_is_parsed(self, job_client: TestClient, settings: Settings, make_xml: Callable[..., Path]) -> None:
        sha, key = store(settings, make_xml(TestXml.FORM))
        envelope = parse_envelope(sha, key, name="акт.xml")
        envelope["payload"]["file"]["format"] = "XML"

        submit(job_client, envelope)
        payload = wait_for_job(job_client, envelope["message_id"])["result"]["payload"]

        assert payload["status"] == "OK", payload

    def test_broken_docx_fails_as_corrupted(self, job_client: TestClient, settings: Settings, tmp_path: Path) -> None:
        broken = tmp_path / "broken.docx"
        broken.write_bytes(b"PK\x03\x04 not really a zip")
        sha, key = store(settings, broken)
        envelope = parse_envelope(sha, key, name="broken.docx")
        envelope["payload"]["file"]["format"] = "DOCX"

        submit(job_client, envelope)
        payload = wait_for_job(job_client, envelope["message_id"])["result"]["payload"]

        assert payload["error"]["code"] == "CORRUPTED_FILE"
