"""Отчёт по метрикам в Markdown: report_md.py <metrics.json> <out.md>

Сводка по методам (микро, макро, медиана, разброс, ДИ бутстрепа) и таблица по каждому параметру,
у которого хоть один метод что-то предсказал или есть положительные ячейки.
"""

import json
import sys

sys.stdout.reconfigure(encoding="utf-8")
from inspector_ml.matrix import load_params

report = json.load(open(sys.argv[1], encoding="utf-8"))
names = {c: p.parameter_name for c, p in load_params().items()}
methods = report["methods"]
chosen = [
    "product",
    f"sbert@{report['best_tau_sbert']}",
    f"sbert_excl@{report['best_tau_sbert_excl']}",
    f"fallback@{report['best_tau_fallback']}",
]
title = {
    "product": "продукт (регулярки и свои извлекатели)",
    f"sbert@{report['best_tau_sbert']}": f"Sentence-BERT, τ={report['best_tau_sbert']}",
    f"sbert_excl@{report['best_tau_sbert_excl']}": f"Sentence-BERT + «одна подпись — один параметр», τ={report['best_tau_sbert_excl']}",
    f"fallback@{report['best_tau_fallback']}": f"продукт, где молчит — Sentence-BERT, τ={report['best_tau_fallback']}",
}


def f(x):
    return "—" if x is None else (f"{x:.3f}" if isinstance(x, float) else str(x))


lines = [
    f"Документов: {report['docs']}, числовых параметров: {report['params']}, ячеек «документ × параметр»: "
    f"{report['docs'] * report['params']}, положительных ячеек в пуле: {report['positive_cells']}.",
    "",
]
lines += [
    "| Метод | TP | FP | FN | TN | accuracy | precision | recall | F1 | 95 % ДИ F1 | macro-F1 | медиана F1 | σ F1 | параметров с F1 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
]
for key in chosen:
    s = methods[key]
    m, st = s["micro"], s["stats"]["f1"]
    ci = s.get("micro_f1_ci95")
    lines.append(
        f"| {title[key]} | {m['TP']} | {m['FP']} | {m['FN']} | {m['TN']} | {f(m['accuracy'])} | "
        f"{f(m['precision'])} | {f(m['recall'])} | {f(m['f1'])} | {f(ci[0]) + '–' + f(ci[1]) if ci else '—'} | "
        f"{f(st['macro'])} | {f(st['median'])} | {f(st['stdev'])} | {st['params']} |"
    )
lines += [
    "",
    "Порог Sentence-BERT: F1 (микро) по τ",
    "",
    "| τ | " + " | ".join(k.split("@")[1] for k in methods if k.startswith("sbert@")) + " |",
    "|---|" + "---|" * sum(1 for k in methods if k.startswith("sbert@")),
]
for base in ("sbert", "sbert_excl", "fallback"):
    lines.append(
        f"| {base} | " + " | ".join(f(methods[k]["micro"]["f1"]) for k in methods if k.startswith(base + "@")) + " |"
    )

lines += [
    "",
    "По параметрам (TP/FP/FN, precision, recall, F1)",
    "",
    "| Параметр | Положит. | Продукт TP/FP/FN | P | R | F1 | SBERT TP/FP/FN | P | R | F1 | Запасной TP/FP/FN | F1 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
]
per = {k: methods[k]["per_param"] for k in chosen}
for code in sorted(per["product"]):
    rows = [per[k][code] for k in chosen]
    if not any(r["TP"] or r["FP"] for r in rows) and not rows[0]["positives"]:
        continue
    p, s, _, fb = rows
    lines.append(
        f"| {code} {names.get(code, '')[:40]} | {p['positives']} | {p['TP']}/{p['FP']}/{p['FN']} | {f(p['precision'])} | "
        f"{f(p['recall'])} | {f(p['f1'])} | {s['TP']}/{s['FP']}/{s['FN']} | {f(s['precision'])} | {f(s['recall'])} | "
        f"{f(s['f1'])} | {fb['TP']}/{fb['FP']}/{fb['FN']} | {f(fb['f1'])} |"
    )
open(sys.argv[2], "w", encoding="utf-8").write("\n".join(lines) + "\n")
print("\n".join(lines[:12]))
