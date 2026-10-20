# Architecture Decision Records

Короткие записи о значимых архитектурных решениях: что решили, почему, какие последствия.

| № | Решение | Статус |
|---|---|---|
| [0001](0001-contract-first.md) | Contract-first: OpenAPI 3.0 + схемы событий в `contracts/` | принято |
| [0002](0002-ml-without-db.md) | ML-сервис не обращается к БД | принято |
| [0003](0003-embedding-model.md) | Мультиязычная модель эмбеддингов вместо all-MiniLM-L6-v2 (эмбеддинги — после правил) | принято |
| [0004](0004-repo-layout.md) | Монорепозиторий без корневых workspaces | принято |
| [0005](0005-local-first.md) | Локальный запуск без Docker; RabbitMQ/Redis/PostgreSQL — опциональные адаптеры | принято |
| [0006](0006-ml-stack.md) | Стек ML: PyMuPDF, PaddleOCR, Docling, Qwen (vLLM/Ollama), OpenCV | принято |
| [0007](0007-stand-cpu-precomputed-cache.md) | Стенд без GPU (Yandex Cloud): тяжёлый разбор заранее на GPU и кешем по sha256, образ ML — CPU и GPU | принято |
| [0008](0008-llm-scope.md) | LLM: границы, модель, что она не имеет права делать | принято |

**Шаблон** (`NNNN-kebab-title.md`):
```markdown
# NNNN. Заголовок
- Статус: предложено | принято | заменено NNNN
- Дата: YYYY-MM-DD
- Автор: …

## Контекст
## Решение
## Последствия
```
