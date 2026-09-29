"""Командная строка сервиса: ``inspector-ml serve | parse | compare | eval | dataset``.

``serve`` поднимает HTTP-сервис (его вызывает api), остальные команды нужны для проверки
конвейера без api — на файлах и папках с выборкой датасета.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from collections.abc import Sequence
from dataclasses import replace
from typing import TYPE_CHECKING

from inspector_ml import __version__
from inspector_ml.capabilities import detect_capabilities, service_status
from inspector_ml.config import Settings, get_settings
from inspector_ml.cv.render import RenderCache
from inspector_ml.logging import configure_logging, get_logger
from inspector_ml.storage.cache import ParsedCache

if TYPE_CHECKING:
    from inspector_ml.eval.tracking import EvalRun

log = get_logger(__name__)

# Команды конвейера появляются по мере готовности задач ML-*.
_NOT_READY = {
    "compare": "Сравнение комплекта из папки появится вместе с извлечением значений.",
}


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="inspector-ml", description="ML-конвейер «Инспектор ИИ»")
    parser.add_argument("--version", action="version", version=f"inspector-ml {__version__}")
    subparsers = parser.add_subparsers(dest="command", required=True)

    serve = subparsers.add_parser("serve", help="Поднять HTTP-сервис (/health, /metrics)")
    serve.add_argument("--host", default=None, help="По умолчанию ML_HOST")
    serve.add_argument("--port", type=int, default=None, help="По умолчанию ML_PORT")
    serve.add_argument("--reload", action="store_true", help="Перезапуск при изменении кода (разработка)")

    parse = subparsers.add_parser("parse", help="Разобрать файл и напечатать ParsedDocument")
    parse.add_argument("path", help="Путь к PDF")
    parse.add_argument("--json", action="store_true", help="Напечатать весь ParsedDocument, а не сводку")
    parse.add_argument("--out", default=None, help="Записать ParsedDocument в файл")
    parse.add_argument("--ocr", action="store_true", help="Распознавать страницы без текстового слоя")
    parse.add_argument("--force-ocr", action="store_true", help="Распознавать все страницы, даже с текстом")
    parse.add_argument("--pages", type=int, default=0, help="Ограничить число распознаваемых страниц")

    compare = subparsers.add_parser("compare", help="Сравнить комплект документов из папки")
    compare.add_argument("path", help="Папка с комплектом ПД/РД/ИД")

    evaluate = subparsers.add_parser("eval", help="Офлайн-оценка качества")
    evaluate.add_argument(
        "target",
        choices=["ocr", "extract", "coverage", "cv"],
        help="ocr — Character Accuracy, CER и WER по тексту документа; "
        "extract — сверка извлечения с эталоном организаторов; "
        "coverage — находимость всех параметров матрицы на кеше разбора; "
        "cv — классификатор страниц, стадия, локализация доказательства и OCR против разметки",
    )
    evaluate.add_argument(
        "path",
        nargs="?",
        default=None,
        help="PDF для оценки (ocr), корень dataset/ (extract) или STORAGE_DIR с parsed/ (coverage, "
        "по умолчанию из настроек)",
    )
    evaluate.add_argument("--pages", type=int, default=5, help="Сколько страниц взять (равномерно)")
    evaluate.add_argument("--dpi", type=int, default=None, help="Разрешение рендера, по умолчанию OCR_DPI")
    evaluate.add_argument("--split", default="TRAIN_PUBLIC", choices=["TRAIN_PUBLIC", "TEST_HIDDEN"])
    evaluate.add_argument(
        "--gold",
        default=None,
        help="Файл эталона, по умолчанию data/samples/public_gold_checks.jsonl в корне репозитория",
    )
    evaluate.add_argument(
        "--matrix",
        default=None,
        help="Матрица параметров, по умолчанию data/matrix/params.csv в корне репозитория",
    )
    evaluate.add_argument(
        "--parser-version", default=None, help="coverage: версия разбора в кеше, по умолчанию текущая"
    )
    evaluate.add_argument(
        "--corpus",
        default=None,
        help="coverage: корень корпуса PDF — даёт имена файлов и объекты в отчёте (по sha256)",
    )
    evaluate.add_argument("--workers", type=int, default=1, help="coverage: сколько процессов")
    evaluate.add_argument("--jsonl", default=None, help="coverage: куда записать строки по документам")
    evaluate.add_argument(
        "--storage", default=None, help="cv: STORAGE_DIR с кешем разбора parsed/, по умолчанию из настроек"
    )
    evaluate.add_argument(
        "--ocr-pages",
        type=int,
        default=0,
        help="cv: сколько страниц постоянного набора распознать (0 — без OCR; долго, лучше на GPU)",
    )
    evaluate.add_argument(
        "--mlflow",
        nargs="?",
        const="",
        default=None,
        metavar="URL",
        help="записать прогон в MLflow, эксперимент inspector-evals; без адреса — MLFLOW_URL "
        "(в compose http://mlflow:5000/mlflow). Только локальный адрес",
    )

    dataset = subparsers.add_parser("dataset", help="Работа с выгрузкой организаторов")
    dataset.add_argument(
        "action",
        choices=["scan", "calibrate", "metadata"],
        help="scan — сводка по папке с PDF; calibrate — сверка классификатора страниц с needs_ocr; "
        "metadata — сверка шифра, изменения и стадии с аннотациями META-*",
    )
    dataset.add_argument("path", nargs="?", default=None, help="Папка с PDF (scan) или корень dataset/")
    dataset.add_argument("--split", default="TRAIN_PUBLIC", choices=["TRAIN_PUBLIC", "TEST_HIDDEN"])
    dataset.add_argument("--limit", type=int, default=20, help="Сколько файлов обрабатывать")
    dataset.add_argument("--layers", action="store_true", help="Читать имена слоёв OCG (медленнее)")

    cache = subparsers.add_parser("cache", help="Кеш разбора: перенос на стенд и сводка")
    cache.add_argument(
        "action",
        choices=["export", "import", "stats", "warm", "verify", "renders"],
        help="export — собрать кеш в архив; import — загрузить архив (идемпотентно); "
        "stats — что уже разобрано; warm — предрасчёт разбора для папки с PDF; "
        "verify — сверить кеш с исходными PDF; renders — прогреть кеш растров для CV",
    )
    cache.add_argument(
        "path", nargs="?", default=None, help="Архив .tar.gz (export, import) или папка с PDF (warm, verify, renders)"
    )
    cache.add_argument(
        "--sample",
        type=int,
        default=0,
        help="verify: сколько документов разобрать заново и сравнить с кешем (0 — только структура)",
    )
    cache.add_argument("--ocr", action="store_true", help="warm: распознавать страницы без текстового слоя")
    cache.add_argument("--limit", type=int, default=None, help="warm: сколько файлов взять (для пробного прогона)")
    cache.add_argument(
        "--parser-version",
        default=None,
        help="Версия разбора; по умолчанию текущая из настроек, --all — все версии",
    )
    cache.add_argument("--all", action="store_true", help="Взять все версии разбора, а не только текущую")
    cache.add_argument("--dpi", type=int, default=None, help="renders: разрешение растра (по умолчанию RENDER_DPI)")
    cache.add_argument(
        "--max-pages", type=int, default=None, help="renders: сколько страниц брать из каждого документа"
    )
    cache.add_argument(
        "--clear",
        nargs="?",
        const="",
        default=None,
        metavar="SHA256",
        help="renders: удалить растры одного документа или, без значения, все",
    )

    trainer = subparsers.add_parser("train", help="Обучить скорер кандидатов на версии GOLD-набора")
    trainer.add_argument("--dataset", required=True, help="Выпущенная версия набора (dataset_version) в api")
    trainer.add_argument(
        "--export",
        default=None,
        help="JSONL выгрузки этой версии; без него выгрузка берётся из api (API_URL, ML_API_LOGIN, ML_API_PASSWORD)",
    )
    trainer.add_argument("--model-version", default=None, help="Имя модели, по умолчанию scorer-<набор>-<дата>")
    trainer.add_argument("--matrix", default=None, help="Матрица, по умолчанию data/matrix/params.csv")
    trainer.add_argument(
        "--min-per-class",
        type=_positive_int,
        default=None,
        help="Сколько подтверждённых и отклонённых нужно в TRAIN, по умолчанию 10. Значение попадает в "
        "training_params и в метаданные модели",
    )
    trainer.add_argument(
        "--threshold",
        type=_threshold,
        default=None,
        help="Порог понижения кандидата, 0–0.5. Без него — по сохранённой полноте на TRAIN, а при меньше чем 5 "
        "подтверждённых — не выше 0.2. Значение и его источник попадают в training_params",
    )
    trainer.add_argument(
        "--register", action="store_true", help="Зарегистрировать модель в api: она встанет в очередь на решение"
    )

    subparsers.add_parser("llm", help="Проверить связь с локальной моделью: жива ли она и отвечает ли JSON")

    subparsers.add_parser("info", help="Показать настройки и доступные компоненты")
    return parser


def _llm() -> int:
    """Одна команда, чтобы понять, поднимется ли свободный поиск на этой машине или на стенде.

    Отвечает на три вопроса по порядку: включена ли модель настройкой, отвечает ли адрес
    из `LLM_BASE_URL`, и умеет ли модель отдавать JSON — без последнего гипотез не будет,
    как бы хорошо она ни рассуждала.
    """
    from inspector_ml.llm.client import LlmClient

    settings = get_settings()
    if not settings.llm_enabled:
        print("LLM выключена (LLM_ENABLED=false). Так и задумано на нашем публичном стенде.")
        return 1

    client = LlmClient.from_settings(settings)
    assert client is not None
    print(f"адрес:   {client.base_url}")
    print(f"модель:  {client.model}")
    print(f"таймаут: {client.timeout:.0f} с")

    started = time.monotonic()
    answer = client.ask_json(
        "Отвечай только объектом JSON.",
        'Верни ровно это: {"ok": true}',
    )
    took = time.monotonic() - started
    if answer is None:
        print(f"ответа нет ({took:.1f} с) — причина в журнале выше", file=sys.stderr)
        return 1
    print(f"ответ за {took:.1f} с: {answer}")
    return 0


def _serve(args: argparse.Namespace) -> int:
    import uvicorn

    settings = get_settings()
    host = args.host or settings.ml_host
    port = args.port or settings.ml_port
    log.info("serve", host=host, port=port, parser_version=settings.parser_version)
    uvicorn.run(
        "inspector_ml.api.app:app",
        host=host,
        port=port,
        reload=args.reload,
        # Логи uvicorn идут через наш JSON-форматтер; запросы логирует middleware
        log_config=None,
        access_log=False,
    )
    return 0


def _parse(args: argparse.Namespace) -> int:
    from pathlib import Path

    from inspector_ml.ingest.pdf import CorruptedDocumentError, file_quality, parse_pdf
    from inspector_ml.jobs.handlers import ocr_options
    from inspector_ml.storage.files import sha256_of

    path = Path(args.path)
    if not path.exists():
        print(f"Нет файла: {path}", file=sys.stderr)
        return 1

    settings = get_settings()
    ocr = None
    if args.ocr or args.force_ocr:
        ocr = ocr_options(settings, force=args.force_ocr)
        if not ocr.enabled:
            print("OCR недоступен: установите extra ocr (uv sync --extra ocr)", file=sys.stderr)
            return 1
        if args.pages:
            ocr = replace(ocr, max_pages=args.pages)

    started = time.monotonic()
    try:
        parsed = parse_pdf(path, sha256_of(path), settings.parser_version, ocr=ocr)
    except CorruptedDocumentError as exc:
        print(f"CORRUPTED_FILE: {exc}", file=sys.stderr)
        return 1
    duration_ms = round((time.monotonic() - started) * 1000)

    if args.out:
        Path(args.out).write_text(json.dumps(parsed, ensure_ascii=False), encoding="utf-8")
        print(f"ParsedDocument записан: {args.out}")

    if args.json:
        print(json.dumps(parsed, ensure_ascii=False, indent=2))
        return 0

    quality = file_quality(parsed)
    rotations = Counter(page["rotation"] for page in parsed["pages"])
    blocks = sum(len(page["blocks"]) for page in parsed["pages"])
    print(
        json.dumps(
            {
                "sha256": parsed["sha256"][:16] + "…",
                "parser_version": parsed["parser_version"],
                "pages": quality["pages_total"],
                "pages_text_layer": quality["pages_text_layer"],
                "pages_low_quality": len(quality["low_quality_pages"]),
                "pages_ocr": quality["pages_ocr"],
                "ocr_mean_confidence": quality["ocr_mean_confidence"],
                "blocks": blocks,
                "rotations": dict(sorted(rotations.items())),
                "drawing_pages": sum(1 for page in parsed["pages"] if page["is_drawing"]),
                "duration_ms": duration_ms,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def _dataset(args: argparse.Namespace) -> int:
    from pathlib import Path

    from inspector_ml.corpus.calibrate import calibrate_metadata, calibrate_pages
    from inspector_ml.corpus.scan import scan_folder

    if not args.path:
        print("Укажите путь: папку с PDF для scan или корень dataset/ для calibrate и metadata", file=sys.stderr)
        return 1
    path = Path(args.path)
    if not path.is_dir():
        print(f"Нет папки: {path}", file=sys.stderr)
        return 1

    try:
        if args.action == "scan":
            report = scan_folder(path, args.limit, read_layers=args.layers)
        elif args.action == "calibrate":
            report = calibrate_pages(path, args.split, args.limit)
        else:
            report = calibrate_metadata(path, args.split, args.limit)
    except FileNotFoundError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def _eval(args: argparse.Namespace) -> int:
    from pathlib import Path

    from inspector_ml.eval.ocr_metrics import evaluate_pdf
    from inspector_ml.jobs.handlers import ocr_options

    if args.target == "extract":
        return _eval_extract(args)
    if args.target == "coverage":
        return _eval_coverage(args)
    if args.target == "cv":
        return _eval_cv(args)

    if not args.path:
        print("Укажите PDF: inspector-ml eval ocr <файл>", file=sys.stderr)
        return 1
    path = Path(args.path)
    if not path.is_file():
        print(f"Нет файла: {path}", file=sys.stderr)
        return 1

    settings = get_settings()
    options = ocr_options(settings, force=True)
    if args.dpi:
        options = replace(options, dpi=args.dpi)
    if not options.enabled:
        print("OCR недоступен: установите extra ocr (uv sync --extra ocr)", file=sys.stderr)
        return 1

    report = evaluate_pdf(path, options, limit=args.pages)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.mlflow is not None:
        from inspector_ml.eval.tracking import ocr_run

        _track(args.mlflow, ocr_run(report))
    return 0


def _eval_extract(args: argparse.Namespace) -> int:
    """Сверка извлечения M-002 и M-055 с публичным эталоном организаторов."""
    from pathlib import Path

    from inspector_ml.config import find_repo_root
    from inspector_ml.eval.extract_metrics import evaluate_gold

    if not args.path:
        print("Укажите корень датасета: inspector-ml eval extract <папка>", file=sys.stderr)
        return 1
    root = Path(args.path)
    if not root.is_dir():
        print(f"Нет папки датасета: {root}", file=sys.stderr)
        return 1
    gold = Path(args.gold) if args.gold else find_repo_root() / "data/samples/public_gold_checks.jsonl"
    if not gold.is_file():
        print(f"Нет файла эталона: {gold}", file=sys.stderr)
        return 1

    report = evaluate_gold(root, gold, split=args.split, matrix=Path(args.matrix) if args.matrix else None)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.mlflow is not None:
        from inspector_ml.eval.tracking import extract_run

        _track(args.mlflow, extract_run(report))
    return 0


def _eval_coverage(args: argparse.Namespace) -> int:
    """Находимость всех параметров матрицы на кеше разбора."""
    from pathlib import Path

    from inspector_ml.eval.coverage import corpus_sources, measure, parsed_files, summarize
    from inspector_ml.matrix import load_params, params_path

    settings = get_settings()
    storage = Path(args.path) if args.path else settings.storage_dir
    version = args.parser_version or settings.parser_version
    files = parsed_files(storage, version)
    if not files:
        print(f"В {storage / 'parsed'} нет разобранных документов версии {version}", file=sys.stderr)
        return 1

    matrix = Path(args.matrix) if args.matrix else params_path()
    params = load_params(matrix)
    if not params:
        print(f"Матрица пуста или не найдена: {matrix}", file=sys.stderr)
        return 1

    sources = None
    if args.corpus:
        corpus = Path(args.corpus)
        if not corpus.is_dir():
            print(f"Нет папки корпуса: {corpus}", file=sys.stderr)
            return 1
        sources = corpus_sources(corpus)

    started = time.monotonic()

    def progress(done: int, total: int) -> None:
        # в stdout идёт только JSON-отчёт, прогресс — в stderr
        if done % 25 == 0 or done == total:
            print(f"[{done}/{total}] {time.monotonic() - started:.0f} с", file=sys.stderr, flush=True)

    rows = measure(files, matrix=matrix, sources=sources, workers=max(1, args.workers), on_progress=progress)
    if args.jsonl:
        out = Path(args.jsonl)
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open("w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")

    report = summarize(rows, params)
    report = {
        "parser_version": version,
        "matrix": str(matrix),
        "duration_s": round(time.monotonic() - started, 1),
        **report,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.mlflow is not None:
        from inspector_ml.eval.tracking import coverage_run

        _track(args.mlflow, coverage_run(report, matrix=matrix, workers=max(1, args.workers)))
    return 0


def _eval_cv(args: argparse.Namespace) -> int:
    """Метрики компьютерного зрения против открытой разметки организаторов."""
    from pathlib import Path

    from inspector_ml.corpus.labels import Split
    from inspector_ml.eval.cv import cache_loader, evaluate_cv
    from inspector_ml.jobs.handlers import ocr_options
    from inspector_ml.matrix import load_params, params_path

    if not args.path:
        print("Укажите корень датасета: inspector-ml eval cv <папка>", file=sys.stderr)
        return 1
    split = Split(root=Path(args.path), name="TRAIN_PUBLIC")
    if not split.data_dir.is_dir():
        print(f"Нет размеченной обучающей части в {args.path}", file=sys.stderr)
        return 1
    if args.ocr_pages and not split.corpus_dir.is_dir():
        print(f"Для OCR нужны исходные PDF: нет папки {split.corpus_dir}", file=sys.stderr)
        return 1

    settings = get_settings()
    storage = Path(args.storage) if args.storage else settings.storage_dir
    options = None
    if args.ocr_pages:
        options = ocr_options(settings, force=True)
        if args.dpi:
            options = replace(options, dpi=args.dpi)
        if not options.enabled:
            print("OCR недоступен: установите extra ocr (uv sync --extra ocr)", file=sys.stderr)
            return 1

    started = time.monotonic()
    loader = cache_loader(storage, args.parser_version or settings.parser_version)
    params = load_params(Path(args.matrix) if args.matrix else params_path())
    report = evaluate_cv(split, loader, params, ocr_pages=args.ocr_pages, ocr=options)
    report = {"duration_s": round(time.monotonic() - started, 1), **report}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.mlflow is not None:
        from inspector_ml.eval.tracking import cv_run

        _track(args.mlflow, cv_run(report))
    return 0


def _track(url: str, run: EvalRun) -> None:
    """Прогон оценки в MLflow. Не вышло — отчёт уже напечатан, замер не считается неудачным."""
    from inspector_ml.eval.tracking import EXPERIMENT, Mlflow

    url = url or get_settings().mlflow_url
    if not url:
        print("MLflow: адрес не задан — укажите --mlflow URL или MLFLOW_URL", file=sys.stderr)
        return
    run_id = Mlflow(url).log(run)
    if run_id:
        print(f"MLflow: прогон {run_id} записан в эксперимент {EXPERIMENT} ({url})", file=sys.stderr)
    else:
        print("MLflow: прогон не записан, причина в журнале выше", file=sys.stderr)


def _cache(args: argparse.Namespace) -> int:
    """Перенос кеша разбора между машинами (ADR-0007)."""
    from pathlib import Path

    from inspector_ml.storage.archive import ArchiveError, export_cache, import_cache, stats

    settings = get_settings()
    cache = ParsedCache(settings.storage_dir, settings.cache_dir)
    version = None if args.all else (args.parser_version or settings.parser_version)

    if args.action == "stats":
        report = stats(cache, parser_version=version)
        report["renders"] = RenderCache(settings.storage_dir).stats()
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    if args.action == "warm":
        return _cache_warm(args, settings, cache)
    if args.action == "verify":
        return _cache_verify(args, settings, cache)
    if args.action == "renders":
        return _cache_renders(args, settings)

    if not args.path:
        print("Укажите путь к архиву: inspector-ml cache export cache.tar.gz", file=sys.stderr)
        return 1
    archive = Path(args.path)

    try:
        if args.action == "export":
            report = export_cache(cache, archive, parser_version=version)
        else:
            if not archive.is_file():
                print(f"Нет архива: {archive}", file=sys.stderr)
                return 1
            report = import_cache(cache, archive)
    except ArchiveError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def _cache_warm(args: argparse.Namespace, settings: Settings, cache: ParsedCache) -> int:
    """Предрасчёт разбора для папки с PDF — прогон на часы, поэтому с прогрессом и продолжением."""
    from pathlib import Path

    from inspector_ml.jobs.handlers import ocr_options
    from inspector_ml.precompute import warm_cache

    if not args.path:
        print("Укажите папку с PDF: inspector-ml cache warm <папка> --ocr", file=sys.stderr)
        return 1
    root = Path(args.path)
    if not root.is_dir():
        print(f"Нет папки: {root}", file=sys.stderr)
        return 1

    ocr = None
    if args.ocr:
        ocr = ocr_options(settings, force=False)
        if not ocr.enabled:
            print("OCR недоступен: установите extra ocr (uv sync --extra ocr)", file=sys.stderr)
            return 1

    def progress(index: int, total: int, path: Path) -> None:
        # в stdout идёт только JSON-отчёт, прогресс — в stderr
        print(f"[{index}/{total}] {path.name}", file=sys.stderr, flush=True)

    report = warm_cache(
        root,
        cache,
        settings.parser_version,
        ocr=ocr,
        read_layers=settings.parse_read_layers,
        limit=args.limit,
        on_progress=progress,
    )
    print(json.dumps(report.as_dict(), ensure_ascii=False, indent=2))
    if report.skipped:
        # в конце и отдельно от JSON: такой пропуск нельзя заметить в журнале многочасового прогона
        print(
            f"ВНИМАНИЕ: {len(report.skipped)} каталогов и файлов не прочитано — они НЕ вошли в предрасчёт "
            "(список — skipped_paths в отчёте). Частая причина — имя длиннее 255 байт на шаре в WSL.",
            file=sys.stderr,
        )
    return 0


def _cache_renders_clear(sha256: str, cache: RenderCache) -> int:
    """Очистка кеша растров: вернуть место на диске.

    На стенде растры копятся всю экспертизу, пока эксперты листают чертежи, а диск там делят
    исходные файлы, кеш разбора и копии базы. Удалять их безопасно: при следующем запросе лист
    отрисуется заново примерно за 0.15 с — в отличие от разбора, который пришлось бы считать
    с OCR заново.
    """
    if sha256 and (len(sha256) != 64 or not all(c in "0123456789abcdef" for c in sha256.lower())):
        print(f"«{sha256}» не похоже на sha256: нужны 64 шестнадцатеричные цифры", file=sys.stderr)
        return 1

    before = cache.stats()["size_bytes"]
    removed = cache.clear(sha256 or None)
    print(
        json.dumps(
            {
                "cleared": sha256 or "все документы",
                "pages_removed": removed,
                "freed_bytes": before - cache.stats()["size_bytes"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def _cache_renders(args: argparse.Namespace, settings: Settings) -> int:
    """Прогрев кеша растров: на стенд он не едет, но показ можно подготовить заранее."""
    from pathlib import Path

    from inspector_ml.precompute import warm_renders

    if args.clear is not None:
        return _cache_renders_clear(args.clear, RenderCache(settings.storage_dir))

    if not args.path:
        print("Укажите папку с PDF: inspector-ml cache renders <папка> --dpi 150", file=sys.stderr)
        return 1
    root = Path(args.path)
    if not root.is_dir():
        print(f"Нет папки: {root}", file=sys.stderr)
        return 1

    def progress(index: int, total: int, path: Path) -> None:
        print(f"[{index}/{total}] {path.name}", file=sys.stderr, flush=True)

    report = warm_renders(
        root,
        RenderCache(settings.storage_dir),
        dpi=args.dpi or settings.render_dpi,
        max_px=settings.render_max_px,
        limit=args.limit,
        max_pages=args.max_pages,
        on_progress=progress,
    )
    print(json.dumps(report.as_dict(), ensure_ascii=False, indent=2))
    return 0


def _cache_verify(args: argparse.Namespace, settings: Settings, cache: ParsedCache) -> int:
    """Сверка кеша с исходными PDF: цел ли перенос и совпадает ли разбор."""
    from pathlib import Path

    from inspector_ml.jobs.handlers import ocr_options
    from inspector_ml.precompute import verify_cache

    if not args.path:
        print("Укажите папку с исходными PDF: inspector-ml cache verify <папка> --sample 5", file=sys.stderr)
        return 1
    root = Path(args.path)
    if not root.is_dir():
        print(f"Нет папки: {root}", file=sys.stderr)
        return 1

    ocr = ocr_options(settings, force=False) if args.ocr or args.sample else None

    def progress(index: int, total: int, path: Path) -> None:
        print(f"[{index}/{total}] {path.name}", file=sys.stderr, flush=True)

    report = verify_cache(
        root,
        cache,
        settings.parser_version,
        ocr=ocr,
        read_layers=settings.parse_read_layers,
        sample=args.sample,
        on_progress=progress,
    )
    print(json.dumps(report.as_dict(), ensure_ascii=False, indent=2))
    return 0 if report.as_dict()["ok"] else 1


def _info() -> int:
    settings = get_settings()
    capabilities = detect_capabilities(settings)
    print(
        json.dumps(
            {
                "version": __version__,
                "status": service_status(capabilities),
                "repo_root": str(settings.repo_root),
                "storage_dir": str(settings.storage_dir),
                "cache_dir": str(settings.cache_dir),
                "parser_version": settings.parser_version,
                "api_url": settings.api_url,
                "capabilities": capabilities,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def _train(args: argparse.Namespace) -> int:
    """Скорер кандидатов: выгрузка → проверка хешей → обучение → файл модели → регистрация."""
    from datetime import datetime
    from pathlib import Path

    from inspector_ml.matrix import load_params, params_path
    from inspector_ml.scorer.api_client import ApiError, InspectorApi
    from inspector_ml.scorer.apply import model_path
    from inspector_ml.scorer.dataset import check_hashes, read_export
    from inspector_ml.scorer.train import MIN_PER_CLASS, NotEnoughData, registration, train

    settings = get_settings()
    api = InspectorApi(settings.api_url, settings.ml_api_login, settings.ml_api_password.get_secret_value())
    try:
        if args.export:
            text = Path(args.export).read_text(encoding="utf-8")
            published = None
        else:
            text = api.export(args.dataset)
            version = api.dataset_version(args.dataset)
            published = (version or {}).get("split_hashes")
    except (OSError, ApiError) as exc:
        print(f"Выгрузку набора взять не удалось: {exc}", file=sys.stderr)
        return 1

    export = read_export(text)
    if mismatched := check_hashes(export, published):
        print("Выгрузка не совпадает с версией в api: " + "; ".join(mismatched), file=sys.stderr)
        return 1

    params = load_params(Path(args.matrix) if args.matrix else params_path())
    model_version = args.model_version or f"scorer-{args.dataset}-{datetime.now():%Y%m%d%H%M}"
    try:
        trained = train(
            export,
            params,
            dataset_version=args.dataset,
            model_version=model_version,
            code_version=_code_version(),
            min_per_class=args.min_per_class or MIN_PER_CLASS,
            threshold=args.threshold,
        )
    except NotEnoughData as exc:
        print(f"Обучать не на чем: {exc}", file=sys.stderr)
        return 1

    path = model_path(settings.storage_dir, model_version)
    artifact_hash = trained.model.save(path)
    payload = registration(trained, artifact_hash, export.split_hashes)
    report: dict[str, object] = {"model_path": str(path), "artifact_hash": artifact_hash, **trained.report}
    if args.register:
        try:
            report["registered"] = api.register(payload)
        except ApiError as exc:
            print(f"Модель обучена, но не зарегистрирована: {exc}", file=sys.stderr)
            print(json.dumps(report, ensure_ascii=False, indent=2))
            return 1
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def _positive_int(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("нужно целое число не меньше 1")
    return number


def _threshold(value: str) -> float:
    """Порог понижения: выше 0,5 скорер понижал бы кандидатов, которые скорее подтвердятся, чем нет."""
    number = float(value)
    if not 0.0 <= number <= 0.5:
        raise argparse.ArgumentTypeError("нужно число от 0 до 0.5")
    return number


def _code_version() -> str | None:
    """Коммит кода обучения: `GIT_COMMIT` из окружения образа, иначе `git rev-parse` рядом с кодом."""
    import os
    import subprocess
    from pathlib import Path

    if commit := os.environ.get("GIT_COMMIT"):
        return commit
    try:
        done = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=Path(__file__).resolve().parent,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    commit = done.stdout.strip()
    return commit if done.returncode == 0 and commit else None


# Эти команды печатают JSON в stdout, поэтому их логи уходят в stderr
_JSON_OUTPUT = frozenset({"parse", "eval", "dataset", "info", "cache", "train"})


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    configure_logging(
        get_settings().log_level,
        stream=sys.stderr if args.command in _JSON_OUTPUT else None,
    )

    if args.command == "serve":
        return _serve(args)
    if args.command == "parse":
        return _parse(args)
    if args.command == "dataset":
        return _dataset(args)
    if args.command == "eval":
        return _eval(args)
    if args.command == "cache":
        return _cache(args)
    if args.command == "llm":
        return _llm()
    if args.command == "train":
        return _train(args)
    if args.command == "info":
        return _info()

    message = _NOT_READY.get(args.command)
    if message:
        print(message, file=sys.stderr)
        return 2
    return 2  # pragma: no cover — argparse не пропустит неизвестную команду


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
