# contracts/ — контракты между сервисами

Подробности и правила изменения — [docs/contracts.md](../docs/contracts.md).

| Файл | Что |
|---|---|
| `openapi/inspector-api.v1.yaml` | REST API + доменные схемы (OpenAPI 3.0.3) |
| `events/ml-events.v1.yaml` | Сообщения RabbitMQ api ⇄ ml |
| `dist/*.json` | Самодостаточные бандлы (генерируются `npm run bundle`, **коммитятся**) |

```bash
npm install
npm run lint     # валидация
npm run bundle   # пересобрать dist/
npm run mock     # мок API на :4010
```
