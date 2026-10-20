"""Веса моделей ML отдельным слоем образа — до копирования кода ML.

Зачем. Раньше веса качал прогрев после `COPY services/ml/src`, и любая правка кода ML перекачивала их заново
(Sentence-BERT ~460 МБ). Со стенда HuggingFace то отдаёт ~1 МБ/с, то молча висит часами (17–18.10 сборка трижды
повисала). Здесь слой зависит только от `uv.lock` и этого файла: правка кода берёт его из кеша слоёв Docker.
Прогрев после копирования кода сначала идёт без сети, по этому кешу.

Зависшее соединение обрывает таймаут (`HF_HUB_DOWNLOAD_TIMEOUT` в Dockerfile), неудача — повтор с паузой.

Модели OCR кладутся прямо в каталог моделей PaddleX (`$PADDLE_PDX_CACHE_HOME/official_models/<имя>`), а не в кеш
HuggingFace: PaddleX ищет их только там. Не нашёл — качает сам и при сбое HuggingFace уходит на AI Studio, где сборка
со стенда висит часами (так было 17–18.10).

Модели OCR повторены из `inspector_ml/ocr/paddle.py` (DET_MODEL, REC_MODEL): кода ML в этом слое ещё нет. Разойдутся —
прогрев не найдёт их без сети и докачает сам, сборка не упадёт.

    python ml-weights.py            # EXTRAS, OCR_WARMUP, EMBEDDING_MODEL — из окружения сборки (ARG)
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

OCR_REPOS = ("PaddlePaddle/PP-OCRv5_mobile_det", "PaddlePaddle/eslav_PP-OCRv5_mobile_rec")
TRIES = 4


def retry(what: str, fn) -> None:
    for attempt in range(1, TRIES + 1):
        started = time.monotonic()
        try:
            fn()
        except Exception as e:  # сеть, таймаут, обрыв — пробуем ещё
            print(f"{what}: попытка {attempt} из {TRIES} не удалась за {time.monotonic() - started:.0f} с: {e!r}", flush=True)
            if attempt == TRIES:
                raise
            time.sleep(15 * attempt)
        else:
            print(f"{what}: готово за {time.monotonic() - started:.0f} с", flush=True)
            return


def main() -> int:
    extras = os.environ.get("EXTRAS", "").split()
    if "ocr" in extras and os.environ.get("OCR_WARMUP", "1") == "1":
        from huggingface_hub import snapshot_download

        for repo in OCR_REPOS:
            target = Path(os.environ["PADDLE_PDX_CACHE_HOME"]) / "official_models" / repo.split("/")[1]
            retry(repo, lambda repo=repo, target=target: snapshot_download(repo, local_dir=target))
    if "embeddings" in extras:
        from sentence_transformers import SentenceTransformer

        model = os.environ["EMBEDDING_MODEL"]
        # загрузка самой моделью, а не snapshot_download: так качаются только нужные ей файлы, без ONNX и TF-вариантов
        retry(model, lambda: SentenceTransformer(model, device="cpu"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
