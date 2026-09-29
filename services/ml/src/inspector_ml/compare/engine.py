"""Движок сравнения ПД / РД / ИД: ``CompareRequest`` + извлечённые значения → ``CompareResult``.

Порядок проверки атомарного правила — дерево из docs/domain/statuses.md §4:
применимость → нужные стадии → актуальная редакция → значения извлечены и сопоставимы → срабатывание.
Эталон — ПД (прошла экспертизу): значения ПД идут как EXPECTED, РД и ИД — как ACTUAL.
Если параметр в ПД не проверяется (нет источника), эталоном становится первая стадия из источников матрицы.
Модель никогда не выдаёт CONFIRMED_VIOLATION и SUSPICION в ``checks`` — это решение инспектора и гипотезы.
"""

from __future__ import annotations

import time
from collections.abc import Iterable, Sequence

from inspector_ml.compare import applicability, incremental, matching, pagepairs, triggers
from inspector_ml.compare.comparators import Incomparable, Outcome, compare
from inspector_ml.compare.keys import finding_key, manifest_hash
from inspector_ml.compare.ports import Document, Extraction, Extractor
from inspector_ml.compare.scenario import StagedFile, missing_expected, scenario, upload_status
from inspector_ml.compare.selection import Selection, select_files
from inspector_ml.compare.values import (
    STAGE_LABEL,
    STAGES,
    plain,
    required_stages,
    source_text,
    stage_order,
)
from inspector_ml.contracts.events import (
    CheckResult,
    CompareRequest,
    CompareResult,
    DocStage,
    EvidenceFragment,
    EvidenceRole,
    MatrixParam,
    PagePairResult,
)
from inspector_ml.logging import get_logger
from inspector_ml.suspicion.rules import logical

log = get_logger(__name__)

ENGINE_VERSION = "compare-0.7.0"
BAD_QUALITY = frozenset({"LOW_QUALITY", "ABSTAIN"})


def _sentence(text: str) -> str:
    """Вывод сравнения как отдельное предложение: «понижение: B30 → B25» → «Понижение: B30 → B25»."""
    return text[:1].upper() + text[1:]


def _display(x: Extraction) -> str:
    value = x.value
    if isinstance(value, float):
        return f"{value:g}"
    return str(value) if value is not None else x.raw_value


class _ParamRun:
    """Проверка одного параметра матрицы: атомарные правила по ``rule_key``."""

    def __init__(
        self,
        request: CompareRequest,
        param: MatrixParam,
        selection: Selection,
        sections: applicability.ObjectSections,
    ) -> None:
        self.request = request
        self.param = param
        self.selection = selection
        self.sections = sections
        self.stages = required_stages(param)
        self.found: list[Extraction] = []
        """Извлечённые значения параметра — их же берут логические правила."""
        self.present = selection.stages_present
        self.priority = plain(param.review_priority)
        self.trigger = triggers.for_param(param)
        # предел из матрицы («< 0.9 м») проверяется и без эталона — значение РД/ИД сравнивается с ним
        self.limit_only = self.trigger.has_limit and plain(param.data_type) == "number"

    def stage(self, x: Extraction) -> str:
        return self.selection.stage_of.get(str(x.file_id), x.stage)

    def check(
        self, rule_key: str | None, status: str, completeness: str, rationale: str, **extra: object
    ) -> CheckResult:
        return CheckResult.model_validate(
            {
                "finding_key": finding_key(self.request.object_id, self.param.code, rule_key),
                "param_code": self.param.code,
                "rule_key": rule_key,
                "finding_status": status,
                "completeness_status": completeness,
                "review_priority": self.priority,
                "risk_level": self.priority,
                "rationale": rationale,
                "rationale_source": "RULES",
                "normative_reference": triggers.normative_reference(self.param),
                "unit": self.param.unit,
                "fragments": [],
                **extra,
            }
        )

    def missing(self, stage: str, why: str) -> str:
        source = source_text(self.param, stage)
        return f"{STAGE_LABEL[stage]}: {why}" + (f" ({source})" if source else "")

    def run(self, docs: Sequence[Document], extract: Extractor) -> tuple[list[CheckResult], set[str]]:
        # узел B дерева: неприменимый параметр не даёт ни сравнения, ни нехватки источников
        if reason := applicability.reason(self.param, self.sections, has_sources=bool(self.stages)):
            return [self.check(None, "NOT_APPLICABLE", "NOT_APPLICABLE", reason)], set()

        allowed = {str(d.file_id) for d in docs if self.selection.stage_of.get(str(d.file_id)) in self.stages}
        param_docs = self.own_section([d for d in docs if str(d.file_id) in allowed])
        found = [x for x in extract(self.param, param_docs) if str(x.file_id) in allowed] if param_docs else []
        self.found = found
        absent = [s for s in self.stages if s not in self.present]
        # стадия есть, но значения параметра в ней нет совсем — нехватка источника для полноты комплекта
        short = {s for s in self.stages if s in self.present and not any(self.stage(x) == s for x in found)}

        if not found:
            if absent:
                return [
                    self.check(
                        None,
                        "MISSING_EVIDENCE",
                        "MISSING_EVIDENCE",
                        "Нет документов стадий: " + ", ".join(STAGE_LABEL[s] for s in absent),
                        missing_sources=[self.missing(s, "нет документов") for s in absent],
                    )
                ], short
            return [
                self.check(
                    None,
                    "NOT_COMPARABLE",
                    "NOT_COMPARABLE",
                    "Значение параметра не найдено в документах",
                    missing_sources=[self.missing(s, "значение не найдено") for s in self.stages],
                )
            ], short

        # одна контрольная точка — одна группа: «пом. 1.09» в ПД и «Помещение 1-09» в РД сопоставляются
        groups = matching.group(found, self.stage)
        return [self.rule(self.display_key(items), items) for items in groups], short

    def own_section(self, docs: Sequence[Document]) -> list[Document]:
        """Документы раздела параметра — в каждой стадии, где они есть; иначе все документы стадии.

        Общий разбор по матрице ищет значение по названию во всём комплекте. Одинаково названные
        показатели разных разделов («Класс энергетической эффективности» в ПЗ и «…здания» в ЗУ,
        ширины эвакуационных путей в АР, ППМ и ОДИ) давали бы по два значения в стадии и «нужен
        выбор источника» вместо сравнения. Матрица прямо говорит, где искать (источник — раздел),
        и этого держимся. Если документов раздела в стадии нет — акты ИД часто без марки, — берём
        все документы стадии, как раньше: лучше найти значение не там, чем не найти вовсе.
        """
        section = self.sections.allowed((plain(self.param.section) or "").strip())
        if not section or not self.sections.by_file:
            return list(docs)
        by_stage: dict[str, list[Document]] = {}
        for d in docs:
            by_stage.setdefault(self.selection.stage_of.get(str(d.file_id), ""), []).append(d)
        chosen: list[Document] = []
        for group in by_stage.values():
            own = [d for d in group if self.sections.by_file.get(str(d.file_id), frozenset()) & section]
            chosen.extend(own or group)
        return chosen

    def display_key(self, items: list[Extraction]) -> str | None:
        """Подпись точки (location в выгрузке) — как в эталоне (ПД), иначе как в первом найденном документе."""
        ordered = sorted(items, key=lambda x: stage_order(self.stage(x)))
        return ordered[0].rule_key

    def fragments(self, items: Iterable[Extraction], reference: str) -> list[EvidenceFragment]:
        ordered = sorted(items, key=lambda x: stage_order(self.stage(x)))
        return [
            x.fragment.model_copy(
                update={
                    "role": EvidenceRole("EXPECTED" if self.stage(x) == reference else "ACTUAL"),
                    "stage": DocStage(self.stage(x)),
                }
            )
            for x in ordered
        ]

    def rule(self, rule_key: str | None, items: list[Extraction]) -> CheckResult:
        reference = self.stages[0]
        expected = [x for x in items if self.stage(x) == reference]
        actual = [x for x in items if self.stage(x) != reference]
        found_stages = sorted({self.stage(x) for x in items}, key=stage_order)
        missing_sources = [
            self.missing(s, "нет документов" if s not in self.present else "значение не найдено")
            for s in self.stages
            if s not in found_stages
        ]
        # REQ-CMP-06: правилу хватает двух стадий — загруженная третья получает пометку неприменимости
        missing_sources += [
            f"{STAGE_LABEL[s]}: параметр в этой стадии не проверяется (NOT_APPLICABLE)"
            for s in STAGES
            if s not in self.stages and s in self.present
        ]
        confidences = [x.fragment.confidence for x in items if x.fragment.confidence is not None]
        common = {
            "stages_compared": found_stages,
            "missing_sources": missing_sources,
            "fragments": self.fragments(items, reference),
            "confidence": min(confidences) if confidences else None,
            "expected_value": _display(expected[0]) if expected else None,
            "actual_value": _display(actual[0]) if actual else None,
            "unit": (expected[0].unit if expected else None) or (actual[0].unit if actual else None) or self.param.unit,
        }

        # Значение взято из неоднозначной редакции — вывод о нарушении ждёт выбора инспектора
        conflicts = list(dict.fromkeys(c for x in items if (c := self.selection.conflicts.get(str(x.file_id)))))
        if conflicts:
            reason = "Вывод о нарушении заблокирован: " + "; ".join(c.describe() for c in conflicts)
            return self.check(rule_key, "CLARIFICATION_REQUIRED", "CLARIFICATION_REQUIRED", reason, **common)

        bad = sorted({STAGE_LABEL[self.stage(x)] for x in items if plain(x.fragment.quality) in BAD_QUALITY})
        if bad:
            reason = "Низкое качество распознавания страницы, из которой взято значение: " + ", ".join(bad)
            return self.check(rule_key, "NOT_COMPARABLE", "NOT_COMPARABLE", reason, **common)

        if not expected and not self.limit_only:
            status = "MISSING_EVIDENCE" if reference not in self.present else "NOT_COMPARABLE"
            reason = f"Эталонное значение ({STAGE_LABEL[reference]}) не найдено"
            return self.check(rule_key, status, status, reason, **common)

        if not actual:
            others = [s for s in self.stages if s != reference]
            status = "MISSING_EVIDENCE" if others and all(s not in self.present for s in others) else "NOT_COMPARABLE"
            labels = ", ".join(STAGE_LABEL[s] for s in others) or "другой стадии"
            reason = f"Нет фактического значения ({labels}) для сравнения с эталоном"
            return self.check(rule_key, status, status, reason, **common)

        variants = sorted({_display(x) for x in expected})
        if len(variants) > 1:
            reason = (
                f"В эталоне ({STAGE_LABEL[reference]}) несколько разных значений ({', '.join(variants)}),"
                " нужен выбор источника"
            )
            return self.check(rule_key, "CLARIFICATION_REQUIRED", "CLARIFICATION_REQUIRED", reason, **common)

        # То же правило для фактических стадий. Без него из нескольких значений одной стадии
        # выбиралось первое сработавшее — и параметр без ключа точки (общий разбор по матрице
        # находит значения на разных листах) давал кандидата по первому же отличию.
        for stage in dict.fromkeys(self.stage(a) for a in actual):
            spread = sorted({_display(a) for a in actual if self.stage(a) == stage})
            if len(spread) > 1:
                reason = (
                    f"В {STAGE_LABEL[stage]} несколько разных значений ({', '.join(spread)}), нужен выбор источника"
                )
                return self.check(rule_key, "CLARIFICATION_REQUIRED", "CLARIFICATION_REQUIRED", reason, **common)

        base = expected[0] if expected else None
        outcomes = []
        for a in actual:
            outcome = compare(self.param, base, a)
            if isinstance(outcome, Incomparable):
                shown = f"{STAGE_LABEL[reference]} «{base.raw_value}», " if base else ""
                reason = f"Значения несопоставимы: {shown}{STAGE_LABEL[self.stage(a)]} «{a.raw_value}»"
                reason += f". Причина: {outcome.reason}" if outcome.reason else ""
                return self.check(rule_key, "NOT_COMPARABLE", "NOT_COMPARABLE", reason, **common)
            outcomes.append((a, outcome))

        triggered = [(a, o) for a, o in outcomes if o.triggered]
        chosen, outcome = triggered[0] if triggered else outcomes[0]
        parts = [f"{STAGE_LABEL[reference]}: {base.raw_value}"] if base else []
        parts += [f"{STAGE_LABEL[self.stage(a)]}: {a.raw_value}" for a in actual]
        # Значения стадий и вывод — разные предложения: через тире или двоеточие выходило
        # «РД: B30: понижение», а тире из текстов интерфейса убраны
        rationale = f"{'; '.join(parts)}. {_sentence(outcome.rationale)}"
        if triggered and self.trigger.text:
            rationale += f". Триггер матрицы: {self.trigger.describe()}"
        # Раньше наружу шла одна пара «значение / дельта», даже когда сравнивались и РД, и ИД.
        # Теперь по каждой стадии своя; разные значения внутри стадии сюда не доходят (выше —
        # «нужен выбор источника»), поэтому на стадию берётся первое сравнение.
        by_stage: dict[str, tuple[Extraction, Outcome]] = {}
        for a, o in outcomes:
            by_stage.setdefault(self.stage(a), (a, o))
        stage_comparisons = [
            {
                "stage": stage,
                "value": _display(a),
                "raw_value": a.raw_value,
                "delta": o.delta,
                "triggered": o.triggered,
                "verdict": _sentence(o.rationale),
            }
            for stage, (a, o) in sorted(by_stage.items(), key=lambda item: stage_order(item[0]))
        ]
        return self.check(
            rule_key,
            "CANDIDATE" if triggered else "NEGATIVE_VERIFIED",
            "COMPLETE",
            rationale,
            **{
                **common,
                "actual_value": _display(chosen),
                "delta": outcome.delta,
                "stage_comparisons": stage_comparisons,
            },
        )


def _naming(request: CompareRequest):
    """Как назвать источник значения в гипотезе: шифр документа (или имя файла) и страница."""
    named = {str(f.file_id): (f.metadata.document_code or f.original_name) for f in request.files}

    def reference_of(x: Extraction) -> str:
        name = named.get(str(x.file_id)) or str(x.file_id)
        return f"{name}, стр. {x.fragment.page}" if x.fragment.page else name

    return reference_of


def _actual_pairs(page_pairs: Sequence[PagePairResult], selection: Selection) -> list[PagePairResult]:
    """Пары листов только по актуальным редакциям.

    Пары строит вызывающий — по всем загруженным документам, потому что отбор редакций
    живёт здесь и случается позже. Без этого фильтра в протокол попал бы лист заменённой
    редакции, и инспектор сверял бы неактуальный чертёж, не зная об этом. Фильтруем внутри
    движка, а не просим вызывающего повторить отбор: правило, которое держится на дисциплине
    вызывающего, рано или поздно нарушат.
    """
    actual = [
        pair
        for pair in page_pairs
        if str(pair.left.file_id) in selection.stage_of and str(pair.right.file_id) in selection.stage_of
    ]
    dropped = len(page_pairs) - len(actual)
    if dropped:
        log.info("page_pairs_superseded_dropped", dropped=dropped, kept=len(actual))
    return actual


def _with_page_pair(check: CheckResult, page_pairs: Sequence[PagePairResult]) -> CheckResult:
    """Ссылка на пару совмещённых листов, если доказательство попало на сопоставленные страницы."""
    key = pagepairs.key_for(check.fragments, page_pairs)
    return check.model_copy(update={"page_pair_key": key}) if key else check


def run(
    request: CompareRequest,
    docs: Sequence[Document],
    extract: Extractor,
    page_pairs: Sequence[PagePairResult] = (),
) -> CompareResult:
    """Сравнение комплекта. ``extract`` вызывается только для документов актуальных редакций нужных стадий."""
    started = time.monotonic()
    selection = select_files(request)
    sections = applicability.sections_of(request)
    active_docs = [d for d in docs if str(d.file_id) in selection.stage_of]
    page_pairs = _actual_pairs(page_pairs, selection)
    params = [p for p in request.matrix.params if p.is_active is not False]
    rules, broken = logical.compile_rules(request.logical_rules)
    for name, why in broken:
        log.warning("logical_rule_skipped", rule=name, reason=why)
    todo = incremental.plan(request, params, always=logical.referenced_params(rules))

    checks: list[CheckResult] = []
    short: set[str] = set()
    values: dict[str, list[Extraction]] = {}
    for param in todo.params:
        param_run = _ParamRun(request, param, selection, sections)
        param_checks, param_short = param_run.run(active_docs, extract)
        checks.extend(param_checks)
        short |= param_short
        values[param.code] = param_run.found

    if page_pairs:
        checks = [_with_page_pair(c, page_pairs) for c in checks]

    # ожидаемый состав сверяем со всеми файлами стадии: заменённая редакция из реестра тоже загружена
    staged = [
        StagedFile(str(plain(f.metadata.doc_stage)), f.original_name, f.metadata.document_code, f.metadata.discipline)
        for f in request.files
        if plain(f.metadata.doc_stage) in STAGES
    ]
    expected = request.expected_documents or []
    gaps = missing_expected(expected, staged)
    short |= {str(plain(e.doc_stage)) for e in gaps}
    present = selection.stages_present

    payload: dict[str, object] = {
        "process_id": request.process_id,
        "protocol_version": request.protocol_version,
        "status": "OK",
        "mode": request.mode,
        "scenario": scenario(present, known_gap=bool(gaps)),
        "affected_param_codes": todo.affected_codes,
        "checks": checks,
        "suspicions": logical.run(
            rules,
            values,
            lambda x: selection.stage_of.get(str(x.file_id), x.stage),
            _naming(request),
            request.object_id,
            page_pairs,
        ),
        "page_pairs": list(page_pairs),
        "file_resolution": selection.resolution,
        "versions": {
            "matrix_version": request.matrix.version,
            "model_version": request.versions.model_version or ENGINE_VERSION,
            "dataset_version": request.versions.dataset_version,
            "input_manifest_hash": manifest_hash(f.sha256 for f in request.files),
        },
        "stats": {
            "duration_ms": round((time.monotonic() - started) * 1000),
            "params_evaluated": len(todo.params),
        },
    }
    # при частичном пересчёте движок не знает, хватает ли источников непересчитанным параметрам,
    # и своей оценки полноты не даёт: api возьмёт свою, по реестру (docs/domain/statuses.md §2)
    if not todo.partial:
        payload["upload_status"] = upload_status(present, short, {str(plain(e.doc_stage)) for e in expected})
    return CompareResult.model_validate(payload)
