"""Компактный вид единиц разметки: label_view.py <keys.jsonl> <out.txt> [--method p|s] [--min-score 0.7] [--labels labels.jsonl]

По параметру: номер единицы, метод, подпись или фрагмент, частые значения, документы, близость.
Уже размеченные единицы (из labels.jsonl) пропускаются.
"""

import argparse
import json

ap = argparse.ArgumentParser()
ap.add_argument("keys")
ap.add_argument("out")
ap.add_argument("--method", default="")
ap.add_argument("--min-score", type=float, default=0.0)
ap.add_argument("--labels", default="")
args = ap.parse_args()

keys = [json.loads(line) for line in open(args.keys, encoding="utf-8")]
done = set()
if args.labels:
    try:
        done = {json.loads(line)["key"] for line in open(args.labels, encoding="utf-8")}
    except FileNotFoundError:
        pass
current = None
shown = 0
with open(args.out, "w", encoding="utf-8") as out:
    for i, k in enumerate(keys):
        if k["key"] in done or (args.method and k["method"][0] != args.method):
            continue
        if k["method"] == "sbert" and k["max_score"] < args.min_score:
            continue
        if k["param"] != current:
            current = k["param"]
            out.write(f"\n### {k['param']} {k['name']} [{k['unit']}]\n")
        values = ", ".join(f"{v}×{n}" if n > 1 else v for v, n in k["values"][:4])
        text = k["label"] if k["method"] == "sbert" else k["snippets"][0]
        extra = f" r{k['best_rank']} s{k['max_score']:.2f}" if k["method"] == "sbert" else ""
        out.write(f"{i}\t{k['method'][0]}{extra}\t{k['docs']}д\t{text[:120]}\t→ {values}\n")
        shown += 1
print("показано единиц:", shown)
