"""Опыт с Sentence-BERT: пул кандидатов числовых параметров по двум методам.

sbert_pool.py <кеш parsed> <версия> <meta.jsonl> <выход pool.jsonl> [--objects obj1,obj2] [--exclude-sha file]

Методы:
- `product` — то, что сегодня извлекает продукт (`extract.api.extractor_for`: свой извлекатель или регулярка матрицы);
- `sbert` — общий путь без регулярок: кандидаты «подпись → число с единицей» со страницы, единица совместима с
  единицей параметра, подпись ранжируется по косинусной близости к названию и якорям параметра (MiniLM).
  В пул идёт лучший кандидат документа по параметру, если близость ≥ 0.5 (порог потом подбирается).

Выход — строка на (документ, параметр, метод): значение, страница, фрагмент, близость. Пул потом размечается.
"""

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

from inspector_ml.extract.api import extractor_for
from inspector_ml.extract.normalize import collapse
from inspector_ml.extract.tables import bands, page_cells
from inspector_ml.matrix import load_params

ap = argparse.ArgumentParser()
ap.add_argument("storage")
ap.add_argument("version")
ap.add_argument("meta")
ap.add_argument("out")
ap.add_argument("--objects", default="")
ap.add_argument("--exclude-sha", default="")
ap.add_argument("--floor", type=float, default=0.6)
ap.add_argument("--top", type=int, default=3)
ap.add_argument("--shard", type=int, default=0)
ap.add_argument("--shards", type=int, default=1)
args = ap.parse_args()

# --- единицы: класс единицы параметра и распознавание единицы у числа в документе
UNIT_CLASS = {
    "м": "len",
    "мм": "len",
    "м²": "area",
    "мм²": "area_mm",
    "м³": "vol",
    "м³/сут": "flow_day",
    "м³/ч": "flow_h",
    "л/с": "flow_ls",
    "кВт": "power",
    "Гкал/ч": "heat",
    "%": "pct",
    "‰": "permille",
    "шт.": "count",
    "ед.": "count",
    "чел.": "count",
    "А (Ампер)": "amp",
    "дни": "days",
    "мин": "min",
    "мин (EI)": "min",
    "тыс. руб.": "money",
    "Вт/(м·С)": "lambda",
    "м²·С/Вт": "r0",
    "кВт·ч/м²": "specific",
}
#: единица после числа (порядок важен: длинные раньше коротких)
UNITS = [
    ("flow_day", r"(?:м\s*[3³]|куб\.?\s*м)\s*/\s*сут\w*"),
    ("flow_h", r"(?:м\s*[3³]|куб\.?\s*м)\s*/\s*ч\w*"),
    ("flow_ls", r"л\s*/\s*с(?:ек)?\b"),
    ("heat", r"Гкал\s*/\s*ч\w*"),
    ("specific", r"кВт\s*[·*.]?\s*ч\s*/\s*м\s*[2²]"),
    ("r0", r"м\s*[2²]\s*[·*.]?\s*°?\s*С\s*/\s*Вт"),
    ("lambda", r"Вт\s*/\s*\(?\s*м\s*[·*.]?\s*°?\s*С"),
    ("area_mm", r"мм\s*[2²]"),
    ("area", r"(?:м\s*[2²]|кв\.?\s*м)(?![а-яё])"),
    ("vol", r"(?:м\s*[3³]|куб\.?\s*м)(?![а-яё/])"),
    ("len_mm", r"мм(?![а-яё²2])"),
    ("len", r"м(?![а-яё²2³3/])"),
    ("power", r"кВт(?![а-яё·*.]?\s*ч)"),
    ("pct", r"%"),
    ("permille", r"‰"),
    ("amp", r"А(?![а-яё])"),
    ("money", r"(?:тыс\.?\s*)?руб\w*"),
    ("min", r"мин\w*"),
    ("days", r"(?:дн\w*|сут\w*|дней)"),
    ("count", r"(?:шт\.?|чел\w*|мест\w*|ед\.)"),
]
UNIT_RE = [(cls, re.compile(r"^\s*" + pat, re.I)) for cls, pat in UNITS]
NUM = re.compile(r"(?<![\w.,/-])(\d{1,3}(?:[  ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(?![\d])")
YEARISH = re.compile(r"^(19|20)\d\d$")


def unit_after(text: str) -> str | None:
    for cls, rx in UNIT_RE:
        if rx.match(text):
            return cls
    return None


def unit_in_label(label: str) -> str | None:
    """Единица в подписи строки: «Площадь застройки, м²», «(кв.м)»."""
    for cls, pat in UNITS:
        if re.search(r"[,(\s]\s*" + pat + r"\s*\)?\s*$", label, re.I) or re.search(r",\s*" + pat, label, re.I):
            return cls
    return None


def compatible(param_cls: str | None, cand_cls: str | None) -> bool:
    if param_cls is None:
        return cand_cls is None
    if param_cls == "len":
        return cand_cls in ("len", "len_mm")
    if param_cls == "count":
        return cand_cls in ("count", None)
    return cand_cls == param_cls


def value_of(raw: str) -> float | None:
    try:
        return float(re.sub(r"[  ]", "", raw).replace(",", "."))
    except ValueError:
        return None


def label_clean(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip(" :—–-=|;,.")
    words = text.split(" ")
    return " ".join(words[-14:])


def candidates(page: dict) -> list[dict]:
    """Кандидаты «подпись → число с единицей» со страницы: текст и строки таблиц."""
    out = []
    for block in page.get("blocks") or []:
        if block.get("type") == "title_block":
            continue
        text = collapse(block.get("text") or "")
        for m in NUM.finditer(text):
            raw = m.group(1)
            if YEARISH.match(raw):
                continue
            cls = unit_after(text[m.end() : m.end() + 16])
            head = text[max(0, m.start() - 160) : m.start()]
            cut = max(head.rfind(". "), head.rfind("; "), head.rfind("\n"))
            head = head[cut + 1 :] if cut >= 0 else head
            label = label_clean(head)
            if cls is None:
                cls = unit_in_label(label)
            if len(label) < 4 or not re.search(r"[а-яё]{3}", label, re.I):
                continue
            out.append(
                {
                    "label": label,
                    "raw": raw,
                    "unit": cls,
                    "bbox": block["bbox"],
                    "how": "text",
                    "snippet": (head + text[m.start() : m.end() + 16])[-220:],
                }
            )
    for row in bands(page_cells(page)):
        words = []
        for cell in row:
            t = cell.text.strip()
            m = re.fullmatch(r"(\d{1,3}(?:[  ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)\s*(\S{0,12})", t)
            if m and not YEARISH.match(m.group(1)):
                label = label_clean(" ".join(words))
                if len(label) >= 4 and re.search(r"[а-яё]{3}", label, re.I):
                    cls = unit_after(m.group(2)) if m.group(2) else None
                    cls = (
                        cls
                        or unit_in_label(label)
                        or next(
                            (
                                unit_after(c.text)
                                for c in row
                                if c is not cell and unit_after(c.text) and len(c.text) <= 10
                            ),
                            None,
                        )
                    )
                    out.append(
                        {
                            "label": label,
                            "raw": m.group(1),
                            "unit": cls,
                            "bbox": cell.bbox,
                            "how": "table",
                            "snippet": " | ".join(c.text for c in row)[:220],
                        }
                    )
            else:
                words.append(t)
    return out


params = {c: p for c, p in load_params().items() if str(getattr(p.data_type, "root", p.data_type)) == "number"}
meta = {}
product_cells: dict[str, set[str]] = {}
for line in open(args.meta, encoding="utf-8"):
    r = json.loads(line)
    meta[r["sha256"]] = (r.get("stage"), r.get("object"), r.get("file"))
    # продукт считаем только там, где замер находимости уже видел значение: остальное — заведомо пусто
    product_cells[r["sha256"]] = set(r.get("found") or {})
exclude = set(open(args.exclude_sha).read().split()) if args.exclude_sha else set()
#: коды объектов латиницей: кириллица в аргументах портится по дороге из Windows в WSL
OBJECT_CODES = {
    "alt": "Алтуфьевское, 79Б",
    "nov": "Новослободская",
    "ex": "Пример нарушений на чертежах",
    "rech": "Речников ул. 7-7",
}
OBJECT_CODES["train"] = "|".join(OBJECT_CODES[k] for k in ("alt", "nov", "ex"))
objects = set()
for code in filter(None, args.objects.split(",")):
    objects |= set(OBJECT_CODES.get(code, code).split("|"))
objects.discard("")

import numpy as np
from sentence_transformers import SentenceTransformer

model = SentenceTransformer(
    os.environ.get("SBERT_MODEL", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"), device="cpu"
)
queries = {}
for code, p in params.items():
    anchors = (
        [a for a in (p.semantic_anchors or "").split("|") if a.strip()]
        if isinstance(p.semantic_anchors, str)
        else list(p.semantic_anchors or [])
    )
    queries[code] = list(dict.fromkeys([p.parameter_name] + anchors))
q_texts = sorted({t for qs in queries.values() for t in qs})
Q = model.encode(q_texts, normalize_embeddings=True, batch_size=64)
q_index = {code: [q_texts.index(t) for t in qs] for code, qs in queries.items()}
param_cls = {code: UNIT_CLASS.get((p.unit or "").strip()) for code, p in params.items()}

paths = sorted(str(p) for p in Path(args.storage, "parsed").glob(f"*/{args.version}.json"))
t0 = time.time()
n_docs = n_cands = 0
emb_cache: dict[str, object] = {}
with open(args.out, "w", encoding="utf-8") as out:
    for index, path in enumerate(paths):
        sha = Path(path).parent.name
        stage, obj, name = meta.get(sha, ("?", "?", "?"))
        if sha in exclude or (objects and obj not in objects) or index % args.shards != args.shard:
            continue
        doc = json.load(open(path, encoding="utf-8"))
        pages = doc.get("pages") or []
        n_docs += 1
        base = {"sha256": sha, "stage": stage, "object": obj, "file": name}
        # метод product
        for code, p in params.items():
            if code not in product_cells.get(sha, set()):
                continue
            for f in extractor_for(code)(p, pages):
                out.write(
                    json.dumps(
                        {
                            **base,
                            "param": code,
                            "method": "product",
                            "value": str(f.value),
                            "raw": f.raw_value,
                            "rule_key": f.rule_key,
                            "page": f.page,
                            "snippet": " ".join(f.snippet.split())[:220],
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
        # метод sbert
        cands = [dict(c, page=pg["page"]) for pg in pages for c in candidates(pg)]
        n_cands += len(cands)
        uniq = list(dict.fromkeys(c["label"] for c in cands if c["label"] not in emb_cache))
        if uniq:
            for text, vec in zip(uniq, model.encode(uniq, normalize_embeddings=True, batch_size=128)):
                emb_cache[text] = vec
        if not cands:
            continue
        sims = np.stack([emb_cache[c["label"]] for c in cands]) @ Q.T  # кандидаты × тексты запросов
        units = [c["unit"] for c in cands]
        for code in params:
            per_param = sims[:, q_index[code]].max(axis=1)
            mask = np.array([compatible(param_cls[code], u) for u in units])
            if not mask.any():
                continue
            scored = np.where(mask, per_param, -1.0)
            # три лучших разных подписи: первая — прогноз метода, остальные — для полноты эталона
            seen_labels: set[str] = set()
            for rank_i in np.argsort(-scored):
                if scored[rank_i] < args.floor or len(seen_labels) >= args.top:
                    break
                c = cands[int(rank_i)]
                if c["label"] in seen_labels:
                    continue
                seen_labels.add(c["label"])
                out.write(
                    json.dumps(
                        {
                            **base,
                            "param": code,
                            "method": "sbert",
                            "rank": len(seen_labels),
                            "value": str(value_of(c["raw"])),
                            "raw": c["raw"],
                            "unit": c["unit"],
                            "score": round(float(scored[rank_i]), 4),
                            "page": c["page"],
                            "label": c["label"],
                            "how": c["how"],
                            "snippet": " ".join(c["snippet"].split())[:220],
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
        if n_docs % 20 == 0:
            print(
                f"{n_docs} док., {n_cands} кандидатов, {len(emb_cache)} подписей, {time.time() - t0:.0f} с", flush=True
            )
print(f"готово: {n_docs} док., {n_cands} кандидатов, {len(emb_cache)} уникальных подписей, {time.time() - t0:.0f} с")
