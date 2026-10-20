"""Что движку сравнения нужно от извлечения (граница «extract ↔ compare», docs/services/ml.md).

Классы ``LoadedDocument`` и ``Extraction`` объявляет ``extract/api.py``. Движок опирается
только на их поля — через протоколы, поэтому его можно тестировать на фейковых значениях,
пока извлечения нет, и не зависеть от порядка появления модулей.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any, Protocol

from inspector_ml.contracts.events import DocumentMetadata, EvidenceFragment, MatrixParam


class Document(Protocol):
    """Документ актуальной редакции, переданный в извлечение."""

    @property
    def file_id(self) -> Any: ...

    @property
    def sha256(self) -> str: ...

    @property
    def metadata(self) -> DocumentMetadata: ...


class Extraction(Protocol):
    """Одно найденное значение параметра в одном документе."""

    @property
    def param_code(self) -> str: ...

    @property
    def stage(self) -> str: ...

    @property
    def file_id(self) -> Any: ...

    @property
    def rule_key(self) -> str | None: ...

    @property
    def raw_value(self) -> str: ...

    @property
    def value(self) -> float | str | bool | None: ...

    @property
    def unit(self) -> str | None: ...

    @property
    def fragment(self) -> EvidenceFragment: ...


Extractor = Callable[[MatrixParam, Sequence[Document]], Sequence[Extraction]]
