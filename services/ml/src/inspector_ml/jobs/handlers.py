"""Тело задач: разбор файла и сравнение комплекта.

Функции выполняются **в отдельном процессе** (пул в `jobs/runner.py`), поэтому принимают и
возвращают обычные словари: настройки передаются снимком, модели контрактов валидируются на месте.
Исключения наружу не пробрасываются — вместо них в результате появляется `error{code, message, retryable}`,
и api сам решает, повторять ли задачу.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from functools import partial
from pathlib import Path
from typing import Any

from inspector_ml.compare.values import plain
from inspector_ml.config import Settings
from inspector_ml.contracts.events import (
    CompareRequest,
    CompareResult,
    PagePairResult,
    ParseRequest,
    ParseResult,
)
from inspector_ml.cv.pairing import Sheet, page_pairs, sheets_of
from inspector_ml.extract.api import KEYED, Extraction, LoadedDocument, extract_param
from inspector_ml.extract.sbert import Fallback
from inspector_ml.ingest.docx import parse_docx
from inspector_ml.ingest.pdf import CorruptedDocumentError, file_quality, parse_pdf
from inspector_ml.ingest.xmldoc import parse_xml
from inspector_ml.logging import get_logger
from inspector_ml.metadata.facts import describe
from inspector_ml.ocr.base import OcrOptions
from inspector_ml.ocr.engines import build_engine
from inspector_ml.storage.cache import ParsedCache
from inspector_ml.storage.files import UnsupportedBucketError, resolve_ref, sha256_of

log = get_logger(__name__)

#: OTHER (архивы, DWG, изображения) лежит в комплекте карточкой файла и не разбирается (контракт `FileFormat`)
SUPPORTED_FORMATS = {"PDF", "DOCX", "XML"}


def settings_from(data: dict[str, Any]) -> Settings:
    """Восстановить настройки из снимка (в дочернем процессе `.env` не перечитываем)."""
    return Settings(_env_file=None, **data)


def _error(code: str, message: str, *, retryable: bool) -> dict[str, Any]:
    return {"code": code, "message": message, "retryable": retryable}


def ocr_options(settings: Settings, *, force: bool = False) -> OcrOptions:
    """Настройки распознавания для одной задачи. Движок создаётся в рабочем процессе."""
    return OcrOptions(
        engine=build_engine(
            settings.ocr_engine,
            paddle_det_model=settings.ocr_paddle_det_model,
            device=settings.ocr_device,
        ),
        dpi=settings.ocr_dpi,
        max_px=settings.ocr_max_px,
        tile_px=settings.ocr_tile_px,
        overlap_px=settings.ocr_overlap_px,
        min_confidence=settings.ocr_min_confidence,
        max_pages=settings.ocr_max_pages,
        force=force,
    )


def handle_parse(settings_data: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """`ml.parse.request` → `ParseResult`."""
    started = time.monotonic()
    settings = settings_from(settings_data)
    request = ParseRequest.model_validate(payload)
    file = request.file
    cache = ParsedCache(settings.storage_dir, settings.cache_dir)
    version = settings.parser_version

    def result(**fields: Any) -> dict[str, Any]:
        base = {
            "process_id": str(request.process_id),
            "file_id": str(file.file_id),
            "sha256": file.sha256,
            "parser_version": version,
            "duration_ms": round((time.monotonic() - started) * 1000),
        }
        return ParseResult.model_validate({**base, **fields}).model_dump(mode="json")

    if file.format.root not in SUPPORTED_FORMATS:
        return result(
            status="FAILED",
            error=_error("UNSUPPORTED_FORMAT", f"Формат {file.format.root} не разбирается", retryable=False),
        )

    options = request.options
    if not (options and options.force_reparse):
        cached = cache.get(file.sha256, version)
        if cached is not None:
            # Метаданные пересчитываются, а не берутся из кеша: классификатор стадии и марки мог
            # поменяться после предрасчёта, а имя файла у этой загрузки своё (≈0.15 с на том в 150 МБ)
            return result(
                status="OK",
                parsed_ref={"bucket": "local", "key": cache.storage_key(file.sha256, version)},
                metadata=describe(
                    cached.get("pages") or [], file_name=file.original_name, path=_source(settings, file)
                ),
                quality=file_quality(cached),
                from_cache=True,
            )

    try:
        path = resolve_ref(settings.storage_dir, file.source.bucket, file.source.key)
    except UnsupportedBucketError as exc:
        return result(status="FAILED", error=_error("UNREADABLE", str(exc), retryable=False))

    if not path.exists():
        return result(
            status="FAILED",
            error=_error("FILE_NOT_FOUND", f"Нет файла {file.source.key} в STORAGE_DIR", retryable=True),
        )

    # хеш считаем только при промахе кеша: разбор всё равно дороже, а на попадании это лишние секунды
    actual_sha = sha256_of(path)
    if actual_sha != file.sha256:
        return result(
            status="FAILED",
            error=_error(
                "SHA256_MISMATCH",
                f"Хеш файла не совпал с заявленным: ожидали {file.sha256[:12]}…, получили {actual_sha[:12]}…",
                retryable=False,
            ),
        )

    try:
        if file.format.root == "PDF":
            parsed = parse_pdf(
                path,
                file.sha256,
                version,
                read_layers=settings.parse_read_layers,
                file_name=file.original_name,
                ocr=ocr_options(settings, force=bool(options and options.force_ocr)),
            )
        else:
            # DOCX и XML: текст без геометрии, раскладывается по условным страницам (`ingest/flow.py`)
            parse = parse_docx if file.format.root == "DOCX" else parse_xml
            parsed = parse(path, file.sha256, version, file_name=file.original_name)
    except CorruptedDocumentError as exc:
        return result(status="FAILED", error=_error("CORRUPTED_FILE", str(exc), retryable=False))

    key = cache.put(file.sha256, version, parsed)
    return result(
        status="OK",
        parsed_ref={"bucket": "local", "key": key},
        metadata=parsed.get("metadata") or {},
        quality=file_quality(parsed),
        from_cache=False,
    )


def handle_compare(settings_data: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """`ml.compare.request` → `CompareResult`."""
    settings = settings_from(settings_data)
    request = CompareRequest.model_validate(payload)
    cache = ParsedCache(settings.storage_dir, settings.cache_dir)

    try:
        from inspector_ml.compare.engine import run as run_compare
    except ImportError as exc:  # pragma: no cover — движок уже в репозитории, страховка на случай отката
        return CompareResult.model_validate(
            {
                "process_id": str(request.process_id),
                "protocol_version": request.protocol_version,
                "status": "FAILED",
                "error": _error("ENGINE_NOT_READY", f"Движок сравнения недоступен: {exc}", retryable=False),
            }
        ).model_dump(mode="json")

    docs: list[LoadedDocument] = []
    missing: list[str] = []
    for file in request.files:
        parsed = cache.load_by_key(file.parsed_ref.key)
        if parsed is None:
            missing.append(str(file.file_id))
            continue
        docs.append(LoadedDocument(file_id=file.file_id, sha256=file.sha256, metadata=file.metadata, parsed=parsed))

    if missing:
        # не ошибка: движок отметит такие параметры как MISSING_EVIDENCE, но знать об этом полезно
        log.warning("compare_missing_parsed", process_id=str(request.process_id), file_ids=missing)

    pairs = _page_pairs(docs)
    result = run_compare(request, docs, _extractor(request, settings), page_pairs=pairs)
    result = _with_scorer(result, settings, request)
    return _with_hypotheses(result, docs, settings, request, pairs).model_dump(mode="json")


def _extractor(request: CompareRequest, settings: Settings) -> Callable[..., list[Extraction]]:
    """Извлечение для движка: правила, а где они в документе молчат — Sentence-BERT, если он включён.

    Запасной путь создаётся на задачу: числовые параметры берутся из матрицы запроса, память по документам
    живёт до конца сравнения. Выключен, нет пакета или весов — движок получает одни правила.
    """
    fallback = Fallback.create(request.matrix.params, settings, keyed=KEYED)
    if fallback is None:
        return extract_param
    log.info("sbert_fallback", params=len(fallback.params), model=settings.embedding_model)
    return partial(extract_param, fallback=fallback)


def _with_scorer(result: CompareResult, settings: Settings, request: CompareRequest) -> CompareResult:
    """Скорер кандидатов после правил: понижает кандидатов, которых инспектор почти наверняка отклонит.

    Какую модель применять, говорит api (`versions.model_version`); `SCORER_MODEL` — запасной вариант
    для локального прогона. Файла модели нет — это не ошибка: работают только правила, как без модели.
    Сломанная модель тоже не роняет проверку — пишем предупреждение и отдаём результат правил.
    """
    version = request.versions.model_version or settings.scorer_model
    if not version or plain(result.status) != "OK":
        return result
    from inspector_ml.matrix import load_params
    from inspector_ml.scorer.apply import apply, model_path
    from inspector_ml.scorer.model import LogisticModel

    path = model_path(settings.storage_dir, version)
    if not path.is_file():
        log.info("scorer_model_missing", model_version=version, path=str(path))
        return result
    # Раздел параметра — признак модели. Матрица приходит в самом запросе; `load_params()` читает
    # `data/matrix`, которой в образе ML нет, и на стенде все кандидаты попадали в раздел «?».
    # Файл матрицы — только запасной путь для локального прогона без матрицы в запросе.
    matrix = getattr(request, "matrix", None)
    params = {p.code: p for p in matrix.params} if matrix is not None and matrix.params else load_params()
    try:
        return apply(result, LogisticModel.load(path), params)
    # ловим всё: ни одна проверка не имеет права упасть из-за модели
    except Exception as exc:
        log.warning("scorer_failed", model_version=version, reason=str(exc))
        return result


def _with_hypotheses(
    result: CompareResult,
    docs: list[LoadedDocument],
    settings: Settings,
    request: CompareRequest,
    pairs: list[PagePairResult],
) -> CompareResult:
    """Гипотезы добавляются **рядом** с тем, что посчитали правила.

    Подключено здесь, а не в движке сравнения: движок считает проверки матрицы, а свободный поиск — отдельный шаг.
    Три способа, все только добавляют и ни один не может уронить сравнение:

    - **изменённые числа в совпадающем тексте ПД и РД** (`suspicion/number_diff`) — без модели
      и без матрицы, работают всегда: так находится «R0 270 → 300 кПа», которого в матрице нет;
    - **языковая модель** (`suspicion/semantic`) — только если поднята; при
      `LLM_ENABLED=false` (умолчание и наш публичный стенд) её гипотез просто нет (ADR-0008);
    - **листы-чертежи** (`suspicion/visual`) — совмещение растров ПД ↔ РД ↔ ИД и области
      различий; пара листов с гомографией добавляется в `page_pairs` для экрана наложения.
    """
    # `status` из контракта — RootModel, со строкой напрямую он не сравнивается
    if plain(result.status) != "OK":
        return result

    found: list[Any] = []
    if settings.number_diff_enabled:
        from inspector_ml.suspicion import number_diff

        known = [
            (str(check.expected_value), str(check.actual_value))
            for check in result.checks or []
            if check.expected_value is not None and check.actual_value is not None
        ]
        try:
            found.extend(number_diff.run(docs, request.object_id, pairs, known))
        # ловим всё: гипотезы — дополнение к правилам, и проверка не имеет права из-за них упасть
        except Exception as exc:
            log.warning("number_diff_failed", process_id=str(request.process_id), reason=str(exc))

    if settings.llm_enabled:
        from inspector_ml.suspicion import semantic

        try:
            found.extend(semantic.run(docs, settings, request.object_id, pairs))
        except Exception as exc:
            log.warning("semantic_failed", process_id=str(request.process_id), reason=str(exc))

    drawn: list[PagePairResult] = []
    if settings.visual_diff_enabled:
        from inspector_ml.suspicion import visual

        try:
            engine = ocr_options(settings).engine
            visual_found, drawn = visual.run(docs, settings.storage_dir, request.object_id, engine)
            found.extend(visual_found)
        except Exception as exc:
            log.warning("visual_diff_failed", process_id=str(request.process_id), reason=str(exc))

    if not found:
        return result
    update: dict[str, Any] = {"suspicions": [*(result.suspicions or []), *found]}
    if drawn:
        # пара листов-чертежей с совмещением заменяет ту же пару без него (ключ у них общий)
        keys = {pair.pair_key for pair in drawn}
        update["page_pairs"] = [*(p for p in result.page_pairs or [] if p.pair_key not in keys), *drawn]
    return result.model_copy(update=update)


def _page_pairs(docs: list[LoadedDocument]) -> list[PagePairResult]:
    """Пары листов ПД ↔ РД и ПД ↔ ИД.

    Эталон — ПД, поэтому пары строятся от неё: интерфейс показывает слева проектное решение,
    справа фактическое. Если стадии ПД в комплекте нет, пары не нужны — сравнивать не с чем.
    """
    by_stage: dict[str, list[Sheet]] = {}
    for doc in docs:
        stage = plain(doc.metadata.doc_stage)
        if stage:
            by_stage.setdefault(str(stage), []).extend(sheets_of(doc.file_id, doc.parsed))

    reference = by_stage.get("PD")
    if not reference:
        return []

    pairs = [pair for stage in ("RD", "ID") for pair in page_pairs(reference, by_stage.get(stage, []))]
    pairs.sort(key=lambda p: -p["match_score"])
    return [PagePairResult.model_validate(pair) for pair in pairs]


HANDLERS = {
    "ml.parse.request": handle_parse,
    "ml.compare.request": handle_compare,
}

RESULT_TYPE = {
    "ml.parse.request": "ml.parse.result",
    "ml.compare.request": "ml.compare.result",
}


def _source(settings: Settings, file: Any) -> Path | None:
    """Путь к исходному файлу, если он есть на диске: для свойств PDF при попадании в кеш."""
    try:
        path = resolve_ref(settings.storage_dir, file.source.bucket, file.source.key)
    except UnsupportedBucketError:
        return None
    return path if path.is_file() else None
