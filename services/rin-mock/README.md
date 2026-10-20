# services/rin-mock — мок внешней ИС надзора (ИАИС «РиН»)

Настоящего API внешней ИС нет, поэтому обмен проверяется на моке. Мок реализует контракт [contracts/openapi/rin-external.v1.yaml](../../contracts/openapi/rin-external.v1.yaml) в обе стороны:

- **документы → Инспектор** (REQ-INT-06): отдаёт пакеты документов, api забирает их сам (`RIN_POLL_INTERVAL_S`) или по кнопке;
- **результаты → внешняя ИС** (REQ-INT-01…05, 07): принимает результат проверки после финализации, выдаёт квитанцию и заводит предписание в статусе `ISSUED`, если есть подтверждённые нарушения.

Node.js 22 без зависимостей (`node:http`). Название системы — `RIN_SYSTEM_NAME`.

## Запуск

```bash
# в .env: RIN_URL=http://localhost:4020 — тогда ./scripts/start-local.sh поднимет мок вместе с api
cd services/rin-mock
npm start            # http://localhost:4020
npm test             # тесты мока; api проверяет обмен с ним в services/api/test/integration.test.ts
```

Токен и секрет подписи — те же переменные, что у api: `RIN_TOKEN`, `RIN_SECRET` из общего `.env`.

| Переменная | По умолчанию | Что |
|---|---|---|
| `RIN_MOCK_PORT`, `RIN_MOCK_HOST` | `4020`, `127.0.0.1` | где слушать |
| `RIN_MOCK_PACKAGES_DIR` | `var/rin-mock/packages` | пакеты документов |
| `RIN_MOCK_RESULTS_DIR` | `var/rin-mock/results` | принятые результаты (JSON на квитанцию) |
| `RIN_MOCK_FAIL` | — | сбои с самого старта: `error:2` — первые две отправки получат 503 |

## Пакеты документов

Пакет — подпапка `RIN_MOCK_PACKAGES_DIR`: файлы (в любых подпапках), реестр в корне (`registry.csv`, `реестр*.xlsx`, `document_manifest.jsonl`…) и `package.meta.json`:

```json
{ "package_id": "ALT79B-2026-09-19", "title": "ПД и РД АР", "created_at": "2026-09-19T09:00:00Z",
  "object": { "object_id": "ALT79B", "name": "ЖК «Алтуфьевское ш., 79Б»", "address": "Москва, Алтуфьевское ш., 79Б" } }
```

`object.object_id` — идентификатор объекта во внешней ИС: у Инспектора это `external_id` объекта, по нему пакеты одного объекта попадают в его проверки. Пакет из папки комплекта (файлы не копируются — символические ссылки):

```bash
npm run package -- "../../dataset/<объект>" --object-id ALT79B --name "ЖК «Алтуфьевское ш., 79Б»" --title "ПД и РД"
```

Что делает Инспектор с новым пакетом: нет проверки у объекта — создаёт и запускает анализ; есть незавершённая — дозагружает в неё; протокол финализирован — не запускает проверку, а шлёт инспектору уведомление («создать проверку» — `POST /api/v1/integration/packages/{id}/apply`). Файлы сверяются по sha256 из пакета.

## Результаты

`POST /api/v1/results` — тело `InspectionResult` (подтверждённые нарушения, версии протокола, матрицы и модели, реестр входных файлов). Проверяются bearer-токен, подпись `x-signature` = HMAC-SHA256 тела и `x-idempotency-key` (`<process_id>:v<версия>`): повтор с тем же ключом — та же квитанция с `duplicate: true`. `GET /api/v1/results` — всё принятое.

## Управление сбоями (для демо и тестов)

```bash
curl -X POST localhost:4020/__control/failures -d '{"mode":"error","count":2}'   # 503 на две следующие отправки
curl -X POST localhost:4020/__control/failures -d '{"mode":"timeout"}'          # не ответить — api уйдёт по таймауту
curl -X POST localhost:4020/__control/failures -d '{"mode":"reject"}'           # 400 — api не повторяет
curl -X POST localhost:4020/__control/failures -d '{"mode":"corrupt"}'          # искажённый файл пакета — api не примет пакет
curl localhost:4020/__control/state
curl -X POST localhost:4020/__control/reset
```

На 5xx и таймаут api повторяет отправку через 1, 5 и 15 минут (`RIN_RETRY_DELAYS_S`), пока идут повторы — `sync_status = PENDING_SYNC`; после них или на 4xx — `SYNC_FAILED` и уведомление инспектору. Протокол остаётся финализированным (REQ-INT-04).
