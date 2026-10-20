# services/api — Backend (Node.js)

**Дизайн:** [docs/services/api.md](../../docs/services/api.md)

Fastify + OpenAPI design-first (маршруты и валидация из `contracts/dist/inspector-api.v1.json`), SQLite (встроенный `node:sqlite`), файловое хранилище в `var/`. **Docker не нужен.**

## Запуск

```bash
# Node.js ≥ 22.13
cd services/api
npm ci
npm run gen        # типы из контрактов (src/generated/, не коммитится)
npm run dev        # http://localhost:3000, ML-заглушка по умолчанию
```

Всё сразу (api + web + ml, если они есть): `./scripts/start-local.sh` из корня репозитория.

| Команда | Что делает |
|---|---|
| `npm run dev` | dev-сервер с перезапуском |
| `npm test` | сквозные тесты (vitest, `fastify.inject`) |
| `npm run typecheck` | проверка типов |
| `npm run build && npm start` | продовая сборка в `dist/` |
| `npm run db:reset` | удалить локальную БД и файлы (`var/`) и создать заново |
| `npm run import:dir -- --path "<папка>"` | серверный импорт комплекта из `IMPORT_ROOT` (по умолчанию `dataset/`) без лимитов интерфейса; `--list` — доступные папки |

**Логины (dev):** `inspector/inspector`, `supervisor/supervisor`, `admin/admin`, `ml/ml`.

## Настройки (`.env` в корне)

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `ML_TRANSPORT` | `stub` | `stub` — заглушка ML внутри api; `http` — настоящий `services/ml` по `ML_URL` |
| `ML_STUB_DELAY_MS` | `1500` | задержка ответа заглушки (видно прогресс в UI) |
| `DB_PATH` / `STORAGE_DIR` | `var/inspector.sqlite` / `var/storage` | локальные данные (в `.gitignore`) |
| `MATRIX_ACTIVE_PARAMS` | `all` | какие параметры активны при первом запуске: `all` — все 132, или список кодов `M-002,M-055` |
| `INTERNAL_TOKEN` | пусто | токен для callback от ml; пусто — callback только с localhost |
| `IMPORT_ROOT` | `dataset` | папка, из которой разрешён серверный импорт |

Полный список — `.env.example`.

## Что реализовано

Auth + роли, объекты (светофор, фильтры, `external_id`), загрузка/дозагрузка и **серверный импорт папки**, **манифест комплекта** (метаданные, связи редакций, ожидаемый состав → полнота), (форматы, 50/200 МБ, целостность PDF, дубликаты, ClamAV опц.), реестр файлов и ручная правка метаданных, оркестрация ML (HTTP / заглушка, ретраи, таймауты), версии протокола с переносом решений, findings и карточки доказательств, пары страниц для сравнения, решения инспектора, **массовое подтверждение по параметру**, **правка доказательств версиями**, split, финализация и её отмена, гипотезы (отклонить/уточнить/в кандидаты), админка матрицы/нормативов/правил с версионированием, аудит, уведомления, GOLD-черновик, `GET /inspection/{id}`, `/metrics`, JSON-логи.

Экспорт протокола: JSON, PDF, DOCX, XML и выгрузка по схеме GOLD (`GET /protocols/{id}/export?format=…`).

Отвечают 501 (в плане): ML-релизы и отчёты, отправка в РиН.
