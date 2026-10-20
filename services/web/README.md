# Веб-клиент «Продукт»

React-приложение для верификации расхождений между ПД, РД и ИД.

## Быстрый старт

```bash
# Установка зависимостей
npm install

# Генерация типов из контрактов
npm run gen

# Создать .env из примера
cp .env.example .env

# Запуск dev-сервера
npm run dev
# → http://localhost:5173

# Сборка для продакшена
npm run build

# Тесты
npm test
npm run test:watch
```

## Требования

- Node.js 18+
- Работающий API на http://localhost:3000

## Запуск API локально

```bash
cd ../api
npm ci
npm run gen
npm run db:reset
npm run dev
```

Логины для теста:
- `inspector/inspector` — верификация
- `admin/admin` — админка и аудит
- `supervisor/supervisor` — отмена финализации

## Структура

```
src/
├── api/              # Клиент openapi-fetch + schema.d.ts (генерируется)
├── app/              # App.tsx, router, providers, layouts
├── pages/            # Страницы (LoginPage, WorkspacePage...)
├── widgets/          # Крупные компоненты (FilesPanel, StagePanels, EvidenceCard...)
├── shared/           # Общие типы, словарь статусов, константы
└── test/             # Настройка тестов
```

## Команды

| Команда | Действие |
|---|---|
| `npm run dev` | Dev-сервер на :5173 |
| `npm run build` | Сборка в `dist/` |
| `npm run preview` | Предпросмотр продакшен-сборки |
| `npm test` | Запуск тестов |
| `npm run lint` | Проверка ESLint |
| `npm run format` | Форматирование Prettier |
| `npm run gen` | Генерация типов из контрактов |

## Технологии

- **React 18** + TypeScript
- **Ant Design 5** (тёмная тема, локаль ru_RU)
- **Vite** — сборка
- **React Router 6** — маршрутизация
- **TanStack Query** — кеширование запросов
- **openapi-fetch** + **openapi-typescript** — типизированный API-клиент
- **Vitest** + **Testing Library** — тесты

## Дизайн

Референс: трёхпанельный интерфейс «СканСтадия AI» с синхронными просмотрами ПД/РД/ИД.

- Тёмная тема по умолчанию (#0F172A база, #22D3EE акцент)
- Шрифт Inter
- Переключатель темы в меню пользователя

Подробно — [docs/services/web.md](../../docs/services/web.md).

## Контракты

Типы генерируются из `contracts/dist/inspector-api.v1.json` (v0.5.0). Код подстраивается под контракт, а не наоборот.

После `git pull` с обновлённым контрактом:

```bash
npm run gen
```

Файл `src/api/schema.d.ts` игнорируется git.

## Статус

Реализовано:
- ✅ Скаффолдинг Vite + React + TS
- ✅ Ant Design с тёмной темой
- ✅ API-клиент с Bearer-токеном и интерцептором 401
- ✅ Аутентификация (LoginPage, AuthProvider, guard маршрутов)
- ✅ Каркас рабочего окна (шапка, сайдбар, центр, правая панель)
- ✅ Словарь статусов и компонент StatusTag
- ✅ ESLint, Prettier, Vitest
