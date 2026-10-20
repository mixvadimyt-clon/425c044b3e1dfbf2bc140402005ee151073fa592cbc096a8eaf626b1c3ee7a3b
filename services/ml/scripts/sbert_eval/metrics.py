"""Метрики извлечения по каждому параметру: metrics.py <pool.jsonl> <labels.jsonl> <docs.txt> <отчёт.json> [--tau 0.8]

Единица счёта — ячейка «документ × параметр» (числовые параметры матрицы × документы выборки).
Эталон — пул: ячейка положительная, если хоть один кандидат любого метода (любого ранга) размечен верным;
что не всплыло ни у одного метода, считается отсутствием (допущение пула, пишется в отчёте).

Исход ячейки для метода:
- прогноза нет: FN, если ячейка положительная, иначе TN;
- в прогнозе есть неверное значение: FP (в том числе неверное число в положительной ячейке);
- все значения прогноза верны: TP;
- прогноз целиком из «?» (не удалось решить): ячейка исключается.
precision = TP/(TP+FP), recall = TP/положительных, accuracy = (TP+TN)/ячеек, F1 — гармоническое.
Метод sbert: прогноз — кандидат ранга 1 с близостью ≥ τ; τ перебирается, отчёт — по каждому τ.
Статистика: микро (суммы по параметрам), макро (среднее по параметрам), медиана, ст. отклонение, мин/макс,
95 % доверительный интервал микро-F1 бутстрепом по документам.
"""

import argparse
import collections
import json
import random
import statistics
import sys

sys.stdout.reconfigure(encoding="utf-8")

ap = argparse.ArgumentParser()
ap.add_argument("pool")
ap.add_argument("labels")
ap.add_argument("docs", help="список sha256 документов выборки (по одному в строке)")
ap.add_argument("out")
ap.add_argument("--taus", default="0.6,0.65,0.7,0.75,0.8,0.85,0.9,0.95")
ap.add_argument("--params", default="", help="коды параметров через запятую; по умолчанию все числовые")
ap.add_argument("--boot", type=int, default=1000)
ap.add_argument(
    "--gold-pool",
    default="",
    help="пул, по которому строится эталон (положительные ячейки); по умолчанию — тот же, что для прогнозов. "
    "Нужен для отфильтрованного пула: фильтр убирает строки, и без этого из эталона пропадали бы ячейки",
)
args = ap.parse_args()

from inspector_ml.matrix import load_params

sys.path.insert(0, __file__.rsplit("\\", 1)[0].rsplit("/", 1)[0])
from label_keys import key_of  # noqa: E402

params = {c: p for c, p in load_params().items() if str(getattr(p.data_type, "root", p.data_type)) == "number"}
if args.params:
    params = {c: p for c, p in params.items() if c in args.params.split(",")}
docs = [line.strip() for line in open(args.docs, encoding="utf-8") if line.strip()]
labels = {}
for line in open(args.labels, encoding="utf-8"):
    row = json.loads(line)
    labels[row["key"]] = row["verdict"]  # 1 — верно, 0 — неверно, "?" — не решить
pool = [json.loads(line) for line in open(args.pool, encoding="utf-8")]
unlabeled = {key_of(r) for r in pool if key_of(r) not in labels}
if unlabeled:
    print(f"ВНИМАНИЕ: {len(unlabeled)} единиц пула не размечены — они считаются «?»", file=sys.stderr)

by_cell: dict[tuple[str, str], list[dict]] = collections.defaultdict(list)
for r in pool:
    if r["param"] in params:
        r["verdict"] = labels.get(key_of(r), "?")
        by_cell[(r["sha256"], r["param"])].append(r)
positive = {cell for cell, rows in by_cell.items() if any(r["verdict"] == 1 for r in rows)}
if args.gold_pool:
    positive = set()
    for line in open(args.gold_pool, encoding="utf-8"):
        r = json.loads(line)
        if r["param"] in params and labels.get(key_of(r)) == 1:
            positive.add((r["sha256"], r["param"]))

# «одна подпись — один параметр»: подпись документа достаётся тому параметру, к которому она ближе всего.
# «Строительный объём» без этого правила становится прогнозом и общего, и подземного, и надземного объёма.
owner: dict[tuple[str, str, str], tuple[float, str]] = {}
for r in pool:
    if r["method"] == "sbert" and r.get("rank") == 1 and r["param"] in params:
        key = (r["sha256"], r["label"], r["raw"])
        if key not in owner or r["score"] > owner[key][0]:
            owner[key] = (r["score"], r["param"])


def prediction(rows: list[dict], method: str, tau: float) -> list[dict]:
    product = [r for r in rows if r["method"] == "product"]
    if method == "product":
        return product
    if method == "fallback" and product:
        return product  # запасной путь: где продукт что-то нашёл, Sentence-BERT не нужен
    pred = [r for r in rows if r["method"] == "sbert" and r.get("rank") == 1 and r["score"] >= tau]
    if method in ("sbert_excl", "fallback"):
        pred = [r for r in pred if owner[(r["sha256"], r["label"], r["raw"])][1] == r["param"]]
    return pred


def outcome(cell: tuple[str, str], method: str, tau: float) -> str | None:
    pred = prediction(by_cell.get(cell, []), method, tau)
    if not pred:
        return "FN" if cell in positive else "TN"
    verdicts = [r["verdict"] for r in pred]
    if 0 in verdicts:
        return "FP"
    if all(v == "?" for v in verdicts):
        return None
    return "TP"


def scores(c: collections.Counter) -> dict:
    tp, fp, fn, tn = c["TP"], c["FP"], c["FN"], c["TN"]
    pos = c["POS"]
    n = tp + fp + fn + tn
    precision = tp / (tp + fp) if tp + fp else None
    recall = tp / pos if pos else None
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision and recall
        else (0.0 if (precision == 0 or recall == 0) else None)
    )
    return {
        "TP": tp,
        "FP": fp,
        "FN": fn,
        "TN": tn,
        "positives": pos,
        "cells": n,
        "accuracy": round((tp + tn) / n, 4) if n else None,
        "precision": round(precision, 4) if precision is not None else None,
        "recall": round(recall, 4) if recall is not None else None,
        "f1": round(f1, 4) if f1 is not None else None,
    }


def evaluate(method: str, tau: float, doc_subset: list[str]) -> dict[str, collections.Counter]:
    per = {code: collections.Counter() for code in params}
    for sha in doc_subset:
        for code in params:
            cell = (sha, code)
            o = outcome(cell, method, tau)
            if o is None:
                continue
            per[code][o] += 1
            if cell in positive:
                per[code]["POS"] += 1
    return per


def summary(per: dict[str, collections.Counter]) -> dict:
    total = collections.Counter()
    for c in per.values():
        total.update(c)
    rows = {code: scores(c) for code, c in per.items()}
    stat = {}
    for m in ("accuracy", "precision", "recall", "f1"):
        vals = [r[m] for r in rows.values() if r[m] is not None]
        stat[m] = {
            "macro": round(statistics.mean(vals), 4) if vals else None,
            "median": round(statistics.median(vals), 4) if vals else None,
            "stdev": round(statistics.stdev(vals), 4) if len(vals) > 1 else None,
            "min": min(vals) if vals else None,
            "max": max(vals) if vals else None,
            "params": len(vals),
        }
    return {"micro": scores(total), "stats": stat, "per_param": rows}


def boot_f1(method: str, tau: float) -> list[float]:
    rng = random.Random(7)
    f1s = []
    for _ in range(args.boot):
        sample = [rng.choice(docs) for _ in docs]
        total = collections.Counter()
        for c in evaluate(method, tau, sample).values():
            total.update(c)
        f1 = scores(total)["f1"]
        if f1 is not None:
            f1s.append(f1)
    f1s.sort()
    return [round(f1s[int(0.025 * len(f1s))], 4), round(f1s[int(0.975 * len(f1s)) - 1], 4)] if f1s else [None, None]


report = {
    "docs": len(docs),
    "params": len(params),
    "positive_cells": sum(1 for c in positive if c[0] in set(docs)),
    "unlabeled_keys": len(unlabeled),
    "methods": {},
}
report["methods"]["product"] = summary(evaluate("product", 0, docs))
report["methods"]["product"]["micro_f1_ci95"] = boot_f1("product", 0)
for method in ("sbert", "sbert_excl", "fallback"):
    best = None
    for tau in map(float, args.taus.split(",")):
        s = summary(evaluate(method, tau, docs))
        report["methods"][f"{method}@{tau}"] = s
        f1 = s["micro"]["f1"] or 0
        if best is None or f1 > best[1]:
            best = (tau, f1)
    report[f"best_tau_{method}"] = best[0]
    report["methods"][f"{method}@{best[0]}"]["micro_f1_ci95"] = boot_f1(method, best[0])
json.dump(report, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
for name, s in report["methods"].items():
    m = s["micro"]
    print(
        f"{name:12} TP {m['TP']:4} FP {m['FP']:4} FN {m['FN']:4} TN {m['TN']:6} | acc {m['accuracy']} "
        f"P {m['precision']} R {m['recall']} F1 {m['f1']} | macro-F1 {s['stats']['f1']['macro']} "
        f"{'CI ' + str(s.get('micro_f1_ci95')) if s.get('micro_f1_ci95') else ''}"
    )
print("лучший τ:", {k: v for k, v in report.items() if k.startswith("best_tau")})
