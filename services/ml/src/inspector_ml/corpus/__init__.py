"""Работа с выгрузкой организаторов: имена файлов, разметка, сверка разбора.

Пакет называется `corpus`, а не `dataset`, потому что корневой `.gitignore` игнорирует любую
папку с именем `dataset/` — сами данные в репозиторий не попадают, а код должен.
"""

from inspector_ml.corpus.labels import Split, pdf_files, read_jsonl
from inspector_ml.corpus.names import fix_name

__all__ = ["Split", "fix_name", "pdf_files", "read_jsonl"]
