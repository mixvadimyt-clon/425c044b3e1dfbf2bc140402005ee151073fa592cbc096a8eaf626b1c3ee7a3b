import type { S } from '../../types.js';

/** Подписи для печатных форм — те же слова, что в интерфейсе (docs/domain/statuses.md). */

export const STAGE: Record<S['DocStage'], string> = { PD: 'ПД', RD: 'РД', ID: 'ИД' };

export const UPLOAD: Record<string, string> = { UPLOADED: 'загружена полностью', PARTIAL: 'загружена частично', MISSING: 'не загружена' };
export const uploadLabel = (s: S['StageUploadStatus']) => `${STAGE[s.slice(0, 2) as S['DocStage']]}: ${UPLOAD[s.slice(3)] ?? s}`;

export const SCENARIO: Record<S['CheckScenario'], string> = {
  FULL: 'Полная проверка (ПД, РД, ИД)',
  PD_RD_ONLY: 'Сверка ПД и РД',
  PD_ID_ONLY: 'Сверка ПД и ИД',
  RD_ID_ONLY: 'Сверка РД и ИД',
  SINGLE_ONLY: 'Одна стадия документации',
  PARTIALLY_LOADED: 'Комплект загружен частично',
};

export const FINDING: Record<S['FindingStatus'], string> = {
  NEGATIVE_VERIFIED: 'Проверено, расхождений нет',
  CANDIDATE: 'Кандидат в нарушение',
  CONFIRMED_VIOLATION: 'Подтверждённое нарушение',
  MISSING_EVIDENCE: 'Недостаточно доказательств',
  NOT_APPLICABLE: 'Неприменимо',
  NOT_COMPARABLE: 'Несопоставимо',
  CLARIFICATION_REQUIRED: 'Требует уточнения',
  SUSPICION: 'Гипотеза',
};

export const COMPLETENESS: Record<S['CompletenessStatus'], string> = {
  COMPLETE: 'Полный',
  MISSING_EVIDENCE: 'Не хватает документов',
  NOT_APPLICABLE: 'Неприменимо',
  NOT_COMPARABLE: 'Не читается / не сопоставлено',
  CLARIFICATION_REQUIRED: 'Требует уточнения',
};

export const INSPECTOR: Record<S['InspectorStatus'], string> = {
  PENDING: 'ожидает решения',
  CONFIRMED_VIOLATION: 'подтверждено',
  NEGATIVE_VERIFIED: 'отклонено',
  CLARIFICATION_REQUIRED: 'на уточнении',
};

export const SUSPICION_STATUS: Record<S['Suspicion']['inspector_status'], string> = {
  PENDING: 'ожидает решения',
  DISMISSED: 'отклонена',
  CLARIFICATION_REQUIRED: 'на уточнении',
  PROMOTED: 'переведена в кандидаты',
};

export const REASON: Record<S['ReasonCode'], string> = {
  WRONG_REVISION: 'неверная редакция',
  APPROVED_CHANGE: 'согласованное изменение',
  OCR_ERROR: 'ошибка распознавания',
  LINKING_ERROR: 'ошибка привязки документа',
  EXTRACTION_ERROR: 'ошибка извлечения значения',
  PARAMETER_NOT_APPLICABLE: 'параметр неприменим',
  NO_DISCREPANCY: 'расхождения нет',
  OTHER: 'прочее',
};

export const APPROVAL: Record<S['ApprovalStatus'], string> = {
  DRAFT: 'черновик',
  APPROVED: 'утверждена',
  FOR_CONSTRUCTION: 'в производство работ',
  SUPERSEDED: 'заменена',
  CANCELLED: 'аннулирована',
  UNKNOWN: 'не определён',
};

export const PRIORITY: Record<S['ReviewPriority'], string> = { HIGH: 'высокий', MEDIUM: 'средний', LOW: 'низкий' };

export const METHOD: Record<S['DiscoveryMethod'], string> = {
  LOGICAL_ANALYSIS: 'логический анализ',
  SEMANTIC_DISSONANCE: 'семантический диссонанс',
  NORMATIVE_ANALYSIS: 'нормативный анализ',
  ML_PATTERN: 'аномалия значений',
  VISUAL_DIFF: 'визуальное сравнение',
};

export const PROTOCOL_STATUS: Record<S['ProtocolVerificationStatus'], string> = {
  IN_PROGRESS: 'идёт верификация',
  VERIFICATION_COMPLETED: 'верификация завершена',
  PROTOCOL_FINALIZED: 'финализирован',
};

export const TRIGGER: Record<NonNullable<S['ProtocolVersionInfo']['trigger']>, string> = {
  INITIAL: 'первичная проверка',
  INCREMENTAL_UPLOAD: 'дозагрузка документов',
  METADATA_CHANGE: 'изменение реестра или редакций',
  MANUAL_RERUN: 'повторный запуск',
};

export const ISSUE: Record<S['RegistryIssueCode'], string> = {
  NO_REGISTRY: 'нет реестра файлов',
  NOT_IN_REGISTRY: 'файл вне реестра',
  MISSING_FILE: 'файл из реестра не загружен',
  SHA256_MISMATCH: 'контрольная сумма не совпала',
  AMBIGUOUS_REVISION: 'неоднозначные редакции',
  UNREADABLE_FILE: 'файл не читается',
  DUPLICATE_CONTENT: 'повторная загрузка',
  UNKNOWN_LINK: 'неизвестная ссылка на редакцию',
  FORMAT_CARD_ONLY: 'файл без анализа (карточка)',
};

/** Дата и время по Москве — как видит инспектор. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
}

export const dash = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? '—' : String(v));
