"""Чтение исходных документов: PDF (PyMuPDF), DOCX и XML — позже.

Наружу модули отдают `ParsedDocument` по контракту `ml-events.v1`, поэтому конкретную
библиотеку можно заменить, не трогая остальной конвейер.
"""

from inspector_ml.ingest.pdf import CorruptedDocumentError, file_quality, parse_pdf

__all__ = ["CorruptedDocumentError", "file_quality", "parse_pdf"]
