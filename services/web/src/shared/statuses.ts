// Словарь статусов согласно docs/domain/statuses.md

export const PROCESS_STATUS = {
  PENDING: { label: 'Ожидает', color: 'default' },
  PARSING: { label: 'Обработка', color: 'processing' },
  READY: { label: 'Готов к верификации', color: 'success' },
  VERIFYING: { label: 'Верификация', color: 'processing' },
  // «Разобран», а не «Завершён»: это статус прогона сравнения, а не решения инспектора — кандидаты,
  // гипотезы и нехватка доказательств по проекту в этом статусе ещё могут быть открыты
  COMPLETED: { label: 'Разобран', color: 'success' },
  FINALIZED: { label: 'Финализирован', color: 'success' },
  FAILED: { label: 'Ошибка', color: 'error' },
} as const;

export const FINDING_STATUS = {
  CANDIDATE: { label: 'Кандидат', color: 'warning' },
  CONFIRMED_VIOLATION: { label: 'Подтверждено', color: 'success' },
  NEGATIVE_VERIFIED: { label: 'Отклонено', color: 'error' },
  MISSING_EVIDENCE: { label: 'Нет доказательств', color: 'default' },
  NOT_APPLICABLE: { label: 'Не применимо', color: 'default' },
  NOT_COMPARABLE: { label: 'Не сопоставимо', color: 'default' },
  CLARIFICATION_REQUIRED: { label: 'Требует уточнения', color: 'warning' },
  SUSPICION: { label: 'Гипотеза', color: 'default' },
} as const;

/**
 * Как назвать статус находки. `NEGATIVE_VERIFIED` без решения инспектора это вердикт самого движка «нарушения нет»
 * (различие не описано триггером или значения совпали), а не отклонение: отклоняет только инспектор, и тогда у находки есть решение.
 */
export const findingStatusView = (status: keyof typeof FINDING_STATUS, hasDecision: boolean): { label: string; color: string } =>
  status === 'NEGATIVE_VERIFIED' && !hasDecision ? { label: 'Нарушения нет', color: 'success' } : FINDING_STATUS[status];

export const INSPECTOR_STATUS = {
  PENDING: { label: 'Ожидает', color: 'default' },
  CONFIRMED_VIOLATION: { label: 'Подтверждено', color: 'success' },
  NEGATIVE_VERIFIED: { label: 'Отклонено', color: 'error' },
  CLARIFICATION_REQUIRED: { label: 'Требует уточнения', color: 'warning' },
} as const;

export const COMPLETENESS_STATUS = {
  COMPLETE: { label: 'Полный', color: 'success' },
  MISSING_EVIDENCE: { label: 'Не хватает документов', color: 'warning' },
  NOT_APPLICABLE: { label: 'Не применимо', color: 'default' },
  NOT_COMPARABLE: { label: 'Не читается', color: 'error' },
  CLARIFICATION_REQUIRED: { label: 'Требует уточнения', color: 'warning' },
} as const;

export const APPROVAL_STATUS = {
  DRAFT: { label: 'Черновик', color: 'default' },
  APPROVED: { label: 'Утверждена', color: 'success' },
  FOR_CONSTRUCTION: { label: 'В производство работ', color: 'processing' },
  SUPERSEDED: { label: 'Заменена', color: 'default' },
  CANCELLED: { label: 'Аннулирована', color: 'error' },
  UNKNOWN: { label: 'Неизвестно', color: 'default' },
} as const;

export const STAGE_UPLOAD_STATUS = {
  PD_MISSING: { label: 'ПД: нет файлов', color: 'default', stage: 'PD' },
  PD_UPLOADED: { label: 'ПД: загружена', color: 'success', stage: 'PD' },
  PD_PARTIAL: { label: 'ПД: частично', color: 'warning', stage: 'PD' },
  RD_MISSING: { label: 'РД: нет файлов', color: 'default', stage: 'RD' },
  RD_UPLOADED: { label: 'РД: загружена', color: 'success', stage: 'RD' },
  RD_PARTIAL: { label: 'РД: частично', color: 'warning', stage: 'RD' },
  ID_MISSING: { label: 'ИД: нет файлов', color: 'default', stage: 'ID' },
  ID_UPLOADED: { label: 'ИД: загружена', color: 'success', stage: 'ID' },
  ID_PARTIAL: { label: 'ИД: частично', color: 'warning', stage: 'ID' },
} as const;

export const OBJECT_INDICATOR = {
  RED: { label: 'Нарушения', color: 'error' },
  YELLOW: { label: 'Проверяется', color: 'warning' },
  GREEN: { label: 'Соответствует', color: 'success' },
} as const;

export const CHECK_PRIORITY = {
  HIGH: { label: 'Высокий', color: 'error' },
  MEDIUM: { label: 'Средний', color: 'warning' },
  LOW: { label: 'Низкий', color: 'default' },
} as const;

export const REJECT_REASON = {
  WRONG_REVISION: { label: 'Неверная редакция' },
  APPROVED_CHANGE: { label: 'Согласованное изменение' },
  OCR_ERROR: { label: 'Ошибка распознавания' },
  LINKING_ERROR: { label: 'Ошибка привязки' },
  EXTRACTION_ERROR: { label: 'Ошибка извлечения' },
  PARAMETER_NOT_APPLICABLE: { label: 'Параметр неприменим' },
  NO_DISCREPANCY: { label: 'Расхождения нет' },
  OTHER: { label: 'Прочее' },
} as const;

export const FILE_PROCESSING_STATUS = {
  UPLOADED: { label: 'Загружен', color: 'default' },
  QUEUED: { label: 'В очереди', color: 'default' },
  PARSING: { label: 'Разбирается', color: 'processing' },
  PARSED: { label: 'Разобран', color: 'success' },
  FAILED: { label: 'Не читается', color: 'error' },
  REJECTED: { label: 'Отклонён', color: 'error' },
  SKIPPED: { label: 'Не анализируется', color: 'default' },
} as const;

export const DOC_STAGE_LABEL = { PD: 'ПД', RD: 'РД', ID: 'ИД' } as const;

export const REGISTRY_ISSUE = {
  NO_REGISTRY: 'Реестр не загружен',
  NOT_IN_REGISTRY: 'Файла нет в реестре',
  MISSING_FILE: 'Файл из реестра не загружен',
  SHA256_MISMATCH: 'Контрольная сумма не совпала с реестром',
  AMBIGUOUS_REVISION: 'Неоднозначные редакции',
  UNREADABLE_FILE: 'Файл не удалось обработать',
  DUPLICATE_CONTENT: 'Повторная загрузка того же содержимого',
  UNKNOWN_LINK: 'Ссылка на неизвестный файл',
  FORMAT_CARD_ONLY: 'Формат не анализируется',
} as const;

// Обмен с внешней ИС (REQ-INT-06): что стало с пакетом документов
export const INTEGRATION_PACKAGE_STATUS = {
  APPLIED: { label: 'Проверка запущена', color: 'success' },
  DEFERRED: { label: 'Ждёт решения инспектора', color: 'warning' },
  FAILED: { label: 'Не принят', color: 'error' },
} as const;

// ML-контур (REQ-ML-01…06): записи GOLD-набора, версии и модели
export const CURATION_STATUS = {
  DRAFT: { label: 'Ждёт куратора', color: 'warning' },
  APPROVED: { label: 'Одобрена', color: 'success' },
  EXCLUDED: { label: 'Исключена', color: 'default' },
} as const;

export const GOLD_LABEL = {
  POSITIVE: { label: 'Нарушение', color: 'error' },
  NEGATIVE: { label: 'Нарушения нет', color: 'default' },
} as const;

export const MODEL_APPROVAL_STATUS = {
  PENDING: { label: 'Ждёт решения', color: 'warning' },
  APPROVED: { label: 'Одобрена', color: 'success' },
  REJECTED: { label: 'Отклонена', color: 'error' },
  ROLLED_BACK: { label: 'Откачена', color: 'default' },
} as const;

export const DATASET_SPLIT_LABEL = { TRAIN: 'Обучение', VALIDATION: 'Проверка', HIDDEN_TEST: 'Скрытый тест' } as const;