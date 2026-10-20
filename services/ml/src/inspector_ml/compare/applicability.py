"""Применимость параметра к объекту — верхний узел дерева статусов (docs/domain/statuses.md §4).

Признаков объекта во входных данных нет, решение
наше. Судим по двум основаниям, которые движку действительно доступны:

1. матрица не указывает источник параметра ни в одной стадии — проверять нечего;
2. раздел параметра (ПЗ, КР, АР, ИОС4 …) не представлен в комплекте и не ожидается по реестру.

Второе основание работает **только при наличии реестра**: без ожидаемого состава отсутствие раздела
означает лишь, что полнота не подтверждена, а не что раздела у объекта нет. Тогда
параметр остаётся применимым, а нехватка источников уходит в ``MISSING_EVIDENCE`` — инспектор увидит
пробел, а не «неприменимо». Инспектор всегда может решить иначе (``PARAMETER_NOT_APPLICABLE``).
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass, field

from inspector_ml.compare.values import STAGES, norm_code, plain, source_text
from inspector_ml.contracts.events import CompareRequest, MatrixParam

# Раздел матрицы → марки и шифры, которыми он может быть представлен в ПД, РД и ИД.
# Разделы ПД по 87-ПП (подраздел 1 раздела 5 — электроснабжение, а не водоснабжение: на этом я
# один раз уже ошибся и сдвинул всю шкалу ИОС), марки РД — по ГОСТ Р 21.101.
#
# Таблица ручная и потому неполная: она задаёт синонимы, которых нет в тексте матрицы («АС» для
# «АР»), а сами марки разделов берутся из матрицы — ``matrix_marks``. Раздела нет нигде → судить
# не берёмся.
SECTION_MARKS: dict[str, frozenset[str]] = {
    # ОПЗ — «общая пояснительная записка», как её называют в шифрах: «01-07-22-14-П-ОПЗ Изм 2».
    # Без этого синонима марка из имени файла отсеивалась фильтром KNOWN_MARKS, раздел ПЗ выглядел
    # отсутствующим, и M-002 («Общая площадь здания») уходил в NOT_APPLICABLE на объекте, где
    # пояснительная записка есть. Поймано 22.09 на «Речников ул. 7-7».
    "ПЗ": frozenset({"ПЗ", "ОПЗ"}),
    "СПЗУ": frozenset({"СПЗУ", "ПЗУ", "ГП"}),
    "АР": frozenset({"АР", "АС", "АТЗ"}),
    "КР": frozenset({"КР", "КЖ", "КМ", "КМД", "КД"}),
    "ИОС1": frozenset({"ИОС1", "ИОС", "ЭОМ", "ЭМ", "ЭГ", "ЭС"}),  # электроснабжение
    "ИОС2": frozenset({"ИОС2", "ИОС", "ВК"}),  # водоснабжение
    "ИОС3": frozenset({"ИОС3", "ИОС", "ВК", "НВК"}),  # водоотведение
    "ИОС4": frozenset({"ИОС4", "ИОС", "ОВ", "ОВИК"}),  # отопление и вентиляция
    "ИОС5": frozenset({"ИОС5", "ИОС", "СС", "АПС", "СОУЭ", "СКС", "АК"}),  # сети связи
    "ПОС": frozenset({"ПОС"}),
    "ООС": frozenset({"ООС", "ПМООС"}),
    "ОДИ": frozenset({"ОДИ", "ОДМ"}),
    "ППМ": frozenset({"ППМ"}),
    "ПОД": frozenset({"ПОД"}),
    "ЗУ": frozenset({"ЗУ", "ГПЗУ"}),
    "СМ": frozenset({"СМ", "СД"}),
}

#: Марка в описании источника пишется в скобках: «Раздел ЭОМ: Однолинейные схемы (ЭОМ/ЭМ)».
PAREN = re.compile(r"\(([^)]*)\)")
#: Стадия в тех же скобках — не марка: «Технический план БТИ (ИД)».
STAGE_LABELS = frozenset({"ПД", "РД", "ИД"})


KNOWN_MARKS: frozenset[str] = frozenset().union(*SECTION_MARKS.values())
"""Все марки из таблицы — ими фильтруем имена файлов и прозу в описании источника."""


def marks(*texts: str | None) -> set[str]:
    """Марки и разделы, упомянутые в тексте: «НВС-2025.03-4.1-КР1» → {«КР1», «КР»}."""
    found: set[str] = set()
    for text in texts:
        for token in re.split(r"[^0-9A-ZА-ЯЁ]+", norm_code(text)):
            if match := re.fullmatch(r"([А-ЯЁA-Z]{2,5})(\d*)", token):
                found.add(token)
                found.add(match.group(1))
    return found


def doc_marks(discipline: str | None, document_code: str | None, file_name: str | None) -> set[str]:
    """Марки документа. Марка и шифр — как есть, из имени файла — только знакомые марки.

    Имя файла даёт много мусора, начиная с расширения: без фильтра у «скан.pdf» нашлись бы марки
    «СКАН» и «PDF», и документ без марки выглядел бы опознанным.
    """
    stem = (file_name or "").rsplit(".", 1)[0]
    return marks(discipline, document_code) | (marks(stem) & KNOWN_MARKS)


def matrix_marks(params: Iterable[MatrixParam]) -> dict[str, frozenset[str]]:
    """Марки разделов из самой матрицы: раздел → марки в скобках у его источников.

    Второй ручной справочник рано или поздно разойдётся с матрицей — у меня он разошёлся на все
    пять подразделов ИОС. Поэтому основной источник марок теперь матрица, а ``SECTION_MARKS``
    добавляет к ней синонимы, которых в тексте нет.

    Лишняя марка здесь безопасна (параметр останется применимым), недостающая — нет: параметр
    молча исчезнет из проверки. Поэтому берём широко и не чистим прозу вроде «(песок)».
    """
    table: dict[str, set[str]] = {}
    for param in params:
        section = norm_code((plain(param.section) or "").strip())
        if not section:
            continue
        found = table.setdefault(section, {section} | set(SECTION_MARKS.get(section, ())))
        if section.startswith("ИОС"):
            found.add("ИОС")
        for stage in STAGES:
            for group in PAREN.findall(source_text(param, stage) or ""):
                for part in re.split(r"[/,;]", group):
                    token = norm_code(part.strip())
                    if re.fullmatch(r"[А-ЯЁA-Z]{2,5}\d?", token) and token not in STAGE_LABELS:
                        found.add(token)
    return {section: frozenset(found) for section, found in table.items()}


@dataclass(frozen=True)
class ObjectSections:
    """Разделы, которые есть у объекта: по загруженным файлам и по ожидаемому составу из реестра."""

    marks: frozenset[str]
    has_registry: bool
    expected_count: int
    by_section: dict[str, frozenset[str]]
    """Раздел матрицы → его марки: ``SECTION_MARKS`` плюс то, что сказано в самой матрице."""
    by_file: dict[str, frozenset[str]] = field(default_factory=dict)
    """Файл → его марки: по ним значение параметра берётся из документов его раздела."""

    @property
    def can_judge(self) -> bool:
        """Без реестра и без единой распознанной марки утверждать неприменимость нельзя."""
        return self.has_registry and bool(self.marks)

    def allowed(self, section: str) -> frozenset[str] | None:
        """Марки раздела или ``None``, если раздел незнаком — тогда о применимости не судим."""
        code = norm_code(section)
        return self.by_section.get(code) or SECTION_MARKS.get(code)


def sections_of(request: CompareRequest) -> ObjectSections:
    found: set[str] = set()
    by_file: dict[str, frozenset[str]] = {}
    for f in request.files:
        if plain(f.metadata.doc_stage) in STAGES:
            file_marks = frozenset(doc_marks(f.metadata.discipline, f.metadata.document_code, f.original_name))
            by_file[str(f.file_id)] = file_marks
            found |= file_marks
    expected = request.expected_documents or []
    for e in expected:
        found |= doc_marks(e.discipline, e.document_code, e.file_name)
    # Есть ли реестр — говорит api (`registry_status`), а не длина списка: «реестр есть, но пуст»
    # и «реестра нет» раньше были неразличимы. Старый запрос без поля — по списку.
    status = plain(request.registry_status)
    has_registry = status == "PRESENT" if status else bool(expected)
    return ObjectSections(frozenset(found), has_registry, len(expected), matrix_marks(request.matrix.params), by_file)


def reason(param: MatrixParam, sections: ObjectSections, has_sources: bool) -> str | None:
    """Основание неприменимости параметра к объекту либо ``None``, если параметр применим."""
    if not has_sources:
        return "В матрице не указаны источники параметра ни в одной стадии"
    section = (plain(param.section) or "").strip()
    allowed = sections.allowed(section)
    if not allowed or not sections.can_judge or allowed & sections.marks:
        return None
    return (
        f"Раздел «{section}» не представлен в комплекте и не ожидается по реестру"
        f" ({sections.expected_count} документов), параметр к объекту не относится"
    )
