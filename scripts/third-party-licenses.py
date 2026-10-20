#!/usr/bin/env python3
"""Перечень сторонних пакетов, которые попадают в образы продукта, с лицензиями.

Читает lock-файлы сервисов и пишет docs/legal/third-party-packages.md:
- Node.js (api, web, rin-mock): package-lock.json, только пакеты без пометки dev;
- Python (ml): uv.lock — зависимости проекта и extras из образа (ocr, embeddings) без группы dev,
  лицензия берётся из PyPI (license_expression, license или классификаторы).

Маркеры платформ не учитываются: в перечень попадают и пакеты только для Windows или macOS.
Это перечень «с запасом», для проверки лицензий так надёжнее.

Запуск из корня репозитория (нужен доступ к pypi.org):
    python scripts/third-party-licenses.py
"""

from __future__ import annotations

import json
import re
import sys
import tomllib
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "legal" / "third-party-packages.md"
NODE_SERVICES = ["api", "web", "rin-mock"]
# Те же extras, что в infra/docker/ml.Dockerfile и ml-gpu.Dockerfile (ARG EXTRAS)
ML_EXTRAS = ["ocr", "embeddings"]

# Лицензии с условием «копилефт»: при распространении закрытого продукта требуют внимания
COPYLEFT = re.compile(r"\b(A?GPL|LGPL|MPL|EPL|CDDL|SSPL|EUPL|OSL)", re.IGNORECASE)

# Пакеты, у которых в метаданных лицензии нет или она записана неразборчиво; сверено с их репозиториями
OVERRIDES = {
    "png-js": "MIT",
    "dejavu-fonts-ttf": "Bitstream Vera Fonts License (свободная)",
    "fsspec": "BSD-3-Clause",
    "python-dateutil": "Apache-2.0 OR BSD-3-Clause",
}


def norm(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def node_packages(service: str) -> list[tuple[str, str, str]]:
    lock = json.loads((ROOT / "services" / service / "package-lock.json").read_text(encoding="utf-8"))
    rows = []
    for path, meta in lock.get("packages", {}).items():
        if not path or meta.get("dev") or meta.get("link"):
            continue
        name = meta.get("name") or path.rsplit("node_modules/", 1)[-1]
        lic = OVERRIDES.get(name) or str(meta.get("license") or "не указана")
        rows.append((name, meta.get("version", ""), lic))
    return sorted(set(rows))


def ml_packages() -> list[tuple[str, str]]:
    lock = tomllib.loads((ROOT / "services" / "ml" / "uv.lock").read_text(encoding="utf-8"))
    by_name: dict[str, list[dict]] = {}
    for pkg in lock["package"]:
        by_name.setdefault(norm(pkg["name"]), []).append(pkg)
    root = by_name[norm("inspector-ml")][0]

    seen: set[tuple[str, str]] = set()
    queue: list[dict] = list(root.get("dependencies", []))
    for extra in ML_EXTRAS:
        queue += root.get("optional-dependencies", {}).get(extra, [])
    while queue:
        dep = queue.pop()
        name = norm(dep["name"])
        for pkg in by_name.get(name, []):
            if "version" in dep and dep["version"] != pkg.get("version"):
                continue
            key = (name, pkg.get("version", ""))
            if key not in seen:
                seen.add(key)
                queue += pkg.get("dependencies", [])
            for extra in dep.get("extra", []):
                queue += pkg.get("optional-dependencies", {}).get(extra, [])
    return sorted(seen)


def pypi_license(item: tuple[str, str]) -> str:
    name, version = item
    if name in OVERRIDES:
        return OVERRIDES[name]
    # Локальная метка сборки (torch 2.14.0+cpu с индекса PyTorch) в PyPI не публикуется
    version = version.split("+", 1)[0]
    try:
        with urllib.request.urlopen(f"https://pypi.org/pypi/{name}/{version}/json", timeout=30) as resp:
            info = json.load(resp)["info"]
    except Exception:
        return "не найдена в PyPI"
    if info.get("license_expression"):
        return info["license_expression"]
    classifiers = [c.split(" :: ")[-1] for c in info.get("classifiers", []) if c.startswith("License ::")]
    classifiers = [c for c in classifiers if c != "OSI Approved"]
    text = (info.get("license") or "").strip()
    # В поле license некоторые пакеты кладут полный текст лицензии — тогда берём классификатор
    if text and len(text) <= 60 and "\n" not in text:
        return text
    if classifiers:
        return "; ".join(classifiers)
    return text.splitlines()[0][:60] if text else "не указана"


def table(rows: list[tuple[str, str, str]]) -> list[str]:
    lines = ["| Пакет | Версия | Лицензия |", "|---|---|---|"]
    for name, version, lic in rows:
        mark = " ⚠️" if COPYLEFT.search(lic) else ""
        lines.append(f"| {name} | {version} | {lic.replace('|', '/')}{mark} |")
    return lines


def summary(rows: list[tuple[str, str, str]]) -> str:
    if not rows:
        return "Сторонних пакетов нет, только стандартная библиотека Node.js"
    counts = Counter(lic for _, _, lic in rows)
    return ", ".join(f"{lic} — {n}" for lic, n in counts.most_common())


def main() -> int:
    sections: list[str] = []
    for service in NODE_SERVICES:
        rows = node_packages(service)
        sections += [f"## services/{service} (Node.js)", "", f"Пакетов: {len(rows)}. {summary(rows)}.", ""]
        if rows:
            sections += table(rows) + [""]

    ml = ml_packages()
    with ThreadPoolExecutor(max_workers=16) as pool:
        licenses = list(pool.map(pypi_license, ml))
    rows = [(n, v, lic) for (n, v), lic in zip(ml, licenses, strict=True)]
    sections += [
        f"## services/ml (Python, extras: {', '.join(ML_EXTRAS)})",
        "",
        f"Пакетов: {len(rows)}. {summary(rows)}.",
        "",
    ]
    sections += table(rows) + [""]

    header = [
        "# Сторонние пакеты в образах продукта",
        "",
        f"> Сгенерировано `scripts/third-party-licenses.py` {date.today():%d.%m.%Y}. Руками не править — "
        "перезапустить скрипт.",
        "> Оценка лицензий, модели и образы — в [third-party-licenses.md](third-party-licenses.md).",
        "> ⚠️ — копилефт (GPL, LGPL, AGPL, MPL и т. п.): разбор в оценке.",
        "",
        "Только зависимости, которые попадают в образы: без dev-пакетов Node.js и без группы `dev` у ML.",
        "",
    ]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(header + sections), encoding="utf-8", newline="\n")
    print(f"written {OUT.relative_to(ROOT).as_posix()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
