"""Предрасчёт разбора: наполнение кеша пачкой ([ADR-0007](../../../docs/adr/0007-stand-cpu-precomputed-cache.md)).

Стенд работает без GPU, поэтому тяжёлый разбор с OCR считается заранее на видеокарте, а на стенд
переносится архивом кеша. Прогон идёт часами, значит он должен переживать обрыв: ключ кеша —
`sha256 + PARSER_VERSION`, уже разобранные файлы пропускаются, и повторный запуск продолжает
с того места, где остановились.

Ошибка на одном файле не останавливает прогон: в выгрузке организаторов есть обрезанные PDF
(например `…ООС….pdf`), и из-за них терять три часа работы нельзя.

**Закрытые материалы.** Папка `ОРГАНИЗАТОР_ЗАКРЫТЫЙ/` пропускается: закрытые материалы
организатора мы не используем. Сейчас PDF в ней нет, но проверка стоит здесь, чтобы выгрузка
датасета не могла случайно затащить их в кеш стенда.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from collections import Counter
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pymupdf

from inspector_ml.cv.render import RenderCache, warm_document
from inspector_ml.ingest.pdf import CorruptedDocumentError, file_quality, parse_pdf
from inspector_ml.logging import get_logger
from inspector_ml.ocr.base import OcrOptions
from inspector_ml.storage.cache import ParsedCache
from inspector_ml.storage.files import long_path, reachable, sha256_of

#: Каталоги, которые не разбираем (закрытые материалы организатора).
EXCLUDED_DIRS = ("ОРГАНИЗАТОР_ЗАКРЫТЫЙ",)

log = get_logger(__name__)


@dataclass
class WarmReport:
    """Итог предрасчёта — он же отчёт для стенда."""

    files_total: int = 0
    parsed: int = 0
    cached: int = 0
    failed: int = 0
    pages: int = 0
    pages_ocr: int = 0
    duration_s: float = 0.0
    errors: list[dict[str, str]] = field(default_factory=list)
    #: Каталоги и файлы, которые обход не смог прочитать: они НЕ вошли в предрасчёт
    skipped: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        done = self.parsed + self.cached
        return {
            "files_total": self.files_total,
            "parsed": self.parsed,
            "cached": self.cached,
            "failed": self.failed,
            "pages": self.pages,
            "pages_ocr": self.pages_ocr,
            "duration_s": round(self.duration_s, 1),
            "seconds_per_page": round(self.duration_s / self.pages, 3) if self.pages else None,
            "progress": f"{done}/{self.files_total}",
            # список ошибок обрезаем: при разборе всей выгрузки их могут быть десятки
            "errors": self.errors[:20],
            "skipped": len(self.skipped),
            "skipped_paths": self.skipped[:20],
        }


def pdf_files(root: Path, skipped: list[str] | None = None) -> Iterator[Path]:
    """Все PDF под каталогом, кроме закрытых материалов организатора.

    Обход намеренно терпимый к ошибкам файловой системы: многочасовой прогон не должен падать
    из-за одного пути. Мешают два разных случая, и оба настоящие.

    **Недоступный файл.** В выгрузке есть каталоги с именами длиннее 255 байт — это предел
    Linux на элемент пути, и `stat` кидает `ENAMETOOLONG` (подробности — `storage.files.reachable`).
    Такой файл пропускается с предупреждением.

    **Нечитаемый каталог.** Если выгрузка лежит на сетевой шаре, примонтированной в WSL, то
    длинное имя ломает не `stat`, а само перечисление: `scandir` родительской папки обрывается
    с `EIO`, потому что 9p не может вернуть это имя в Linux. Раньше здесь был `rglob`, и такая
    папка роняла обход целиком — вместе с 46 нормальными PDF, лежащими в ней по соседству.
    Теперь непрочитанный каталог пропускается с предупреждением, а обход идёт дальше.

    Порядок остаётся детерминированным: пути собираются и сортируются целиком, чтобы `--limit`
    брал одну и ту же выборку от запуска к запуску.

    `skipped` — куда сложить пропущенные каталоги и файлы для итогового отчёта: предупреждение
    в журнале тонет среди тысяч строк многочасового прогона, и 42 файла чуть не выпали из
    предрасчёта молча — их заметили только сравнением счётчиков.
    """

    def unreadable(error: OSError) -> None:
        path = str(getattr(error, "filename", "") or "")
        log.warning("precompute_dir_unreadable", path=path, error=str(error))
        if skipped is not None:
            skipped.append(f"{path}: {error.strerror or error}")

    found: list[Path] = []
    for folder, dirs, names in os.walk(root, onerror=unreadable):
        if any(part in EXCLUDED_DIRS for part in Path(folder).parts):
            dirs.clear()  # внутрь закрытых материалов не спускаемся вовсе
            log.debug("precompute_skip_closed", path=folder)
            continue
        for name in names:
            if not name.lower().endswith(".pdf"):
                continue
            path = Path(folder) / name
            if reachable(path):
                found.append(path)
            else:
                log.warning("precompute_path_unreachable", path=str(path))
                if skipped is not None:
                    skipped.append(f"{path}: недоступен")
    yield from sorted(found)


def warm_cache(
    root: Path,
    cache: ParsedCache,
    parser_version: str,
    *,
    ocr: OcrOptions | None = None,
    read_layers: bool = False,
    limit: int | None = None,
    on_progress: Callable[[int, int, Path], None] | None = None,
) -> WarmReport:
    """Разобрать все PDF каталога и сложить в кеш. Уже разобранные пропускаются."""
    skipped: list[str] = []
    files = list(pdf_files(root, skipped))
    if limit:
        files = files[:limit]

    report = WarmReport(files_total=len(files), skipped=skipped)
    started = time.monotonic()
    for index, path in enumerate(files, start=1):
        if on_progress is not None:
            on_progress(index, len(files), path)
        try:
            sha = sha256_of(path)
        except OSError as exc:
            report.failed += 1
            report.errors.append({"file": path.name, "error": f"не читается: {exc}"})
            continue

        cached = cache.get(sha, parser_version)
        if cached is not None:
            report.cached += 1
            report.pages += len(cached.get("pages") or [])
            continue

        try:
            parsed = parse_pdf(
                long_path(path), sha, parser_version, read_layers=read_layers, file_name=path.name, ocr=ocr
            )
        except CorruptedDocumentError as exc:
            report.failed += 1
            report.errors.append({"file": path.name, "error": str(exc)})
            log.warning("precompute_corrupted", file=path.name, error=str(exc))
            continue
        except Exception as exc:  # прогон на часы: падение одного файла не должно его обрывать
            report.failed += 1
            report.errors.append({"file": path.name, "error": f"{type(exc).__name__}: {exc}"})
            log.exception("precompute_failed", file=path.name)
            continue

        cache.put(sha, parser_version, parsed)
        quality = file_quality(parsed)
        report.parsed += 1
        report.pages += quality["pages_total"]
        report.pages_ocr += quality["pages_ocr"]

    report.duration_s = time.monotonic() - started
    return report


@dataclass
class RenderReport:
    """Итог прогрева кеша растров."""

    files_total: int = 0
    documents: int = 0
    pages: int = 0
    cached: int = 0
    failed: int = 0
    size_bytes: int = 0
    duration_s: float = 0.0
    errors: list[dict[str, str]] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "files_total": self.files_total,
            "documents": self.documents,
            "pages_rendered": self.pages,
            "pages_cached": self.cached,
            "failed": self.failed,
            "size_bytes": self.size_bytes,
            "size_mb": round(self.size_bytes / 1024 / 1024, 1),
            "bytes_per_page": round(self.size_bytes / self.pages) if self.pages else None,
            "duration_s": round(self.duration_s, 1),
            "seconds_per_page": round(self.duration_s / self.pages, 3) if self.pages else None,
            "errors": self.errors[:20],
        }


def warm_renders(
    root: Path,
    cache: RenderCache,
    *,
    dpi: int,
    max_px: int,
    limit: int | None = None,
    max_pages: int | None = None,
    on_progress: Callable[[int, int, Path], None] | None = None,
) -> RenderReport:
    """Отрисовать страницы всех PDF каталога в кеш растров.

    Нужен не для стенда — растр туда не едет (см. `cv/render.py`), — а чтобы подготовить показ
    заранее и чтобы было чем мерить. `max_pages` ограничивает число страниц на документ: в ИД
    встречаются сканы на девятьсот листов, и отрисовывать их целиком ради демонстрации незачем.
    """
    files = list(pdf_files(root))
    if limit:
        files = files[:limit]

    report = RenderReport(files_total=len(files))
    started = time.monotonic()
    for index, path in enumerate(files, start=1):
        if on_progress is not None:
            on_progress(index, len(files), path)
        try:
            sha = sha256_of(path)
        except OSError as exc:
            report.failed += 1
            report.errors.append({"file": path.name, "error": f"не читается: {exc}"})
            continue

        pages = range(1, max_pages + 1) if max_pages else None
        try:
            rendered = list(warm_document(cache, sha, path, pages, dpi=dpi, max_px=max_px))
        except Exception as exc:  # прогон идёт по всей выгрузке: битый PDF его не обрывает
            report.failed += 1
            report.errors.append({"file": path.name, "error": f"{type(exc).__name__}: {exc}"})
            log.warning("render_failed", file=path.name, error=str(exc))
            continue

        report.documents += 1
        report.pages += len(rendered)
        report.size_bytes += sum(size for _page, size in rendered)

    report.duration_s = time.monotonic() - started
    report.cached = _rendered_pages(cache, dpi) - report.pages
    return report


def _rendered_pages(cache: RenderCache, dpi: int) -> int:
    """Сколько страниц этого разрешения уже лежит в кеше растров."""
    return cache.stats()["by_dpi"].get(str(dpi), 0)


@dataclass
class VerifyReport:
    """Сверка кеша с исходными PDF: цел ли перенос и совпадает ли разбор."""

    entries: int = 0
    matched: int = 0
    orphans: list[str] = field(default_factory=list)
    page_mismatch: list[dict[str, Any]] = field(default_factory=list)
    unreadable: list[str] = field(default_factory=list)
    reparsed: int = 0
    identical: int = 0
    differences: list[dict[str, Any]] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "entries": self.entries,
            "matched": self.matched,
            "orphans": len(self.orphans),
            "page_mismatch": self.page_mismatch[:10],
            "unreadable": self.unreadable[:10],
            "reparsed": self.reparsed,
            "identical": self.identical,
            "differences": self.differences[:10],
            "ok": not (self.page_mismatch or self.unreadable or self.differences),
        }


def fingerprint(parsed: dict[str, Any]) -> dict[str, Any]:
    """Слепок разбора для сравнения: структура страниц и хеш всего текста.

    Сравнивать JSON целиком нельзя — в нём есть поля, которые меняются от запуска к запуску
    (уверенность OCR печатается с округлением, порядок ключей). Слепок берёт то, от чего
    зависят результаты: сколько страниц, чем они разобраны, сколько блоков и таблиц и какой
    в них текст.
    """
    pages = parsed.get("pages") or []
    digest = hashlib.sha256()
    for page in pages:
        for block in page.get("blocks") or []:
            digest.update(block["text"].encode("utf-8"))
    return {
        "pages": len(pages),
        "sources": sorted(Counter(p.get("source") for p in pages).items()),
        "blocks": sum(len(p.get("blocks") or []) for p in pages),
        "tables": sum(len(p.get("tables") or []) for p in pages),
        "text_sha256": digest.hexdigest(),
    }


def verify_cache(
    root: Path,
    cache: ParsedCache,
    parser_version: str,
    *,
    ocr: OcrOptions | None = None,
    read_layers: bool = False,
    sample: int = 0,
    on_progress: Callable[[int, int, Path], None] | None = None,
) -> VerifyReport:
    """Сверить кеш с исходными PDF.

    Без `sample` проверка дешёвая: каждый файл корпуса хешируется, находится своя запись кеша,
    сверяются число страниц и `sha256` внутри разбора. С `sample` вдобавок несколько документов
    разбираются заново и сравниваются с кешем по слепку — это ловит не только битый перенос,
    но и расхождение самого разбора.
    """
    report = VerifyReport()
    files = list(pdf_files(root))
    sources: dict[str, Path] = {}
    for index, path in enumerate(files, start=1):
        if on_progress is not None:
            on_progress(index, len(files), path)
        try:
            sources[sha256_of(path)] = path
        except OSError as exc:
            report.unreadable.append(f"{path.name}: {exc}")

    items = list(_cached_items(cache, parser_version))
    report.entries = len(items)

    checked: list[tuple[str, Path, dict[str, Any]]] = []
    for sha, document in items:
        path = sources.get(sha)
        if path is None:
            report.orphans.append(sha[:16])
            continue
        report.matched += 1
        if document.get("sha256") != sha:
            report.page_mismatch.append({"file": path.name, "reason": "sha256 внутри разбора не совпал с ключом"})
            continue
        try:
            with pymupdf.open(long_path(path)) as pdf:
                expected = pdf.page_count
        except Exception as exc:
            report.unreadable.append(f"{path.name}: {exc}")
            continue
        actual = len(document.get("pages") or [])
        if actual != expected:
            report.page_mismatch.append({"file": path.name, "pages_in_cache": actual, "pages_in_pdf": expected})
            continue
        checked.append((sha, path, document))

    if sample:
        for sha, path, document in _sample(checked, sample):
            fresh = parse_pdf(
                long_path(path), sha, parser_version, read_layers=read_layers, file_name=path.name, ocr=ocr
            )
            report.reparsed += 1
            before, after = fingerprint(document), fingerprint(fresh)
            if before == after:
                report.identical += 1
            else:
                report.differences.append({"file": path.name, "cache": before, "reparsed": after})
    return report


def _cached_items(cache: ParsedCache, parser_version: str) -> Iterator[tuple[str, dict[str, Any]]]:
    root = long_path(cache.storage_dir / "parsed")
    for path in sorted(root.glob(f"*/{parser_version}.json")) if root.is_dir() else []:
        try:
            yield path.parent.name, json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("verify_entry_unreadable", path=str(path), error=str(exc))


def _sample(items: list[tuple[str, Path, dict[str, Any]]], size: int) -> list[tuple[str, Path, dict[str, Any]]]:
    """Равномерная выборка по списку, а не первые N: файлы идут по папкам, и первые — однотипные."""
    if size >= len(items):
        return items
    step = len(items) / size
    return [items[int(i * step)] for i in range(size)]
