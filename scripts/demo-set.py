#!/usr/bin/env python3
"""Комплект ПД + РД + ИД для показа: посмотреть, что увидит api, и собрать выборку.

    python3 scripts/demo-set.py <корень датасета>
        отчёт: сколько файлов каждой стадии api насчитает в каждом объекте

    python3 scripts/demo-set.py <корень> --object 14_Алтуфьевское_79Б
        план сборки комплекта — ничего не пишет

    python3 scripts/demo-set.py <корень> --object 14_Алтуфьевское_79Б --out demo --apply
        собрать комплект в demo/ вместе с реестром

Зачем отчёт. На живом прогоне 22.09 комплект дал ПД 66, РД 10 и **ИД 0** при наличии папки
с исполнительной документацией. Стадию api определяет по именам папок, поэтому здесь повторён
ровно тот же разбор (`services/api/src/modules/names.ts::stageFromFolder`) — отчёт показывает
то, что увидит сервер, а не то, что лежит на диске. Если в объекте ИД ноль, видно сразу и понятно
почему: папки с таким именем нет, имя искажено или в ней нет файлов.

Сборка делает копию, исходный датасет не трогается. По умолчанию — только план: писать на диск
скрипт начинает лишь с `--apply`.
"""

from __future__ import annotations

import argparse
import csv
import shutil
import sys
import unicodedata
from collections import Counter
from pathlib import Path

#: Полные слова — как в `stageFromFolder` у api.
WORD_STAGE = (("проектн", "ПД"), ("рабоч", "РД"), ("исполнит", "ИД"))
#: Сокращения ловим только как ВСЁ имя папки: подстрокой «ид» нашлось бы в «Сведения».
ABBREVIATION = {"пд": "ПД", "рд": "РД", "ид": "ИД"}
#: Латинские двойники кириллических букв: имена приходят из разных систем.
LOOKALIKE = str.maketrans({"p": "р", "c": "с", "a": "а", "e": "е", "o": "о", "x": "х"})
STAGES = ("ПД", "РД", "ИД")
FOLDER = {"ПД": "Проектная документация", "РД": "Рабочая документация", "ИД": "Исполнительная документация"}


def letters_only(name: str) -> str:
    return "".join(ch for ch in name if unicodedata.category(ch).startswith("L")).translate(LOOKALIKE)


def stage_from_folder(folder: str) -> str | None:
    """Стадия по имени папки — тот же разбор, что у api."""
    low = folder.lower()
    for needle, stage in WORD_STAGE:
        if needle in low:
            return stage
    return ABBREVIATION.get(letters_only(low))


def stage_of(rel: Path) -> str | None:
    """Первая папка пути, по которой понятна стадия. Имя самого файла не считаем."""
    for part in rel.parts[:-1]:
        stage = stage_from_folder(part)
        if stage:
            return stage
    return None


def scan(root: Path) -> dict[str, dict[str | None, list[Path]]]:
    """Объект → стадия → файлы. Ключ `None` — файлы, у которых стадия не определилась."""
    found: dict[str, dict[str | None, list[Path]]] = {}
    for obj in sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith(".")):
        by_stage: dict[str | None, list[Path]] = {}
        for path in sorted(obj.rglob("*")):
            if not path.is_file() or path.name.startswith("."):
                continue
            by_stage.setdefault(stage_of(path.relative_to(obj)), []).append(path)
        found[obj.name] = by_stage
    return found


def report(found: dict[str, dict[str | None, list[Path]]]) -> None:
    print(f"{'объект':<40}{'ПД':>7}{'РД':>7}{'ИД':>7}{'без стадии':>12}   годен")
    complete = []
    for name, by_stage in found.items():
        counts = {s: len(by_stage.get(s, [])) for s in STAGES}
        unknown = len(by_stage.get(None, []))
        ok = all(counts[s] > 0 for s in STAGES)
        if ok:
            complete.append(name)
        mark = "  ✓" if ok else ""
        print(f"{name[:39]:<40}{counts['ПД']:>7}{counts['РД']:>7}{counts['ИД']:>7}{unknown:>12}{mark}")
    print()
    if complete:
        print("Со всеми тремя стадиями:", ", ".join(complete))
        print("Показывать лучше такой — иначе сценарий будет PD_RD_ONLY и третья панель пустая.")
    else:
        print("Объектов со всеми тремя стадиями нет.")
        print("Если папка ИД на диске есть, а здесь ноль — имя папки не распознаётся:")
        print("проверьте, не искажено ли оно (CP866/Mac Cyrillic) и есть ли внутри файлы.")


def pick(files: list[Path], limit: int, max_bytes: int) -> list[Path]:
    """Равномерно по списку, а не первые N: файлы идут по разделам, и первые — один раздел."""
    fit = [f for f in files if f.stat().st_size <= max_bytes]
    if len(fit) <= limit:
        return fit
    step = len(fit) / limit
    return [fit[int(i * step)] for i in range(limit)]


def build(obj: str, by_stage: dict[str | None, list[Path]], out: Path, limit: int, max_bytes: int, apply: bool) -> None:
    target = out / obj
    rows = []
    total = 0
    for stage in STAGES:
        chosen = pick(by_stage.get(stage, []), limit, max_bytes)
        if not chosen:
            print(f"  {stage}: файлов нет — комплект будет неполным")
            continue
        size = sum(f.stat().st_size for f in chosen)
        total += size
        print(f"  {stage}: {len(chosen)} файлов, {size / 1048576:.1f} МБ → {target / FOLDER[stage]}")
        for src in chosen:
            rows.append({"Имя файла": src.name, "Стадия": stage})
            if apply:
                dst = target / FOLDER[stage] / src.name
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)

    names = Counter(r["Имя файла"] for r in rows)
    doubles = [n for n, c in names.items() if c > 1]
    if doubles:
        print(f"  ⚠ одинаковые имена в разных стадиях: {', '.join(doubles[:5])} — реестр сопоставит по имени неоднозначно")

    print(f"  итого: {len(rows)} файлов, {total / 1048576:.1f} МБ")
    if not apply:
        print("\nЭто план. Чтобы собрать — повторите с --apply")
        return

    registry = target / "registry.csv"
    with registry.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=["Имя файла", "Стадия"], delimiter=";")
        writer.writeheader()
        writer.writerows(rows)
    print(f"\nГотово: {target}")
    print(f"Реестр: {registry} ({len(rows)} строк)")
    print("Реестр обязателен — без него проверка честно уйдёт в CLARIFICATION_REQUIRED.")


def main() -> int:
    ap = argparse.ArgumentParser(description="Комплект ПД + РД + ИД для показа")
    ap.add_argument("root", type=Path, help="корень датасета: папка, внутри которой лежат объекты")
    ap.add_argument("--object", help="какой объект собрать; без него — только отчёт")
    ap.add_argument("--out", type=Path, default=Path("demo"), help="куда собрать (по умолчанию ./demo)")
    ap.add_argument("--per-stage", type=int, default=8, help="сколько файлов на стадию (по умолчанию 8)")
    ap.add_argument("--max-mb", type=int, default=60, help="пропускать файлы крупнее, МБ (по умолчанию 60)")
    ap.add_argument("--apply", action="store_true", help="писать на диск; без него — только план")
    args = ap.parse_args()

    if not args.root.is_dir():
        print(f"нет такой папки: {args.root}", file=sys.stderr)
        return 2

    found = scan(args.root)
    if not found:
        print(f"в {args.root} нет папок объектов", file=sys.stderr)
        return 2

    if not args.object:
        report(found)
        return 0

    if args.object not in found:
        print(f"объекта «{args.object}» нет. Доступны: {', '.join(list(found)[:10])}", file=sys.stderr)
        return 2

    print(f"Комплект «{args.object}»:")
    build(args.object, found[args.object], args.out, args.per_stage, args.max_mb * 1048576, args.apply)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
