"""Единицы разметки из пула: label_keys.py <pool.jsonl> <keys.jsonl>

Размечаем не каждое значение, а уникальную пару «параметр — подпись» (для product — «параметр — фрагмент»):
если подпись «Высота здания» верно называет M-008, то верны и значения под ней во всех документах.
Каждая единица — с примерами значений и фрагментов, чтобы видеть, что за число стоит под подписью.
"""

import collections
import json
import re
import sys


def norm(text: str) -> str:
    text = text.lower().replace("ё", "е")
    text = re.sub(r"\d+([.,]\d+)?", "#", text)
    return re.sub(r"\s+", " ", text).strip(" :;,.—–-|")[:160]


def key_of(row: dict) -> str:
    """Единица разметки — подпись и число под ней: одна подпись в разных документах несёт и верное, и чужое число."""
    value = re.sub(r"[\s ]", "", str(row.get("raw") or "")).replace(",", ".")
    if row["method"] == "sbert":
        return f"S|{row['param']}|{row.get('unit')}|{norm(row['label'])}|{value}"
    return f"P|{row['param']}|{norm(row['snippet'])}|{value}"


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    from inspector_ml.matrix import load_params

    params = load_params()
    pool = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8")]
    groups: dict[str, list[dict]] = collections.defaultdict(list)
    for row in pool:
        groups[key_of(row)].append(row)
    with open(sys.argv[2], "w", encoding="utf-8") as out:
        for key, rows in sorted(groups.items(), key=lambda kv: (kv[0].split("|")[1], kv[0])):
            p = params[rows[0]["param"]]
            values = collections.Counter(r["raw"] for r in rows)
            out.write(
                json.dumps(
                    {
                        "key": key,
                        "param": p.code,
                        "name": p.parameter_name,
                        "unit": p.unit,
                        "method": rows[0]["method"],
                        "n": len(rows),
                        "docs": len({r["sha256"] for r in rows}),
                        "best_rank": min((r.get("rank") or 1) for r in rows),
                        "max_score": max((r.get("score") or 0) for r in rows),
                        "label": rows[0].get("label") or "",
                        "values": values.most_common(5),
                        "snippets": list(dict.fromkeys(r["snippet"] for r in rows))[:2],
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
    by_method = collections.Counter(k.split("|")[0] for k in groups)
    print("единиц разметки:", len(groups), dict(by_method), "| строк пула:", len(pool))


if __name__ == "__main__":
    main()
