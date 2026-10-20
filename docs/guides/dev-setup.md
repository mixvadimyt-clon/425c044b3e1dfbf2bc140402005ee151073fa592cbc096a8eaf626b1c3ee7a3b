# Локальный запуск (без Docker)

Всё работает на обычном ноутбуке: Docker, облако и серверы БД не нужны ([ADR-0005](../adr/0005-local-first.md)).

## Требования

| Инструмент | Версия | Для чего |
|---|---|---|
| Git | любая свежая | всем |
| Node.js | **≥ 22.13** (`nvm install 22`) | api, web, `contracts/` |
| Python | **3.12** через `uv` (`brew install uv` или `pipx install uv`) | ml |
| Ollama | опционально, для Qwen (`brew install ollama`, `ollama pull qwen3:8b`) | ml, при `LLM_ENABLED=true` |

## Быстрый старт

```bash
git clone https://github.com/mixvadimyt-clon/425c044b3e1dfbf2bc140402005ee151073fa592cbc096a8eaf626b1c3ee7a3b.git inspector
cd inspector
cp .env.example .env
./scripts/start-local.sh
```

Скрипт поднимает то, что уже есть в репозитории:

- api — всегда, на http://localhost:3000;
- web — если есть `services/web`, на http://localhost:5173;
- ml — если `ML_TRANSPORT=http` и есть `services/ml`, на http://localhost:8000.

Логины (dev): `inspector/inspector`, `supervisor/supervisor`, `admin/admin`, `ml/ml`.

Локальные данные лежат в `var/` (в `.gitignore`):

- `var/inspector.sqlite` — БД;
- `var/storage/` — файлы;
- `var/cache/` — кеш ML.

Сброс данных: `cd services/api && npm run db:reset`.

## Режимы ML

| `ML_TRANSPORT` | Что происходит | Кому удобно |
|---|---|---|
| `stub` (по умолчанию) | api сам отдаёт правдоподобные результаты для M-001, M-002 и M-055 с пометкой «ML-заглушка» | фронтенд, демо интерфейса |
| `http` | api отправляет задачи в `services/ml` (`POST /v1/jobs`), результаты приходят на `/internal/ml/results` | ML, сквозная проверка |

## Сервисы по отдельности

```bash
# api
cd services/api && npm ci && npm run gen && npm run dev

# ml
cd services/ml && uv sync && uv run inspector-ml serve

# web
cd services/web && npm ci && npm run gen && npm run dev

# мок API без бэкенда (Prism, порт 4010)
cd contracts && npm ci && npm run mock
```

## Импорт большого комплекта (без лимитов интерфейса)

Лимиты 50/200 МБ действуют только при загрузке через интерфейс. Большие комплекты импортируются на сервере из папки `IMPORT_ROOT` (по умолчанию `dataset/`); api при этом должен быть запущен:

```bash
cd services/api
npm run import:dir -- --list                                   # какие папки доступны
npm run import:dir -- --path "Алтуфьевское, 79Б" --external-id ALT-79B
npm run import:dir -- --path "..." --registry реестр.xlsx       # реестр файлов внутри папки (иначе ищется сам)
npm run import:dir -- --path "..." --manifest manifest.json    # реестр JSON (UploadManifest) с диска
```

Испорченные имена файлов и папок исправляются автоматически, стадия берётся из папок «Проектная / Рабочая / Исполнительная документация».

## Датасет

- Полный набор — 144 ГБ, целиком не скачиваем. Выгрузка организаторов лежит на сетевой шаре `\<сервер>\Datasets` (в WSL — `/mnt/datasets`, строка в `/etc/fstab`: `\<сервер>\Datasets /mnt/datasets drvfs defaults,uid=1000,gid=1000,metadata 0 0`). Путь нигде не зашит, инструменты принимают его аргументом. В репозитории датасета нет и быть не должно.
- **Из Linux шара читается не вся.** Предел длины одного элемента пути там 255 байт, а в выгрузке есть каталог на 287 байт: `scandir` родительской папки обрывается с `EIO`, и из WSL видно 324 PDF вместо 366 (пропадает `Пример нарушений на чертежах/ПД` целиком). Инструменты ML это переживают — пропускают непрочитанный каталог с предупреждением, — но для полного прогона корпус копируют с Windows в файловую систему WSL. **Разбор прямо по сети медленнее в 700 раз** (замер на скане 507 страниц: 1.6 с локально против 19.8 мин с шары), поэтому многочасовые прогоны по сети не гоняем. На стенде этого нет: api хранит файлы как `raw/{sha256}`, короткими путями.
- Имена файлов в выборке испорчены кодировкой при распаковке. Как их прочитать — в [services/ml.md](../services/ml.md#датасет).
- Маленькие тестовые PDF (до 1 МБ) кладите в `services/ml/tests/fixtures/`.
- Матрица — `data/matrix/params.csv` (132 параметра из Приложения 1 + наши правила из `overrides.csv`). Пересборка: `uv run --with openpyxl python data/matrix/build_params.py`, затем `npm run db:reset` в `services/api`.
- Реестр файлов комплекта — [domain/registry.md](../domain/registry.md).

## Полный контур из ТЗ (опционально)

`docker-compose.yml` поднимает PostgreSQL, Redis, RabbitMQ, MinIO, ClamAV, Prometheus и Grafana. Само приложение в Docker (сдача, стенд) — `docker-compose.app.yml`, см. [deploy.md](deploy.md). Для разработки и демо ни то ни другое не нужно:

```bash
docker compose up -d
docker compose --profile elk up -d    # ELK, ~4 ГБ RAM
```
