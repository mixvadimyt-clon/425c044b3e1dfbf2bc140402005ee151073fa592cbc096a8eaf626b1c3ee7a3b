# syntax=docker/dockerfile:1
# ML-сервис «Продукт», вариант CPU — стенд и ноутбук (ADR-0007). Контекст — корень репозитория:
#   docker build -f infra/docker/ml.Dockerfile -t inspector-ml .
# Исходники — services/ml, здесь только упаковка. Вариант для GPU — ml-gpu.Dockerfile.
FROM python:3.12-slim-bookworm

# embeddings — Sentence-BERT, запасной путь извлечения числовых параметров (флаг SBERT_ENABLED,
# по умолчанию выключен): torch для процессора и веса MiniLM, около +1,45 ГБ. Без него — ML_EXTRAS=ocr.
ARG EXTRAS="ocr embeddings"
# модель Sentence-BERT: веса кладутся в образ при сборке, в работе сеть не нужна (HF_HUB_OFFLINE ниже)
ARG EMBEDDING_MODEL=sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
# 1 — скачать веса OCR при сборке, чтобы в работе интернет был не нужен
ARG OCR_WARMUP=1

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/services/ml/.venv \
    HF_HOME=/opt/hf \
    REPO_ROOT=/app \
    PADDLE_PDX_CACHE_HOME=/opt/paddlex \
    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True \
    PADDLE_PDX_MODEL_SOURCE=huggingface

# OpenCV и Paddle: libGL, glib, OpenMP
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libgomp1 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1000 --create-home app
COPY --from=ghcr.io/astral-sh/uv:0.12 /uv /usr/local/bin/uv

WORKDIR /app/services/ml
COPY services/ml/pyproject.toml services/ml/uv.lock services/ml/README.md ./
# Кеш uv — монтированием BuildKit, а не в слое образа: иначе скачанные колёса оставались внутри
# (/root/.cache/uv: 1,4 ГБ в образе CPU и 7,6 ГБ в образе GPU, замер 26.09) и ехали в архив для
# закрытого контура. Заодно повторная сборка не качает пакеты заново. UV_LINK_MODE=copy выше этого требует.
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-install-project --group dev $(for e in $EXTRAS; do printf -- '--extra %s ' "$e"; done)
COPY contracts/dist /app/contracts/dist
COPY services/ml/src ./src
# Один OpenCV в окружении. paddlex требует opencv-contrib-python, наш код —
# opencv-python-headless, и оба пишут в один каталог cv2: какие файлы победят, зависело от порядка записи.
# На одной машине образ собирался, на другой прогрев весов падал с «partially initialized module 'cv2'».
# Если есть contrib (extra ocr), оставляем только его — той версии, что в uv.lock, начисто; он надмножество
# headless. Проверка import cv2 в конце — чтобы смешанный каталог ронял сборку здесь, а не при прогреве.
# модели сообщений из контракта (datamodel-code-generator — из группы dev), затем dev-пакеты удаляются
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --group dev $(for e in $EXTRAS; do printf -- '--extra %s ' "$e"; done) \
 && uv run --no-sync gen \
 && uv sync --frozen --no-dev $(for e in $EXTRAS; do printf -- '--extra %s ' "$e"; done) \
 && contrib="$(.venv/bin/python -c 'import importlib.metadata as m; print(m.version("opencv-contrib-python"))' 2>/dev/null || true)" \
 && if [ -n "$contrib" ]; then \
      uv pip uninstall --python .venv/bin/python opencv-python-headless opencv-python opencv-contrib-python \
      && uv pip install --python .venv/bin/python --no-deps "opencv-contrib-python==$contrib"; \
    fi \
 && .venv/bin/python -c "import cv2; cv2.ORB_create(); print('OpenCV', cv2.__version__)"

# PADDLE_PDX_* выше по файлу, а не в ENV у самого конца, и это важно: PaddleOCR выбирает
# источник весов сам — HEAD-запрос к HuggingFace, AIStudio, ModelScope и BOS с таймаутом
# в одну секунду, кто ответил первым. Из контейнера на рабочей станции HuggingFace отвечает за 4.8 с,
# выбор падал на китайский CDN и сборка обрывалась по таймауту. В CI при этом зелено —
# то есть образ не пересобирался бы на другой машине или на стенде. Отключаем выбор.
# веса OCR (PP-OCRv5 mobile: детектор и кириллическое распознавание) — внутрь образа
RUN mkdir -p /opt/paddlex \
 && if [ "$OCR_WARMUP" = "1" ] && echo " $EXTRAS " | grep -q " ocr "; then \
      .venv/bin/python -c "from inspector_ml.ocr.paddle import PaddleEngine; PaddleEngine(device='cpu')._model(); print('веса OCR загружены')"; \
    fi \
 && if echo " $EXTRAS " | grep -q " embeddings "; then \
      .venv/bin/python -c "from sentence_transformers import SentenceTransformer as S; S('$EMBEDDING_MODEL', device='cpu'); print('веса Sentence-BERT загружены')"; \
    fi \
 && mkdir -p /data/storage /data/cache /opt/hf \
 && chown -R app:app /opt/paddlex /opt/hf /data

ENV PATH=/app/services/ml/.venv/bin:$PATH \
    ML_HOST=0.0.0.0 \
    ML_PORT=8000 \
    STORAGE_DIR=/data/storage \
    CACHE_DIR=/data/cache \
    OCR_DEVICE=cpu \
    EMBEDDING_MODEL=${EMBEDDING_MODEL} \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1
USER app
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2).status == 200 else 1)"
CMD ["inspector-ml", "serve"]
