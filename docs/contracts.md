# Контракты и кодогенерация

> Файлы лежат в `contracts/`.

## Что где

| Файл | Формат | Содержимое |
|---|---|---|
| `contracts/openapi/inspector-api.v1.yaml` | OpenAPI 3.0.3 | REST API и **все доменные схемы**: перечисления, Finding, EvidenceFragment, Protocol… |
| `contracts/events/ml-events.v1.yaml` | OpenAPI 3.0.3 | Обмен api ⇄ ml: HTTP-API ml (`POST /v1/jobs` + callback на `reply_to`, `GET /v1/jobs/{id}`, `/health`) и схемы сообщений (Envelope, ParseRequest/Result, CompareRequest/Result с `page_pairs`, ParsedDocument). Те же Envelope годятся для RabbitMQ. Ссылается на доменные схемы REST-файла |
| `contracts/openapi/rin-external.v1.yaml` | OpenAPI 3.0.3 | API **внешней ИС надзора** (ИАИС «РиН»), как его видит Инспектор: пакеты документов для автозабора (`GET /api/v1/packages`, файлы), приём результата (`POST /api/v1/results`, тело — `InspectionResult` из REST-файла, квитанция `ResultReceipt`, предписание `ISSUED`), токен и подпись `x-signature`. Реального API нет — по этому контракту работают `services/rin-mock` и коннекторы api |
| `contracts/dist/*.json` | JSON (бандл) | Самодостаточные версии обоих файлов со всеми разрешёнными `$ref`. **Коммитятся**, чтобы ML и FE не нуждались в Node-тулинге |
| `infra/rabbitmq/definitions.json` | RabbitMQ | Топология: exchange, очереди, DLX. Объявляется при старте брокера |

Схемы событий оформлены как OpenAPI, а не как чистая JSON Schema. Так у REST и событий один диалект (`nullable`) и одни генераторы.

**Как api проверяет сообщения ml** (`services/api/src/modules/validate.ts`): `nullable: true` приводится к `anyOf: [null, схема]` — ajv иначе не пропускает null рядом с `allOf`/`$ref`/`enum`. В сообщениях ml необязательное поле со значением `null` равносильно отсутствию (так pydantic сериализует `X | None = None`); обязательные поля — строго по контракту. Нестыковку ловит сквозной прогон в Docker (`.github/workflows/images.yml`), а api пишет причину отказа в лог («Сообщение ml не соответствует контракту»).

**Версия 0.2.0** (2026-09-17):

- пары страниц для экрана сравнения (`GET /protocols/{id}/page-pairs`);
- `compliance_percent`;
- `auto_start` при загрузке;
- фильтры findings по `file_id` и `evidence_page`;
- метод `VISUAL_DIFF`;
- `rationale_source`;
- HTTP-транспорт api ⇄ ml.

**Версия 0.3.0** (2026-09-17):

- `UploadManifest` (метаданные файлов и ожидаемый состав);
- `external_id` объекта;
- `POST /documents/import`;
- `POST /findings/{id}/evidence` и `evidence_history`;
- `POST /findings/bulk-decision`;
- `PATCH /files` — только выбор редакции;
- `ProcessInfo.completeness`;
- `TextSource.MANUAL`;
- `TextBlock.layer`;
- в событиях — `expected_documents` и `metadata_source`.

**Версия 0.4.0** (2026-09-17, по Приложению 1 и «Перечню ИД» ред. 1.1):

- `ApprovalStatus` = `DRAFT / APPROVED / FOR_CONSTRUCTION / SUPERSEDED / CANCELLED / UNKNOWN` (было `APPROVED / NOT_APPROVED / UNKNOWN`);
- `CompletenessStatus` по схеме GOLD: `COMPLETE / MISSING_EVIDENCE / NOT_APPLICABLE / NOT_COMPARABLE / CLARIFICATION_REQUIRED` (было `COMPLETE / PARTIAL / MISSING / NOT_APPLICABLE`);
- `DatasetSplit.HIDDEN_TEST` вместо `TEST`;
- реестр файлов: поле `registry` (файл CSV/XLSX/JSON) в `UploadForm`, `ImportRequest.registry_path`, `POST /processes/{id}/registry` → `RegistryApplyResult`;
- `ManifestFile`: `file_id`, `sha256`, `object_id`, `sheet_page_range`, `predecessor_id`, `successor_id`, `signature_status`, `title`;
- `FileInfo`: `external_file_id`, `in_registry`, `sheet_page_range`, `signature_status`, `duplicate_of`, `excluded_from_comparison`, `exclusion_reason`;
- `CompletenessSummary`: `status`, `registry`, `registry_file_name`, `registry_uploaded_at`, `issues[]` (`RegistryIssue`);
- `UploadedFileResult`: `external_file_id`, `duplicate_of`, `warnings[]`; `UploadErrorCode.FILE_ID_CONFLICT` вместо `DUPLICATE_FILE` (повтор — новая запись);
- в событиях: `CompareRequest.registry_status`, `excluded_files`; `CompareFile.external_file_id / in_registry / sheet_page_range / successor_id`; `DocumentMetadata.signature_status`;
- коды параметров в примерах — `M-055`.

**Версия 0.5.0** REST (2026-09-17, экспорт; файл событий остаётся 0.4.0):

- `ExportFormat.gold` и схемы `GoldExport`, `GoldRecord`, `GoldSource` — выгрузка по листу «СХЕМА GOLD» Приложения 1;
- ответ `GET /protocols/{id}/export` в JSON — `Protocol` или `GoldExport`.

**Версия 0.6.0** REST (2026-09-18, формат организаторов; файл событий остаётся 0.4.0, но в бандле `MatrixParam` получил новое поле):

- `MatrixParamInput.external_code` — код параметра у организаторов (`KR-055`, каталог `parameter_catalog_132`);
- `ExportFormat.submission` и схемы `SubmissionExport`, `SubmissionCheck`, `SubmissionEvidence` — ответ участника по `submission_schema.json` из датасета;
- ответ `GET /protocols/{id}/export` в JSON — `Protocol`, `GoldExport` или `SubmissionExport`.

**Версия 0.7.0** REST (2026-09-18, метаданные файла и журнал системы):

- `FileInfo`: `title`, `storage_key` (ключ в хранилище `raw/{sha256}` — файл хранится один раз, в БД только ссылка и метаданные), `uploaded_by`, `uploaded_by_name`;
- `AuditEntry.actor_type` (USER / SYSTEM) и фильтр `actor_type` у `GET /audit`: действия системы по обработке документов пишутся как `system.*`.

**Версия 0.8.0** REST (2026-09-18, манифест организаторов и архивы):

- `FileFormat.OTHER` и `FileProcessingStatus.SKIPPED` — файл в комплекте без анализа (архивы, DWG), принимается только серверным импортом;
- `RegistryIssueCode.FORMAT_CARD_ONLY` — замечание о таком файле, полноту не блокирует;
- `ImportRequest.registry_path`: реестр может быть в JSONL (`document_manifest.jsonl` организаторов), `.zip` распаковывается.

**Версия 0.9.0** REST (2026-09-19, обмен с внешней ИС) и новый файл **`rin-external.v1.yaml` 0.1.0**:

- `POST /inspection/{id}` реализован: ставит отправку в очередь (202 `SyncInfo`), после финализации это происходит само; 409 `NOT_FINALIZED` / `INTEGRATION_DISABLED`;
- `GET /inspection/{id}/sync` — состояние отправки; `SyncInfo`: `protocol_version`, `receipt_id`, `external_system`, `updated_at`;
- автозабор пакетов (REQ-INT-06): `POST /integration/pull` (502 `RIN_UNAVAILABLE`), `GET /integration/packages`, `POST /integration/packages/{id}/apply` (409 `PACKAGE_APPLIED`); схемы `IntegrationPackage`, `IntegrationPackageStatus` (`APPLIED / DEFERRED / FAILED`), `IntegrationPullResult`;
- `GET /integration/status` → `IntegrationStatus` (настройки, время и ошибка последнего опроса, очередь отправки).

**Версия 0.10.0** REST (2026-09-19, ML-контур):

- `POST /ml/dataset-versions` реализован: накопительный выпуск, проверка полноты доказательств, разбиение по объекту; `DatasetVersion`: `split_counts`, `objects_by_split`, `new_items`, `excluded`, `comment`; 409 `VERSION_EXISTS` / `NOTHING_TO_RELEASE`;
- `GET /ml/dataset-versions/{version}/export` — JSONL из `DatasetRecord` (снимок `GoldRecord` + `split`, `gold_label`, `released_in`); хеш части = SHA-256 её строк как есть;
- `POST /ml/models` — регистрация модели (`ModelRegistration`, отчёт `inspector-ml train`); `ModelVersion`: `threshold_checks` (`ThresholdCheck`), `is_current`, `code_version`, `split_hashes`, `registered_by`, `decided_at`, `comment`;
- `POST /ml/models/{v}/decision`: 409 `THRESHOLDS_FAILED` (в `details.failed` — какие проверки) / `INVALID_STATUS`, 404; откат первой модели — «только правила»;
- `WeeklyReport`: `period_start`, `period_end`, `gold_drafts`, `gold_approved_unreleased`, `current_model_version`; неделя по умолчанию — текущая (МСК), 400 `BAD_WEEK`.

**Версия 0.11.0** REST (2026-09-21, запросы фронтенда после вехи M1):

- `PATCH /objects/{object_id}` — правка реквизитов карточки (`ObjectPatch`, все поля необязательные);
  200 `ObjectInfo`, 404, **409 `PROCESS_FINALIZED`**: после финализации реквизиты закрыты, они уже
  вошли в протокол и в выгрузку во внешнюю ИС. Роли — INSPECTOR, SUPERVISOR, ADMIN;
- `DELETE /objects/{object_id}` → 204. **Снаружи удаление, внутри архив:** объект пропадает из
  `GET /objects` и его карточка отвечает 404, а проверки, протоколы, журнал и записи GOLD-набора
  остаются — на финализированный протокол может быть квитанция внешней ИС. Финализированные
  объекты убираются наравне с остальными, инспектор — только свои (403);
- `AuditEntry.user_role` — роль на момент действия. Роль пользователя может измениться позже,
  поэтому она хранится вместе с записью, а не вычисляется при чтении.

**Версия 0.12.0** REST (2026-09-21):

- `POST /files/{file_id}/signature` — приложить открепленную подпись (`.sig`, `.p7s`, `.sgn`,
  до 256 КБ). **Это подвязка, а не проверка:** файл хранится рядом с документом и виден
  в `FileInfo.signature`, но `verification` всегда `NOT_VERIFIED`, а `signature_status`
  документа по-прежнему приходит из реестра комплекта. Криптографическая проверка появится
  вместе с доступом к УКЭП (REQ-INT-02 — сертификатов на соревновании не дают);
- схемы `SignatureAttachment` и `SignatureVerification` (`NOT_VERIFIED / VALID / INVALID`);
- `FileInfo.signature` — приложенный файл подписи или `null`.

**Версия 0.23.0** REST и **0.8.0** событий (2026-09-28):

- перечисление `ExtractionMethod` = `RULES` | `SBERT` — как в тексте нашли значение: правилами матрицы и
  извлекателями или запасным путём Sentence-BERT (флаг `SBERT_ENABLED`). Это не `TextSource`: тот говорит,
  откуда текст (слой, OCR), и не `rationale_source`: тот — про обоснование всей проверки;
- необязательное `extraction_method` в `EvidenceFragment` (значит, и в `CheckResult.fragments` событий, и в
  протоколе, и в выгрузке для внешней ИС) и в `GoldSource`. `null` — правила: протоколы до 0.23.0 и области,
  указанные инспектором вручную. Api хранит поле во фрагменте (миграция 013), копирует при правке
  доказательств и отдаёт в GOLD рядом с `source`, поэтому скорер видит пометку и в наборе, и в сравнении.

**Версия 0.22.0** REST (2026-09-27):

- `DatasetReleaseRequest.object_splits` — необязательная явная часть объекта `{object_id: DatasetSplit}`.
  Нужна, когда объектов мало: по sha256(object_id) с долями 70/15/15 два объекта попадают в TRAIN и
  VALIDATION по одному лишь в 21 % случаев, а часть объекта после первого выпуска не меняется.
  Объекты не из списка распределяются по `split_ratio`, как раньше;
- `POST /ml/dataset-versions`: 409 `SPLIT_FIXED` — `object_splits` меняет часть объекта, уже попавшего в набор;
  400 `UNKNOWN_OBJECT` — в `object_splits` объект без одобренных записей с полным доказательством в выпуске.
  В обоих случаях ничего не выпускается.

**Версия 0.21.0** REST и **0.7.0** событий (2026-09-26):

- `DocumentMetadata` (события) и `FileInfo` (REST): необязательное `developer_org` — организация-разработчик
  ПД/РД из графы 9 основной надписи или с титула, правовая форма сокращена; для ИД `null`, у ИП только «ИП»
  (152-ФЗ). Уверенность — в существующем `field_confidence.developer_org`. Считает `metadata/organization.py`,
  в том числе при попадании в кеш, — `PARSER_VERSION` не меняется.

**Версия 0.20.0** REST и **0.6.0** событий (2026-09-25):

- `DocumentMetadata` (события): восемь необязательных сведений о файле и содержимом — `project_code`,
  `language` (`ru` / `en` / `mixed`), `scan_share` (0…1), `file_size`, `pdf_version`, `pdf_producer`,
  `pdf_creator`, `encrypted`. ML считает их в `metadata/facts.py`, в том числе при попадании в кеш;
- `FileInfo` (REST): те же поля, кроме `file_size` — размер уже есть в `size_bytes`. Api хранит словарь
  метаданных разбора целиком (`files.metadata`), миграция не нужна; значение не по контракту отдаётся как `null`.

**Версия 0.19.0** REST (2026-09-24):

- `POST /processes/{id}/unfinalize-request` (INSPECTOR, SUPERVISOR) — попросить откат финализации с
  причиной; открытый запрос на процесс один (повтор — 409 `REQUEST_EXISTS`);
- `GET /unfinalize-requests?status=` и `POST /unfinalize-requests/{id}/reject` (ADMIN, SUPERVISOR);
  успешный `/unfinalize` закрывает открытые запросы процесса как `DONE`;
- уведомления `RETRAIN_ITEM_PENDING` (отказ инспектора ждёт решения по дообучению, ADMIN) и
  `UNFINALIZE_REQUESTED` (ADMIN и SUPERVISOR).

**Версия 0.18.0** REST (2026-09-24):

- `Finding.trigger_logic` — правило срабатывания из матрицы. Карточке с `stage_comparisons` хватает его
  и таблицы стадий; `rationale` остаётся самодостаточным (значения, вывод, триггер), потому что уходит
  и в выгрузки, где таблицы стадий нет.

**Версия 0.17.0** REST и **0.5.0** событий (2026-09-24):

- `Finding.stage_comparisons[]` и `CheckResult.stage_comparisons[]` — сравнение с эталоном ПД по каждой
  стадии: `stage`, `value`, `raw_value`, `delta`, `triggered`, `verdict`. Раньше наружу шла одна пара
  `actual_value` / `delta`, даже когда сравнивались и РД, и ИД; теперь у каждой стадии свой результат.
  `actual_value` и `delta` остались — это стадия, давшая вывод. У протоколов до 0.17.0 массив пуст.

**Версия 0.16.0** REST (2026-09-24):

- `POST` и `PUT /admin/logical-rules`: условие и следствие проверяются при сохранении — неверное
  выражение или неизвестный код параметра дают `400 RULE_INVALID` с причиной («expected: выражение
  оборвалось»). Описания полей — настоящий язык правил вместо старых примеров `floors > 10`.

**Версия 0.15.0** REST (2026-09-24):

- `POST /documents/upload` принимает комплект целиком, схема та же, поменялось поведение и описания:
  архив .zip в `files` раскрывается (содержимое — отдельными файлами, стадия по папкам, сам архив
  в комплект не входит, предел — предел пакета), имя файла может быть путём папки
  (`webkitRelativePath`) — стадия по папкам, `original_name` — последний сегмент; реестр из корня
  архива или папки — реестр комплекта. Не распаковался — `REJECTED` с `CORRUPTED_FILE` или
  `FILE_TOO_LARGE`, причина в `message`;
- `FileFormat.OTHER` теперь бывает и у загрузки через интерфейс: DWG и прочее из папки или архива.

**Версия 0.14.0** REST (2026-09-24):

- `POST /admin/mlflow/session` (ADMIN, ML_ENGINEER) → `MlflowSession {url, expires_in}` и cookie
  `inspector_mlflow` (HttpOnly, SameSite=Strict, путь `/mlflow`). По ней веб-сервер пускает к MLflow по
  `/mlflow/`; токен отдельный от JWT входа. MLflow не запущен — `503 MLFLOW_UNAVAILABLE`.

**Версия 0.13.0** REST (2026-09-23, до публичного стенда):

- `POST /auth/login` → **429** `TOO_MANY_LOGIN_ATTEMPTS` (ответ `TooManyLoginAttempts`): слишком много
  неудачных попыток. Неудачи считаются в скользящем окне по паре «логин + адрес клиента» (по умолчанию
  5 за 15 минут) и по адресу в целом (20) — перебор по многим логинам. Учётная запись целиком
  не блокируется: демо-учётки общие, и посторонний не должен уметь запереть проверяющих. Пароль при закрытом
  входе не проверяется. Сколько ждать — заголовок `Retry-After` и `details.retry_after_s`.

## Команды (в папке `contracts/`)

```bash
npm install          # один раз
npm run lint         # валидация Redocly — обязательна перед PR с изменениями контрактов
npm run bundle       # пересобрать contracts/dist/*.json (коммитить вместе с yaml)
npm run mock         # мок-сервер API на http://localhost:4010 (Prism) — для фронта до готовности бэка
npm run docs         # HTML-документация API в contracts/dist-docs/ (не коммитится)
```

## Кодогенерация в сервисах

Сгенерированное **не коммитится** (в `.gitignore`). Каждый сервис заводит у себя скрипт `gen`.

**web:**

```bash
npx openapi-typescript ../../contracts/dist/inspector-api.v1.json -o src/api/schema.d.ts
```

Клиент:

```ts
import createClient from 'openapi-fetch';
import type { paths } from './schema';
export const api = createClient<paths>({ baseUrl: import.meta.env.VITE_API_URL });
```

**api:**

```bash
npx openapi-typescript ../../contracts/dist/inspector-api.v1.json -o src/generated/api.d.ts
npx openapi-typescript ../../contracts/dist/ml-events.v1.json    -o src/generated/events.d.ts
npx openapi-typescript ../../contracts/dist/rin-external.v1.json -o src/generated/rin.d.ts   # клиент внешней ИС
```

Роутинг и валидация запросов — `fastify-openapi-glue` поверх `contracts/dist/inspector-api.v1.json`.

**ml:**

```bash
uvx --from 'datamodel-code-generator[http]' datamodel-codegen \
  --input ../../contracts/dist/ml-events.v1.json --input-file-type openapi \
  --output-model-type pydantic_v2.BaseModel --target-python-version 3.12 \
  --use-standard-collections --use-union-operator --enum-field-as-literal all \
  --output src/inspector_ml/contracts/events.py
```

Проверено: модель `CheckResult` не принимает `finding_status=CONFIRMED_VIOLATION`.

## Как изменить контракт

1. Правка yaml в `contracts/`, затем `npm run lint && npm run bundle` и новая `info.version`; yaml и `dist/` меняются в одном **отдельном PR** «contracts: …».
2. После слияния сервисы перегенерируют типы.

**Совместимость.** Добавление необязательных полей — minor-версия, переименование или удаление — major. При major-изменении все сервисы обновляются одновременно.
