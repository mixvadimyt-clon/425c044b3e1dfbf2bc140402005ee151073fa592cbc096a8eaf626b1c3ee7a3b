"""Разметка в файл по ключам: apply_labels.py <keys.jsonl> <labels.jsonl> <решения.txt> [--default-s 0] [--default-p 1] [--min-score 0.7]

решения.txt — строки «номер решение [комментарий]», номер — строка в keys.jsonl (как в label_view), решение 1 / 0 / ?.
Остальные показанные единицы получают решение по умолчанию: sbert — 0 (подпись не про параметр), product — 1.
Единицы sbert ниже min-score не размечаются вовсе (в метриках они — «?», а прогнозом при τ ≥ min-score не бывают).
Уже размеченные ключи не перезаписываются, если их нет в решениях.
"""

import argparse
import json

ap = argparse.ArgumentParser()
ap.add_argument("keys")
ap.add_argument("labels")
ap.add_argument("decisions")
ap.add_argument("--default-s", default="0")
ap.add_argument("--default-p", default="1")
ap.add_argument("--min-score", type=float, default=0.7)
ap.add_argument("--params", default="", help="только эти параметры (через запятую), остальные не трогать")
args = ap.parse_args()


def parse(v: str):
    return v if v == "?" else int(v)


keys = [json.loads(line) for line in open(args.keys, encoding="utf-8")]
labels = {}
try:
    for line in open(args.labels, encoding="utf-8"):
        row = json.loads(line)
        labels[row["key"]] = row
except FileNotFoundError:
    pass
explicit = {}
for line in open(args.decisions, encoding="utf-8"):
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    idx, verdict, *note = line.split(maxsplit=2)
    explicit[int(idx)] = (parse(verdict), note[0] if note else "")
params = set(filter(None, args.params.split(",")))
added = 0
for i, k in enumerate(keys):
    if params and k["param"] not in params:
        continue
    if i in explicit:
        verdict, note = explicit[i]
    elif k["key"] in labels:
        continue
    elif k["method"] == "sbert":
        if k["max_score"] < args.min_score:
            continue
        verdict, note = parse(args.default_s), "по умолчанию"
    else:
        verdict, note = parse(args.default_p), "по умолчанию"
    labels[k["key"]] = {
        "key": k["key"],
        "param": k["param"],
        "verdict": verdict,
        "note": note,
        "text": k["label"] or k["snippets"][0][:120],
    }
    added += 1
with open(args.labels, "w", encoding="utf-8") as out:
    for row in labels.values():
        out.write(json.dumps(row, ensure_ascii=False) + "\n")
print("размечено сейчас:", added, "| всего в разметке:", len(labels))
