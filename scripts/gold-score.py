#!/usr/bin/env python3
"""Балл на публичном эталоне: ответ в формате организаторов против 15 открытых проверок.

Эталон — `data/samples/public_gold_checks.jsonl`, открытая разметка TRAIN на двух объектах: «Тюменская 5»
(10 зачётных проверок с нарушением) и «Новослободская» (5 отрицательных, незачётных). Ответ — выгрузка
протокола в формате организаторов (`submission`, схема `data/samples/submission_schema.json`), по одной на
объект: из интерфейса или прямо из api. Ответ относится к объекту эталона по `object_id`; если в api объект
заведён под другим идентификатором, укажите его явно: `ответ.json=OBJ-TYUMENSKAYA-5-GOLD-SEED`.

Что считаем (все числа — только по открытой разметке, закрытые материалы не читаем, правило проекта):

- **выявление** — по зачётным проверкам (`score_eligible = true`): найдено ли нарушение
  (`VIOLATION_PRESENT`) с тем же `parameter_code` и `location`. Отрицательные проверки эталона дают
  ложные срабатывания, если мы на них заявили нарушение. P / R / F1;
- **локализация** — у найденных: сколько эталонных пар «файл + страница» есть в наших доказательствах;
- **статус** — совпал ли `protocol_status` (CRITICAL / WARNING / OK);
- **вне эталона** — наши нарушения, которых в разметке нет: оценить их нечем, показываем числом.

Сопоставление: код параметра один в один; `location` без учёта регистра и пробелов, номер помещения
как число («012» = «12»). Свободный поиск (`FREE-*`) у нас пишется без `location`, поэтому он
совпадает с эталоном по общей странице доказательства. Запись без `location` с тем же кодом и общей
страницей засчитывается как групповой ответ.

Запуск — только Python 3, без пакетов:

    python scripts/gold-score.py тюменская.json=OBJ-TYUMENSKAYA-5-GOLD-SEED новослободская.json=OBJ-NOVOSLOBODSKAYA
    python scripts/gold-score.py --api https://lct.bakost.com --login inspector --password … \
        --protocol <id>=OBJ-TYUMENSKAYA-5-GOLD-SEED --protocol <id>=OBJ-NOVOSLOBODSKAYA

Объект эталона без ответа считается целиком пропущенным: его нарушения уходят в FN.

`--json отчёт.json` сохраняет разбор по каждой проверке, `--markdown` печатает таблицу для README.
Код выхода 0 всегда: это замер, а не проверка.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GOLD = ROOT / "data" / "samples" / "public_gold_checks.jsonl"
_SPACES = re.compile(r"\s+")
_NUMBER = re.compile(r"\d+")


def load_gold(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def fetch_submission(base: str, login: str, password: str, protocol: str) -> dict:
    """Выгрузка протокола в формате организаторов через api — как кнопка в интерфейсе."""
    base = base.rstrip("/")
    body = json.dumps({"login": login, "password": password}).encode()
    req = urllib.request.Request(f"{base}/api/v1/auth/login", data=body, method="POST",
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        token = json.load(r)["access_token"]
    url = f"{base}/api/v1/protocols/{urllib.parse.quote(protocol)}/export?format=submission"
    req = urllib.request.Request(url, headers={"authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)


def norm_location(value: object) -> str:
    text = _SPACES.sub(" ", str(value or "")).strip().casefold()
    return str(int(text)) if text.isdigit() else text


def same_location(gold: dict, ours: object) -> bool:
    want, got = norm_location(gold.get("location")), norm_location(ours)
    if not want or not got:
        return False
    if want == got:
        return True
    # Помещение: «012» в эталоне и «пом. 12» или «Помещение 012» у нас.
    if gold.get("location_type") == "ROOM" and want.isdigit():
        return want in {str(int(n)) for n in _NUMBER.findall(got)}
    return False


def pages(evidence: list[dict] | None) -> set[tuple[str, int]]:
    return {(str(e.get("file_id")), int(e.get("pdf_page_number") or 0)) for e in evidence or []}


def matches(gold: dict, check: dict) -> bool:
    """Наша запись отвечает на эталонную проверку."""
    code = gold["parameter_code"]
    ours = str(check.get("parameter_code") or "")
    shared_page = bool(pages(gold.get("evidence")) & pages(check.get("evidence")))
    if code.startswith("FREE-"):
        return ours.startswith("FREE") and (same_location(gold, check.get("location")) or shared_page)
    if ours != code:
        return False
    if same_location(gold, check.get("location")):
        return True
    return not norm_location(check.get("location")) and shared_page  # групповой ответ


def score(gold: list[dict], submissions: dict[str, dict]) -> dict:
    """`submissions` — ответ на каждый объект эталона: object_id → выгрузка."""
    checks = []  # (object_id, запись ответа)
    for object_id, sub in submissions.items():
        checks.extend((object_id, c) for c in sub.get("checks") or [])
    used: set[int] = set()
    rows = []
    for g in gold:
        hits = [i for i, (obj, c) in enumerate(checks) if obj == g.get("object_id") and matches(g, c)]
        violations = [i for i in hits if checks[i][1].get("violation_label") == "VIOLATION_PRESENT"]
        positive = g.get("violation_label") == "VIOLATION_PRESENT"
        best = violations[0] if violations else (hits[0] if hits else None)
        used.update(hits)
        ours = checks[best][1] if best is not None else {}
        want = pages(g.get("evidence"))
        got = pages(ours.get("evidence"))
        rows.append({
            "check_id": g["check_id"],
            "parameter_code": g["parameter_code"],
            "location": g.get("location"),
            "score_eligible": bool(g.get("score_eligible")),
            "gold_label": g.get("violation_label"),
            "gold_status": g.get("protocol_status"),
            "our_label": ours.get("violation_label"),
            "our_status": ours.get("protocol_status"),
            "outcome": ("TP" if violations else "FN") if positive else ("FP" if violations else "TN"),
            "pages_hit": len(want & got),
            "pages_total": len(want),
            "status_ok": bool(violations) and ours.get("protocol_status") == g.get("protocol_status"),
        })

    eligible = [r for r in rows if r["score_eligible"]]
    tp = sum(r["outcome"] == "TP" for r in eligible)
    fn = sum(r["outcome"] == "FN" for r in eligible)
    fp = sum(r["outcome"] == "FP" for r in rows)  # ложное нарушение на любой отрицательной проверке эталона
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / (tp + fn) if tp + fn else None
    f1 = 2 * precision * recall / (precision + recall) if precision and recall else 0.0
    found = [r for r in eligible if r["outcome"] == "TP"]
    outside = sum(1 for i, (_, c) in enumerate(checks) if i not in used and c.get("violation_label") == "VIOLATION_PRESENT")
    return {
        "objects": sorted(submissions),
        "missing_objects": sorted({str(g.get("object_id")) for g in gold} - set(submissions)),
        "totals": {
            "eligible": len(eligible),
            "tp": tp, "fn": fn, "fp": fp,
            "precision": precision, "recall": recall, "f1": f1,
            "localization": (sum(r["pages_hit"] for r in found) / sum(r["pages_total"] for r in found)) if found else None,
            "status": (sum(r["status_ok"] for r in found) / len(found)) if found else None,
            "negatives": sum(not r["score_eligible"] or r["gold_label"] != "VIOLATION_PRESENT" for r in rows),
            "violations_outside_gold": outside,
            "submission_checks": len(checks),
        },
        "rows": rows,
    }


def _pct(value: float | None) -> str:
    return "—" if value is None else f"{value:.2f}"


def print_report(report: dict, markdown: bool) -> None:
    t = report["totals"]
    if markdown:
        print("| Проверка | Код | Место | Эталон | Наш ответ | Итог | Страницы |")
        print("|---|---|---|---|---|---|---|")
        for r in report["rows"]:
            ours = r["our_label"] or "нет записи"
            print(f"| {r['check_id']} | {r['parameter_code']} | {r['location']} | {r['gold_label']} | {ours} "
                  f"| {r['outcome']} | {r['pages_hit']} из {r['pages_total']} |")
        print()
    else:
        for r in report["rows"]:
            mark = "зачётная" if r["score_eligible"] else "незачётная"
            print(f"{r['check_id']:<11} {r['parameter_code']:<17} {str(r['location'])[:28]:<28} {mark:<10} "
                  f"{r['outcome']:<3} эталон {r['gold_label']:<17} у нас {r['our_label'] or 'нет записи':<20} "
                  f"страницы {r['pages_hit']}/{r['pages_total']}")
        print()
    print(f"Зачётных проверок: {t['eligible']}. TP {t['tp']}, FN {t['fn']}, FP {t['fp']} "
          f"(ложные нарушения на отрицательных проверках эталона).")
    print(f"Precision {_pct(t['precision'])}, Recall {_pct(t['recall'])}, F1 {t['f1']:.2f}. "
          f"Локализация найденных {_pct(t['localization'])}, статус найденных {_pct(t['status'])}.")
    print(f"Наших нарушений вне эталона: {t['violations_outside_gold']} из {t['submission_checks']} записей ответа.")
    if report["missing_objects"]:
        print(f"Нет ответа на объекты эталона: {', '.join(report['missing_objects'])}: зачётные нарушения этого объекта считаются пропущенными (FN).")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("submission", nargs="*", help="выгрузка протокола в формате организаторов (JSON), можно `файл=OBJECT_ID`")
    ap.add_argument("--gold", type=Path, default=GOLD)
    ap.add_argument("--api", help="адрес api, например https://lct.bakost.com")
    ap.add_argument("--login")
    ap.add_argument("--password")
    ap.add_argument("--protocol", action="append", default=[], help="id протокола, можно `id=OBJECT_ID`; повторяется")
    ap.add_argument("--json", type=Path, help="сохранить разбор в JSON")
    ap.add_argument("--markdown", action="store_true", help="таблица для README")
    args = ap.parse_args()

    loaded: list[tuple[dict, str | None]] = []
    if args.api:
        if not (args.login and args.password and args.protocol):
            ap.error("для --api нужны --login, --password и --protocol")
        for item in args.protocol:
            protocol, _, obj = item.partition("=")
            loaded.append((fetch_submission(args.api, args.login, args.password, protocol), obj or None))
    elif args.submission:
        for item in args.submission:
            path, _, obj = item.partition("=")
            loaded.append((json.loads(Path(path).read_text(encoding="utf-8")), obj or None))
    else:
        ap.error("нужен файл ответа или --api")

    gold = load_gold(args.gold)
    known = {str(g.get("object_id")) for g in gold}
    submissions: dict[str, dict] = {}
    for sub, obj in loaded:
        object_id = obj or str(sub.get("object_id"))
        if object_id not in known:
            ap.error(f"ответ на объект {object_id!r} не относится к эталону ({', '.join(sorted(known))}); "
                     "укажите объект явно: файл=OBJECT_ID")
        submissions[object_id] = sub
    report = score(gold, submissions)
    print_report(report, args.markdown)
    if args.json:
        args.json.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
