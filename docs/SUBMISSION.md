# Комплект сдачи: кейс 10, «Продукт»

Подача — **29.09.2026, 23:59 МСК**: репозиторий и стенд; с 30.09 — техническая проверка. Организаторы скачивают
репозиторий и разворачивают систему по README одной командой, стенд — для проверки без развёртывания. Ниже — каждое
требование организаторов к сдаче и где оно закрыто.

## Ссылки

| Что | Где |
|---|---|
| Репозиторий сдачи | https://github.com/mixvadimyt-clon/425c044b3e1dfbf2bc140402005ee151073fa592cbc096a8eaf626b1c3ee7a3b |
| Публичный стенд | **https://lct.bakost.com** — подробнее в [README](../README.md#публичный-стенд); на время экспертизы вход открыт — кнопки ролей на странице входа, пароль не нужен (просьба организаторов); пароль для входа по форме — в PDF «Пользовательский путь», раздел 1.4 |
| Демо-видео пользовательского пути | https://disk.yandex.ru/i/qywq9lVMSfDNnw (2 мин 12 с) |
| Архив образов для закрытого контура | не передаётся: образы собираются из репозитория (`./start.sh`); для контура без интернета — `./scripts/images.sh save` и `load` с контрольной суммой |

## Требования организаторов → где у нас

| Требование | Где |
|---|---|
| Одна документированная команда запуска | `./start.sh` — [README](../README.md#вся-система-одной-командой--проверяющему): сам создаёт секреты, выбирает вариант ML (GPU или CPU), собирает, поднимает, проверяет вход |
| Запуск без интернета, внешние LLM/OCR/VLM API запрещены | образы из архива: `./scripts/images.sh load …` → `./start.sh --no-build --gpu`; проверка изоляции — [`scripts/stand-offline-check.sh`](../scripts/stand-offline-check.sh) (внутренняя сеть Docker, обращений наружу нет); нелокальный адрес языковой модели запрещён в коде |
| Dockerfile / образы и docker-compose | [`services/api/Dockerfile`](../services/api/Dockerfile), [`infra/docker/`](../infra/docker/) (`ml`, `ml-gpu`, `web`), [`services/rin-mock/Dockerfile`](../services/rin-mock/Dockerfile); [`docker-compose.app.yml`](../docker-compose.app.yml) и надстройка [`docker-compose.gpu.yml`](../docker-compose.gpu.yml) |
| Фиксированные версии зависимостей, lock-файлы | `services/api/package-lock.json`, `services/web/package-lock.json`, `services/rin-mock/package-lock.json`, `services/ml/uv.lock`; базовые образы и модели — с закреплёнными версиями |
| Локальные веса моделей | внутри образа ML, скачиваются при сборке: PaddleOCR PP-OCRv5 mobile (детектор и распознаватель кириллицы) и Sentence-BERT `paraphrase-multilingual-MiniLM-L12-v2`; в работе `HF_HUB_OFFLINE=1`, сеть не нужна |
| Перечень моделей, версии, лицензии | [docs/domain/models.md](domain/models.md) и [ADR-0006](adr/0006-ml-stack.md): PaddleOCR — Apache-2.0; Sentence-BERT MiniLM-L12-v2 — Apache-2.0, запасной путь извлечения числовых параметров, флаг `SBERT_ENABLED`; Qwen3-8B — Apache-2.0, выключена по умолчанию; скорер кандидатов — наш |
| Healthcheck | `GET /health` у api и ml, `HEALTHCHECK` в образах api, ml и мока «РиН»; `./start.sh check` |
| Миграции и инициализация данных | api при старте применяет миграции SQLite и сид (роли, матрица из 132 параметров); `./start.sh` сверяет матрицу в базе с `data/matrix/params.csv` |
| Секретов в репозитории нет | `.env.stand` создаётся на месте ([`infra/stand/make-env.sh`](../infra/stand/make-env.sh)), шаблоны — `.env.example`, `infra/stand/stand.env.example` |
| OpenAPI | [`contracts/openapi/inspector-api.v1.yaml`](../contracts/openapi/inspector-api.v1.yaml) — REST сервиса; [`contracts/openapi/rin-external.v1.yaml`](../contracts/openapi/rin-external.v1.yaml) — обмен с ИАИС «РиН» (мок); [`contracts/events/ml-events.v1.yaml`](../contracts/events/ml-events.v1.yaml) — api ↔ ML; собранные — `contracts/dist/` |
| Пример выходного JSON | [docs/examples](examples/README.md): `submission.sample.json` по `submission_schema.json` организаторов и `gold.sample.json` по схеме GOLD |
| Форматы: PDF и DOCX обязательны, XML по контракту | PDF — текстовый слой и OCR; DOCX и XML — свой разбор ([ml.md, «DOCX и XML»](services/ml.md)) |
| Функции High | загрузка и разбор, сравнение и протокол, верификация инспектором, контур дообучения (GOLD, версии набора, модели), свободный поиск как `SUSPICION`, обработка ошибок — [путь пользователя](guides/user-journey.md) |
| «3 клика», синхронные панели ПД/РД/ИД, правка доказательств, разделение кандидата | экран верификации — [путь пользователя](guides/user-journey.md); `POST /findings/{id}/split`, `POST /findings/{id}/evidence` (новая версия, исходное не перезаписывается) |
| Метрики | [models.md, «Качество»](domain/models.md#6-качество-как-меряем-и-что-получили): контрольный комплект — 132/132, находимость на отложенных объектах, OCR Character Accuracy; опыт с Sentence-BERT — [data/samples/sbert-eval](../data/samples/sbert-eval/README.md); все замеры — в MLflow |
| Автотесты | `./scripts/check-local.sh` — те же проверки, что CI (GitHub Actions на паузе: кончились минуты, вернём после экспертизы) |
| Отклонения от рекомендуемого стека | по умолчанию SQLite, файлы на диске и HTTP между api и ML — чтобы всё поднималось одной командой; PostgreSQL, Redis, RabbitMQ, MinIO — готовые адаптеры полного контура (`docker compose up -d`), [ADR-0005](adr/0005-local-first.md) |

## Производительность: честно

Нормативы §11 организаторы меряют на GPU: основной вариант образа — GPU. Замер в одном
образе: страница скана — 2,4 с на видеокарте против 34,3 с на процессоре; 500 страниц на RTX 3050 — около
10 минут ([upload-to-result.md](guides/upload-to-result.md)). На H100 запас больше. Вариант CPU — резервный,
на нём работает наш публичный стенд с кешем разбора, предрасчитанным на GPU ([ADR-0007](adr/0007-stand-cpu-precomputed-cache.md)).
