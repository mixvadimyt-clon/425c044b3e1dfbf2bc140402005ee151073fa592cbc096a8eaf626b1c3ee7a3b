"""Фильтры поверх кандидатов Sentence-BERT: sbert_filter.py learn|apply ...

    learn <pool-train.jsonl> <labels-train.jsonl> <stops.json> [--min-bad 3] [--min-score 0.85]
    apply <pool.jsonl> <stops.json> <out.jsonl> [--only range,integer,generic,stops]

Модель сравнивает подпись с названием параметра и не видит, что уточнение меняет смысл: «общая площадь
здания, подземная часть», «строительный объём сносимого здания», «строение 54, этаж». Фильтры отсекают
такие подписи до выбора лучшего кандидата, после чего кандидаты ячейки заново ранжируются по близости:
если первый отсеян, прогнозом становится следующий.

- `range` — значение вне `min_value`…`max_value` параметра из матрицы;
- `integer` — у счётного параметра (шт., ед.) дробное значение;
- `generic` — в подписи меньше двух содержательных слов («этаж», «Площадь»);
- `stops` — в подписи есть основа слова, которой нет в названии и якорях параметра, и которая на
  обучающих объектах встречалась только у неверных кандидатов (`learn`: не меньше `--min-bad` раз и ни
  разу у верного). Список учится **только по обучающей разметке**; отложенные объекты для него не смотрим.

Кандидаты продукта (`method: product`) не трогаются.
"""

from __future__ import annotations

import argparse
import collections
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.stdout.reconfigure(encoding="utf-8")

from label_keys import key_of  # noqa: E402

from inspector_ml.matrix import load_params  # noqa: E402

WORD = re.compile(r"[а-яёa-z]{3,}", re.IGNORECASE)
STEM = 6
COUNT_UNITS = {"шт.", "шт", "ед.", "ед"}
FILTERS = ("range", "integer", "generic", "stops")


def stems(text: str) -> set[str]:
    return {w[:STEM] for w in re.findall(r"[а-яё]{4,}", text.lower().replace("ё", "е"))}


def own_stems() -> dict[str, set[str]]:
    """Основы слов названия и якорей каждого параметра — их уточнением не считаем."""
    out = {}
    for code, p in load_params().items():
        anchors = p.semantic_anchors if isinstance(p.semantic_anchors, list) else (p.semantic_anchors or "").split("|")
        out[code] = stems(" ".join([p.parameter_name, *anchors]))
    return out


def learn(args: argparse.Namespace) -> None:
    own = own_stems()
    labels = {}
    for line in open(args.labels, encoding="utf-8"):
        row = json.loads(line)
        labels[row["key"]] = row["verdict"]
    bad: collections.Counter[str] = collections.Counter()
    good: collections.Counter[str] = collections.Counter()
    for line in open(args.pool, encoding="utf-8"):
        row = json.loads(line)
        if row["method"] != "sbert" or row["score"] < args.min_score:
            continue
        verdict = labels.get(key_of(row))
        if verdict not in (0, 1):
            continue
        for stem in stems(row["label"]) - own[row["param"]]:
            (bad if verdict == 0 else good)[stem] += 1
    stops = sorted(s for s, n in bad.items() if n >= args.min_bad and good[s] == 0)
    Path(args.stops).write_text(
        json.dumps({"min_bad": args.min_bad, "min_score": args.min_score, "stops": stops}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    print(f"стоп-основ: {len(stops)} — {', '.join(stops)}")


def reject(row: dict, param, own: set[str], stops: set[str], only: set[str]) -> str | None:
    """Почему кандидат отсеян, или `None`."""
    try:
        value = float(row["value"])
    except (TypeError, ValueError):
        value = None
    if "range" in only and value is not None:
        if (param.min_value is not None and value < param.min_value) or (
            param.max_value is not None and value > param.max_value
        ):
            return "range"
    if "integer" in only and value is not None and (param.unit or "").strip() in COUNT_UNITS and value != int(value):
        return "integer"
    if "generic" in only and len(WORD.findall(row["label"])) < 2:
        return "generic"
    if "stops" in only and (stems(row["label"]) - own) & stops:
        return "stops"
    return None


def apply(args: argparse.Namespace) -> None:
    params = load_params()
    own = own_stems()
    stops = set(json.loads(Path(args.stops).read_text(encoding="utf-8"))["stops"])
    only = set(args.only.split(",")) if args.only else set(FILTERS)
    kept: dict[tuple[str, str], list[dict]] = collections.defaultdict(list)
    passthrough: list[dict] = []
    reasons: collections.Counter[str] = collections.Counter()
    for line in open(args.pool, encoding="utf-8"):
        row = json.loads(line)
        if row["method"] != "sbert":
            passthrough.append(row)
            continue
        why = reject(row, params[row["param"]], own[row["param"]], stops, only)
        if why:
            reasons[why] += 1
            continue
        kept[(row["sha256"], row["param"])].append(row)
    with open(args.out, "w", encoding="utf-8") as out:
        for row in passthrough:
            out.write(json.dumps(row, ensure_ascii=False) + "\n")
        for rows in kept.values():
            for rank, row in enumerate(sorted(rows, key=lambda r: -r["score"]), start=1):
                out.write(json.dumps({**row, "rank": rank}, ensure_ascii=False) + "\n")
    print(f"отсеяно кандидатов Sentence-BERT: {sum(reasons.values())} — {dict(reasons)}")


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("learn")
    a.add_argument("pool")
    a.add_argument("labels")
    a.add_argument("stops")
    a.add_argument("--min-bad", type=int, default=3)
    a.add_argument("--min-score", type=float, default=0.85)
    b = sub.add_parser("apply")
    b.add_argument("pool")
    b.add_argument("stops")
    b.add_argument("out")
    b.add_argument("--only", default="")
    args = ap.parse_args()
    learn(args) if args.cmd == "learn" else apply(args)


if __name__ == "__main__":
    main()
