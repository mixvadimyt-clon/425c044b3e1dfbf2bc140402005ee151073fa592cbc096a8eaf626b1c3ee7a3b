#!/usr/bin/env python3
"""Проверка покрытия матрицы: контрольный комплект 3 → протокол → «ожидали / получили» по 132 параметрам.

Два режима, ответ один — ``<комплект>.expected.json``, который пишет ``demo-errors-set.py --set 3``.

**Офлайн** (по умолчанию): без api и очередей, тот же разбор PDF (``ingest.pdf.parse_pdf``), то же
извлечение (``extract.api.extract_param``) и тот же движок (``compare.engine.run``), что в конвейере,
по всем параметрам ``data/matrix/params.csv``. Метаданные файлов — из ``registry.csv`` комплекта, как при
загрузке. Запуск — в образе ML, из корня репозитория:

    docker run --rm -v "$PWD:/w" -w /w --entrypoint /app/services/ml/.venv/bin/python \\
        inspector-ml scripts/matrix-check.py "var/set3/Контрольный комплект 3"

**Через стенд** (``--api``): комплект загружается как из интерфейса, протокол берётся из api. Проверяет
то, чего не видит офлайн: матрицу в базе (активны ли параметры), передачу запроса в ML, сборку протокола.
Нужен только Python 3 без пакетов:

    python scripts/matrix-check.py "var/set3/Контрольный комплект 3" --api http://localhost --password …

Код выхода 0 — каждый параметр дал ожидаемый статус. Иначе в конце — список расхождений
с обоснованием движка: по нему видно, что чинить (якорь, шаблон, триггер или сам комплект).
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
import time
import urllib.request
import uuid
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STAGES = {"ПД": "PD", "РД": "RD", "ИД": "ID"}
NOW = "2026-09-24T00:00:00Z"


def _plain(value: object) -> object:
    return getattr(value, "root", value)


def matrix_params(path: Path) -> list[dict]:
    params = []
    for i, row in enumerate(csv.DictReader(path.open(encoding="utf-8")), 1):
        data = {k: v for k, v in row.items() if v != ""}
        data["semantic_anchors"] = [a for a in row["semantic_anchors"].split("|") if a]
        data["enum_values"] = [a for a in row["enum_values"].split("|") if a]
        for limit in ("min_value", "max_value"):
            if limit in data:
                data[limit] = float(data[limit])
        data.update(id=i, is_active=True, created_at=NOW, updated_at=NOW)
        params.append(data)
    return params


def offline(folder: Path, matrix: Path) -> tuple[list[dict], str]:
    """Проверки движка по комплекту: разбор и сравнение прямо здесь, как в конвейере ML."""
    from inspector_ml.compare.engine import run
    from inspector_ml.contracts.events import CompareRequest
    from inspector_ml.extract.api import LoadedDocument, extract_param
    from inspector_ml.ingest.pdf import parse_pdf

    registry = {
        r["Имя файла"]: r for r in csv.DictReader((folder / "registry.csv").open(encoding="utf-8-sig"), delimiter=";")
    }
    files, parsed, expected_docs = [], [], []
    for pdf in sorted(folder.rglob("*.pdf")):
        reg = registry[pdf.name]
        sha = hashlib.sha256(pdf.read_bytes()).hexdigest()
        metadata = {
            "doc_stage": STAGES[reg["Стадия"]],
            "discipline": reg["Марка"] or None,
            "document_code": reg["Шифр"] or None,
            "approval_status": "APPROVED",
        }
        files.append({
            "file_id": str(uuid.uuid5(uuid.NAMESPACE_URL, pdf.name)), "sha256": sha, "original_name": pdf.name,
            "metadata": metadata, "parsed_ref": {"bucket": "local", "key": f"parsed/{sha}.json"}, "uploaded_at": NOW,
        })  # fmt: skip
        # реестр — это и ожидаемый состав: api передаёт его движку так же
        expected_docs.append(
            {k: metadata[k] for k in ("doc_stage", "discipline", "document_code")} | {"file_name": pdf.name}
        )
        parsed.append(parse_pdf(pdf, sha, "matrix-check", file_name=pdf.name))
    request = CompareRequest.model_validate({
        "process_id": str(uuid.uuid4()), "object_id": str(uuid.uuid4()), "protocol_version": 1, "mode": "FULL",
        "matrix": {"version": "matrix-check", "params": matrix_params(matrix)}, "files": files,
        "expected_documents": expected_docs, "versions": {"dataset_version": "none"},
    })  # fmt: skip
    docs = [LoadedDocument(file_id=f.file_id, sha256=f.sha256, metadata=f.metadata, parsed=p)
            for f, p in zip(request.files, parsed, strict=True)]  # fmt: skip
    result = run(request, docs, extract_param)
    checks = [
        {
            "param_code": c.param_code,
            "finding_status": str(_plain(c.finding_status)),
            "expected_value": c.expected_value,
            "actual_value": c.actual_value,
            "rationale": c.rationale,
            "stages": [str(_plain(s)) for s in c.stages_compared or []],
        }
        for c in result.checks
    ]
    return checks, f"документов {len(files)}, движок {result.stats.duration_ms} мс"


def _call(base: str, method: str, path: str, body: bytes | None = None, headers: dict | None = None) -> object:
    req = urllib.request.Request(base + path, data=body, method=method, headers=headers or {})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read() or b"null")


def via_api(folder: Path, base: str, login: str, password: str, name: str) -> tuple[list[dict], str]:
    """Проверки из протокола стенда: новый объект, загрузка комплекта с реестром, ожидание готовности."""
    body = json.dumps({"login": login, "password": password}).encode()
    token = _call(base, "POST", "/api/v1/auth/login", body, {"content-type": "application/json"})["access_token"]
    auth = {"authorization": f"Bearer {token}"}
    body = json.dumps({"name": name}).encode()
    obj = _call(base, "POST", "/api/v1/objects", body, {**auth, "content-type": "application/json"})["id"]

    boundary = uuid.uuid4().hex
    parts = [f'--{boundary}\r\nContent-Disposition: form-data; name="object_id"\r\n\r\n{obj}\r\n'.encode()]
    uploads = [("registry", folder / "registry.csv", "text/csv")]
    uploads += [("files", p, "application/pdf") for p in sorted(folder.rglob("*.pdf"))]
    for field, path, ctype in uploads:
        head = f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="{path.name}"\r\n'
        parts.append(f"{head}Content-Type: {ctype}\r\n\r\n".encode() + path.read_bytes() + b"\r\n")
    body = b"".join(parts) + f"--{boundary}--\r\n".encode()
    started = time.monotonic()
    headers = {**auth, "content-type": f"multipart/form-data; boundary={boundary}"}
    process = _call(base, "POST", "/api/v1/documents/upload", body, headers)["process_id"]
    while True:
        status = _call(base, "GET", f"/api/v1/processes/{process}/status", headers=auth)
        if status["status"] in ("READY", "VERIFYING", "COMPLETED", "FAILED") or time.monotonic() - started > 1800:
            break
        time.sleep(3)
    took = time.monotonic() - started
    if not status.get("current_protocol_id"):
        raise SystemExit(f"протокола нет: проверка {process} в статусе {status['status']} за {took:.0f} с")
    protocol = _call(base, "GET", f"/api/v1/protocols/{status['current_protocol_id']}", headers=auth)
    tables = protocol["tables"]
    # таблица комплектности — строка на каждую точку проверки; значения и обоснование — в строке находки
    details = {r["id"]: r for name, rows in tables.items() if name not in ("completeness", "suspicions") for r in rows}
    checks = []
    for r in tables["completeness"]:
        finding = details.get(r.get("finding_id"), {})
        checks.append({
            "param_code": r["param_code"],
            "finding_status": r["finding_status"],
            "expected_value": finding.get("expected_value"),
            "actual_value": finding.get("actual_value"),
            "rationale": finding.get("rationale") or r.get("comment") or "; ".join(r.get("missing_sources") or []),
            "stages": finding.get("stages_compared") or sorted(r.get("stages_present") or [], key="PD RD ID".split().index),
        })  # fmt: skip
    sizes = {k: len(v) for k, v in tables.items()}
    return checks, f"проверка {process}: {status['status']} за {took:.0f} с, таблицы протокола {sizes}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("set", type=Path, help="папка комплекта с registry.csv")
    ap.add_argument("--expected", type=Path, help="ответ; по умолчанию <папка>.expected.json рядом")
    ap.add_argument(
        "--matrix", type=Path, default=ROOT / "data" / "matrix" / "params.csv", help="матрица офлайн-прогона"
    )
    ap.add_argument("--api", help="адрес стенда, например http://localhost: загрузить комплект туда")
    ap.add_argument("--login", default="inspector")
    ap.add_argument("--password", help="пароль пользователя стенда (для --api)")
    ap.add_argument("--report", type=Path, help="куда записать таблицу «ожидали / получили» (CSV)")
    args = ap.parse_args()
    expected = json.loads((args.expected or args.set.parent / f"{args.set.name}.expected.json").read_text("utf-8"))

    if args.api:
        if not args.password:
            ap.error("для --api нужен --password")
        name = f"Контрольный комплект 3 (matrix-check {time.strftime('%d.%m %H:%M')})"
        checks, summary = via_api(args.set, args.api.rstrip("/"), args.login, args.password, name)
    else:
        checks, summary = offline(args.set, args.matrix)

    by_param: dict[str, list[dict]] = {}
    for check in checks:
        by_param.setdefault(check["param_code"], []).append(check)
    rows, wrong = [], []
    for code, want in expected.items():
        found = by_param.get(code, [])
        got = sorted({c["finding_status"] for c in found}) or ["—"]
        first = found[0] if found else {}
        row = {
            "code": code, "section": want["section"], "expected": want["expected"], "got": ",".join(got),
            "ok": "да" if got == [want["expected"]] else "НЕТ", "pd": want["pd"], "rd": want["rd"],
            "found_pd": first.get("expected_value"), "found_rd": first.get("actual_value"),
            "stages": ",".join(first.get("stages") or []), "rationale": first.get("rationale", "проверки нет"),
        }  # fmt: skip
        rows.append(row)
        if row["ok"] != "да":
            wrong.append(row)

    if args.report:
        with args.report.open("w", encoding="utf-8-sig", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=list(rows[0]), delimiter=";")
            writer.writeheader()
            writer.writerows(rows)
    print(f"{summary}; параметров {len(rows)}, проверок {len(checks)}")
    print("Получено:", dict(Counter(r["got"] for r in rows)))
    print("Стадии со значением:", dict(Counter(r["stages"] for r in rows)))
    print(f"Совпало с ожиданием: {len(rows) - len(wrong)} из {len(rows)}")
    for r in wrong:
        print(
            f"  {r['code']} [{r['section']}] ждали {r['expected']}, получили {r['got']}: "
            f"ПД {r['pd']!r} → {r['found_pd']!r}, РД {r['rd']!r} → {r['found_rd']!r}. {r['rationale'][:200]}"
        )
    return 0 if not wrong else 1


if __name__ == "__main__":
    sys.exit(main())
