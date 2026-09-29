# Документация «Продукт»

Код — в `services/`, всё остальное — здесь.

## С чего начать

| Кто вы | Что прочитать |
|---|---|
| Новый человек | [TZ.md](TZ.md) → [ARCHITECTURE.md](ARCHITECTURE.md) → [glossary.md](glossary.md) |
| Бэкенд | [services/api.md](services/api.md), [domain/data-model.md](domain/data-model.md), [domain/statuses.md](domain/statuses.md), [contracts.md](contracts.md) |
| ML | [services/ml.md](services/ml.md), [domain/matrix.md](domain/matrix.md), [domain/statuses.md](domain/statuses.md), [contracts.md](contracts.md) |
| Фронтенд | [services/web.md](services/web.md), [domain/protocol.md](domain/protocol.md), [domain/statuses.md](domain/statuses.md), [contracts.md](contracts.md) |

## Карта документации

### Продукт и требования
- [TZ.md](TZ.md) — дайджест ТЗ с ID требований (`REQ-…`). Первоисточник — `../Техническое задание.pdf`
- [glossary.md](glossary.md) — термины: ПД/РД/ИД, АОСР, шифр, редакция, штамп, evidence group…
- [SUBMISSION.md](SUBMISSION.md) — **комплект сдачи**: каждое требование организаторов к сдаче и где оно закрыто

### Архитектура
- [ARCHITECTURE.md](ARCHITECTURE.md) — сервисы, поток данных, стек, хранилища
- [contracts.md](contracts.md) — как устроены и как меняются контракты (OpenAPI, события), кодогенерация
- [adr/](adr/README.md) — журнал архитектурных решений
- [examples/](examples/README.md) — примеры выходного JSON

### Предметная модель
- [domain/statuses.md](domain/statuses.md) — все статусы, кто их ставит, переходы
- [domain/data-model.md](domain/data-model.md) — таблицы БД
- [domain/matrix.md](domain/matrix.md) — матрица 132 параметров: формат, загрузка, семантика полей
- [domain/registry.md](domain/registry.md) — реестр файлов комплекта
- [domain/protocol.md](domain/protocol.md) — структура протокола и карточки доказательства
- [domain/models.md](domain/models.md) — модели и правила конвейера, замеры качества

### Сервисы
- [services/api.md](services/api.md) — Backend
- [services/ml.md](services/ml.md) — ML
- [services/web.md](services/web.md) — Frontend

### Гайды
- [guides/user-journey.md](guides/user-journey.md) — пользовательский путь со снимками экранов: от загрузки комплекта до протокола, решения инспектора, выгрузка, откат, администратор
- [guides/upload-to-result.md](guides/upload-to-result.md) — от загрузки до результата: что происходит с комплектом от кнопки «Загрузить» до строки протокола, схема, пример на контрольном комплекте, замеры REQ-PERF
- [guides/dev-setup.md](guides/dev-setup.md) — локальный запуск
- [guides/local-demo-run.md](guides/local-demo-run.md) — полный локальный прогон на настоящем комплекте
- [guides/deploy.md](guides/deploy.md) — развёртывание в Docker и публичный стенд

## Правила ведения документации

- Markdown, русский язык, заголовки по смыслу. Диаграммы — в Mermaid (GitHub рендерит их сам).
- Ссылайтесь на требования по ID (`REQ-VER-03`) и на код по пути (`services/api/src/modules/findings/decision.ts`).
- Документ `docs/services/<svc>.md` обновляется в том же PR, что и код.
