# services/ml — ML-конвейер (Python 3.12)

**Дизайн:** [docs/services/ml.md](../../docs/services/ml.md)

Сервис парсит ПД, РД и ИД, извлекает значения параметров матрицы с доказательствами
(страница + bbox) и отдаёт результат в api. Запускается локально, без Docker.

## Быстрый старт

```bash
cd services/ml
uv sync                 # базовые зависимости + dev (PyMuPDF, OpenCV, FastAPI, ruff, pytest)
uv run gen              # модели контрактов из contracts/dist/ml-events.v1.json (в git не идут)
uv run pytest
uv run inspector-ml serve
```

Проверка:

```bash
curl http://localhost:8000/health
```

```json
{ "status": "ok", "version": "0.1.0", "capabilities": { "pdf": true, "cv": true, "ocr": false, "docling": false, "embeddings": false, "llm": false } }
```

Нет `uv` — `pip install uv`, дальше `uv python install 3.12` (версия закреплена в `.python-version`).

## Команды

| Команда | Что делает |
|---|---|
| `uv run inspector-ml serve` | HTTP-сервис: `GET /health`, `GET /metrics`, `POST /v1/jobs`, `GET /v1/jobs/{id}` |
| `uv run inspector-ml info` | Печатает настройки и доступные компоненты |
| `uv run inspector-ml parse <pdf>` | Разбор файла: сводка, `--json` — весь `ParsedDocument`, `--out` — в файл |
| `uv run inspector-ml compare <папка>` | Сравнение комплекта без api |
| `uv run inspector-ml dataset scan <папка>` | Сводка по папке с PDF: страницы, объём OCR, повороты, марки |
| `uv run inspector-ml dataset calibrate <корень dataset>` | Сверка классификатора страниц с разметкой `needs_ocr` |
| `uv run inspector-ml dataset metadata <корень dataset>` | Сверка стадии, марки и шифра с разметкой |
| `uv run inspector-ml parse <pdf> --ocr` | Разбор с распознаванием страниц без текстового слоя (`--force-ocr`, `--pages N`) |
| `uv run inspector-ml eval ocr <pdf>` | Character Accuracy, CER и WER: OCR сравнивается с текстовым слоем того же документа |
| `uv run inspector-ml eval extract <корень dataset>` | Сверка извлечения M-002 и M-055 с эталоном организаторов |
| `uv run inspector-ml cache warm <папка> --ocr` | Предрасчёт разбора для стенда (продолжается после обрыва) |
| `uv run inspector-ml cache export / import <архив>` | Перенос кеша разбора на стенд, загрузка идемпотентна |
| `uv run inspector-ml cache verify <папка> --sample N` | Сверка кеша с исходными PDF: структура и повторный разбор |
| `uv run inspector-ml cache stats` | Что уже разобрано, с разбивкой по версиям разбора и растрам |
| `uv run inspector-ml cache renders <папка> --dpi 150` | Прогрев кеша растров для CV (на стенд он не едет) |
| `uv run inspector-ml cache renders --clear [sha256]` | Очистить кеш растров — один документ или всё |
| `uv run inspector-ml eval` | Офлайн-оценка по §14 |
| `uv run gen` | Кодогенерация моделей из контрактов |
| `uv run ruff check .` / `uv run pytest` | Линтер и тесты (их же гоняет CI) |

## Необязательные компоненты

Базовая установка работает без тяжёлых зависимостей — этого хватает для PDF с текстовым слоем.
Остальное ставится по мере надобности и отражается в `capabilities` ответа `/health`:

```bash
uv sync --extra ocr          # PaddleOCR — сканы, около 900 МБ вместе с paddlepaddle
uv sync --extra layout       # Docling — макет и таблицы
uv sync --extra embeddings   # sentence-transformers — сопоставление сущностей
uv sync --extra llm          # клиент к локальному Qwen (Ollama или vLLM)
```

Облачные LLM-API запрещены: модели только локальные, с открытыми весами ([ADR-0006](../../docs/adr/0006-ml-stack.md)).

## Настройки

Читаются из окружения и из `.env` в корне репозитория (шаблон — [.env.example](../../.env.example)).
Относительные пути считаются от корня репозитория, поэтому api и ml видят одни и те же файлы.

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `ML_HOST`, `ML_PORT` | `127.0.0.1`, `8000` | Где слушает сервис |
| `API_URL` | `http://localhost:3000` | Адрес api |
| `INTERNAL_TOKEN` | пусто | Если задан, ml возвращает его в заголовке `x-internal-token` при callback |
| `STORAGE_DIR` | `var/storage` | Общая с api папка: `raw/{sha256}`, `parsed/{sha256}/{parser_version}.json` |
| `CACHE_DIR` | `var/cache` | Кеш парсинга по `sha256 + parser_version` |
| `PARSER_VERSION` | `0.1.0` | Поднимается при любом изменении парсинга, меняющем результат |
| `MODEL_VERSION`, `DATASET_VERSION` | `rules-0.1.0`, `none` | Попадают в результаты и доказательства |
| `ML_WORKERS`, `ML_JOB_TIMEOUT_S` | `2`, `600` | Размер пула и таймаут задачи |
| `ML_EXECUTOR` | `process` | `process` — разбор в отдельных процессах, `thread` — в потоках (тесты, отладка) |
| `PARSE_READ_LAYERS` | `false` | Читать имена слоёв САПР (OCG) для текстовых блоков: полезно на чертежах, разбор дорожает примерно на треть |
| `OCR_ENGINE`, `OCR_DPI` | `paddle`, `300` | Движок распознавания (`paddle`, `tesseract`, `none`) и разрешение рендера |
| `OCR_MAX_PX`, `OCR_TILE_PX`, `OCR_OVERLAP_PX` | `4000`, `1600`, `160` | Ограничение рендера и нарезка на плитки: лист A0 при 300 dpi — это 14000 пикселей |
| `OCR_MIN_CONFIDENCE`, `OCR_MAX_PAGES` | `0.5`, `0` | Порог уверенности строки и бюджет страниц на документ (`0` — без ограничения) |
| `OCR_PADDLE_DET_MODEL` | `PP-OCRv5_mobile_det` | Детектор PaddleOCR: серверный роняет процесс на paddlepaddle 3.3 под Windows |
| `OCR_DEVICE` | `auto` | `auto` / `cpu` / `gpu`. С `paddlepaddle-gpu` распознавание примерно в 50 раз быстрее |
| `LLM_ENABLED`, `LLM_BASE_URL`, `LLM_MODEL` | `false`, `http://localhost:11434/v1`, `qwen3:8b` | Локальный Qwen |
| `LOG_LEVEL` | `info` | Уровень JSON-логов |

## Замеры и прогоны в WSL

OCR на CPU медленный (около 60 с на страницу), поэтому метрики и большие прогоны удобнее гонять
в WSL с видеокартой — там та же страница распознаётся за 1—3 секунды.

```bash
# внутри WSL (Ubuntu), окружение создаётся ВНЕ репозитория, иначе uv sync затрёт windows-venv
export UV_PROJECT_ENVIRONMENT=~/.venvs/inspector-ml
cd /mnt/c/.../services/ml
uv sync --extra ocr
uv run pytest

# видеокарта (проверено на RTX 3050, CUDA 12.6)
uv pip install --python $UV_PROJECT_ENVIRONMENT/bin/python paddlepaddle-gpu==3.3.1   -i https://www.paddlepaddle.org.cn/packages/stable/cu126/
uv run --no-sync inspector-ml eval ocr "<pdf>" --pages 4 --dpi 150
```

`paddlepaddle-gpu` в extras репозитория нет намеренно: колесо зависит от версии CUDA и ставится
вручную под конкретную машину. Устройство выбирается переменной `OCR_DEVICE`.

## Кеш разбора и стенд без GPU

Стенд работает на двух ядрах без видеокарты ([ADR-0007](../../docs/adr/0007-stand-cpu-precomputed-cache.md)),
а OCR на процессоре занимает около минуты на страницу. Поэтому тяжёлый разбор считается заранее
на видеокарте и переносится на стенд архивом кеша.

Это **кеш по содержимому** (`sha256` файла + `PARSER_VERSION`), а не заготовленные ответы: в
архиве лежит ровно то, что стенд посчитал бы сам, только медленнее. `force_reparse` в запросе
считает заново в любом случае.

```bash
# 1. предрасчёт на машине с видеокартой (идёт часами, продолжается после обрыва)
OCR_DEVICE=auto STORAGE_DIR=~/ml-precompute/storage CACHE_DIR=~/ml-precompute/cache \
  uv run --no-sync inspector-ml cache warm "<корень dataset>" --ocr

# 2. что уже разобрано
uv run inspector-ml cache stats

# 3. архив для стенда (только замороженная версия разбора)
uv run inspector-ml cache export ~/parsed-cache.tar.gz

# 4. на стенде — загрузка, идемпотентно
uv run inspector-ml cache import /srv/parsed-cache.tar.gz

# 5. сверка с исходными PDF: все записи по структуре, N из них — повторным разбором
uv run inspector-ml cache verify "<корень dataset>" --sample 8
```

`cache verify` отвечает на вопрос «перенос целый и разбор тот же?»: для каждого PDF считается
`sha256`, находится своя запись кеша и сверяется число страниц; с `--sample` несколько документов
разбираются заново и сравниваются с кешем по слепку (страницы, источники, число блоков и таблиц,
хеш всего текста). Ненулевой код возврата означает расхождение — команду можно ставить в проверку
после загрузки архива на стенд.

**Замеры на RTX 3050** (WSL, PaddleOCR PP-OCRv5 mobile, `OCR_DEVICE=auto`) — по итогам полного
предрасчёта корпуса 19–20.09:

| Что | Значение |
|---|---|
| Документов / страниц | **365 / 26 026**, из них **11 719 распознано** |
| Время | **около 6.5 часов** машинного времени |
| Средний темп | **2.15 с** на распознанную страницу |
| Страница с текстовым слоем | 0.027 с |
| Разобранный JSON | 494 МБ — 19 КБ на страницу |
| Архив | **86 МБ** — сжатие в 5.7 раза, 3.3 КБ на страницу |
| Ошибок разбора | **0** |

Темп плавает от размера листа и от нагрева: на первых файлах было 1.5–2.3 с на страницу, к концу
прогона — 3.6 с, потому что видеокарта ноутбука сбрасывает частоту по температуре (`nvidia-smi`
показывает `SW Thermal Slowdown`, 2100 → 1462 МГц). На стационарной машине или на H200 организаторов
разброса не будет.

Сверка перенесённого кеша с исходными PDF (`cache verify --sample 3`): **365 из 365** записей нашли
свой файл по `sha256`, расхождений по числу страниц нет, три документа разобраны заново и совпали
с кешем по слепку.

`PARSER_VERSION` — ключ кеша. Поднимается при любом изменении разбора, которое меняет результат;
около 26.09 замораживается, после чего менять разбор можно только вместе с повторным предрасчётом.

### Веса OCR в образе

```bash
uv run --extra ocr python scripts/fetch_ocr_models.py
```

Скрипт тянет закреплённые модели (`PP-OCRv5_mobile_det`, `eslav_PP-OCRv5_mobile_rec`) и печатает
каталог кеша весов — его и нужно скопировать в образ, чтобы в работе не требовался интернет.
По умолчанию это `~/.paddlex`, переопределяется `PADDLE_PDX_CACHE_HOME`.

### Зависимости для GPU-варианта образа

Проверено на RTX 3050 (WSL Ubuntu, драйвер 610.74):

| Что | Значение |
|---|---|
| Колесо | `paddlepaddle-gpu==3.3.1` |
| Индекс | `https://www.paddlepaddle.org.cn/packages/stable/cu126/` |
| CUDA | 12.6 (сборка `paddle.version.cuda()`) |
| cuDNN | 9.5.1 |
| PaddleOCR | 3.7.0 (extra `ocr`, ставится обычным `uv sync --extra ocr`) |
| Устройство | `OCR_DEVICE=auto` — движок сам возьмёт видеокарту |

В образе должен стоять **только** `paddlepaddle-gpu`: если рядом окажется обычный
`paddlepaddle`, победит тот, который импортируется, и устройство будет выбрано непредсказуемо.
CPU-вариант образа ставит `paddlepaddle` из extra `ocr` и ничего больше не требует.

## Связь с api

api отправляет `POST {ML_URL}/v1/jobs` с `Envelope` и `reply_to`, ml по завершении делает
`POST {reply_to}` с результатом. Чтобы api слал задачи сюда, а не в заглушку, в `.env` нужно
`ML_TRANSPORT=http`. Контракт — [contracts/events/ml-events.v1.yaml](../../contracts/events/ml-events.v1.yaml).

Что гарантирует очередь: повтор задачи с тем же `message_id` не выполняется дважды, результат
доступен в `GET /v1/jobs/{message_id}` даже если callback не дошёл, повторы доставки идут через
1, 5 и 15 секунд. Разбор кешируется по `sha256 + PARSER_VERSION` — тот же файл во второй проверке
отвечает мгновенно с `from_cache = true`. Коды ошибок и подробности —
[docs/services/ml.md](../../docs/services/ml.md#что-уже-работает-ml-1).

## Структура

```
src/inspector_ml/
├── config.py         # настройки (pydantic-settings), корень репозитория, пути хранилища
├── logging.py        # structlog: единый JSON-поток, request_id
├── capabilities.py   # какие необязательные компоненты установлены
├── metrics.py        # метрики Prometheus (HTTP и задачи)
├── api/              # FastAPI: /health, /metrics, /v1/jobs
├── jobs/             # runner (очередь и пул), handlers (разбор и сравнение), callback
├── storage/          # files (STORAGE_DIR, длинные пути), cache (sha256 + PARSER_VERSION)
├── geometry.py       # нормализация bbox — общая для разбора, OCR и CV
├── ingest/           # pdf (PyMuPDF): страницы, блоки, штамп, слои
├── ocr/              # PaddleOCR и Tesseract, рендер и нарезка страницы на плитки
├── eval/             # офлайн-оценка (§14): OCR, извлечение, находимость, CV
├── quality/          # классификатор страниц: text / scan / drawing, OK / LOW_QUALITY / ABSTAIN
├── layout/           # основная надпись (штамп), строки и таблицы
├── metadata/         # шифр, стадия, марка, редакция, статусы утверждения и подписи
├── corpus/           # разметка организаторов, сверка разбора, починка имён файлов
├── extract/          # извлечение значений и граница с движком сравнения
├── compare/          # движок сравнения
├── cv/               # render (кеш растров renders/{sha256}/{dpi}/{page}.png)
├── contracts/        # СГЕНЕРИРОВАНО (uv run gen), в git только __init__.py
├── tools/codegen.py  # сама кодогенерация
└── cli.py            # inspector-ml serve | parse | compare | eval | info
```

Дальше в `cv/` добавятся пары листов и визуальный diff —
полная карта в [docs/services/ml.md](../../docs/services/ml.md).
