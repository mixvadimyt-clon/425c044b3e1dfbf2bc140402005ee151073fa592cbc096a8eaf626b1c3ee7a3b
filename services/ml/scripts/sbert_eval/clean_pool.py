"""Чистка пула перед разметкой: clean_pool.py <pool.jsonl> <meta.jsonl> <objects> <pool-clean.jsonl> <docs.txt>

- M-002 у продукта — по помещениям (экспликация) и итог «Общая площадь здания». С одним значением на ячейку
  сравним только итог, его и оставляем; сверка по помещениям — отдельная задача (сопоставление точек).
- Нечисловые значения продукта (назначение помещения) — не числовой параметр, убираем.
- docs.txt — все документы выборки (в том числе те, где ни один метод ничего не нашёл: это TN/FN).
"""

import json
import sys

pool_path, meta_path, objects_arg, out_path, docs_path = sys.argv[1:6]
OBJECT_CODES = {
    "alt": "Алтуфьевское, 79Б",
    "nov": "Новослободская",
    "ex": "Пример нарушений на чертежах",
    "rech": "Речников ул. 7-7",
}
OBJECT_CODES["train"] = "|".join(OBJECT_CODES[k] for k in ("alt", "nov", "ex"))
objects = set()
for code in objects_arg.split(","):
    objects |= set(OBJECT_CODES.get(code, code).split("|"))

docs = []
for line in open(meta_path, encoding="utf-8"):
    r = json.loads(line)
    if r.get("object") in objects:
        docs.append(r["sha256"])
kept = dropped = 0
with open(out_path, "w", encoding="utf-8") as out:
    for line in open(pool_path, encoding="utf-8"):
        r = json.loads(line)
        if r["sha256"] not in set(docs):
            dropped += 1
            continue
        if r["method"] == "product":
            if r["param"] == "M-002" and r.get("rule_key") != "Общая площадь здания":
                dropped += 1
                continue
            try:
                float(r["value"])
            except (TypeError, ValueError):
                dropped += 1
                continue
        out.write(line)
        kept += 1
open(docs_path, "w", encoding="utf-8").write("\n".join(docs) + "\n")
print(f"документов {len(docs)}, строк оставлено {kept}, убрано {dropped}")
