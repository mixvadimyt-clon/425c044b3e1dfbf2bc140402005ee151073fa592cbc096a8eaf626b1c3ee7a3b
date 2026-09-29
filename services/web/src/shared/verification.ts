import type { REJECT_REASON } from './statuses';
import type { StageComparisonRow } from './stageComparisons';

export type EvidenceRole = 'EXPECTED' | 'ACTUAL' | 'CONTEXT';

/** Рамка доказательства на странице (проценты страницы). */
export interface EvidenceMark {
  page: number;
  bbox: { x: number; y: number; w: number; h: number };
  value: string;
  role?: EvidenceRole;
  /** Фрагмент в api: по нему рамку можно убрать при правке доказательств. */
  fragmentId?: string;
  /** Рамка нарисована инспектором (`source = MANUAL`), а не найдена системой. */
  manual?: boolean;
  /** Значение найдено Sentence-BERT по близости подписи к названию параметра (`extraction_method = SBERT`). */
  bySense?: boolean;
}

/** Фрагмент доказательства на одной стадии (ПД / РД / ИД). */
export interface Source {
  page: number;
  totalPages?: number;
  value: string;
  /** Рамка в процентах страницы (x, y — левый верхний угол). */
  bbox?: { x: number; y: number; w: number; h: number };
  docName?: string;
  area?: string;
  /** Файл в api: если задан, страница рисуется из `GET /files/{id}/content`, иначе — макет. */
  fileId?: string;
  /** Как значение попало в документ: текстовый слой, OCR и т.п. */
  snippet?: string;
  /** Роль основного фрагмента: ожидаемое (эталон), фактическое или контекст. */
  role?: EvidenceRole;
  /** Номер листа по штампу (может отличаться от номера страницы PDF). */
  sheet?: string;
  /** Основное значение найдено Sentence-BERT по смыслу подписи, его стоит проверить глазами. */
  bySense?: boolean;
  /** Все рамки стадии: на странице показываются те, что лежат на ней. */
  marks?: EvidenceMark[];
}

export type RejectReason = keyof typeof REJECT_REASON;

/** Фрагмент доказательства для разделения составного несоответствия. */
export interface FragmentInfo {
  id: string;
  stage: 'ПД' | 'РД' | 'ИД';
  page: number;
  value: string;
  role: EvidenceRole;
  /** Добавлен инспектором вручную. */
  manual: boolean;
}

/** Рамка, нарисованная инспектором в режиме правки доказательств (ещё не сохранена). */
export interface DraftFragment {
  /** Локальный ключ для списка. */
  key: string;
  stage: 'ПД' | 'РД' | 'ИД';
  fileId: string;
  page: number;
  /** Проценты видимой страницы. */
  bbox: { x: number; y: number; w: number; h: number };
  role: 'EXPECTED' | 'ACTUAL';
  value: string;
}

/** Запись в истории решений по несоответствию. */
export interface DecisionEntry {
  action: 'CONFIRM' | 'REJECT' | 'CLARIFY';
  reasonCode?: RejectReason;
  comment?: string;
  by?: string;
  at: string;
}

/** Версия доказательств: исходная машинная и правки инспектора (новой версией, машинная остаётся в истории). */
export interface EvidenceVersionEntry {
  version: number;
  source: 'MODEL' | 'INSPECTOR';
  by?: string;
  at: string;
  reason?: string;
  reference?: string;
  fragments: number;
}

export interface Finding {
  finding_id: string;
  /** «Требуется уточнение» от модели: у одного параметра несколько разных значений, решения инспектора ещё нет. */
  modelClarification?: boolean;
  code: string;
  parameter_name: string;
  section: string;
  review_priority: 'HIGH' | 'MEDIUM' | 'LOW';
  requirement?: string;
  description: string;
  /** Обоснование модели целиком (в выгрузках оно самодостаточно). */
  rationale?: string;
  /** Правило срабатывания из матрицы (контракт 0.18.0). */
  triggerLogic?: string;
  sources: {
    pd?: Source;
    rd?: Source;
    id_?: Source;
  };
  sp_reference?: string;
  gost_reference?: string;
  fz_reference?: string;
  status: 'CANDIDATE' | 'confirmed' | 'rejected' | 'clarification';
  inspector_comment?: string;
  reason_code?: RejectReason;
  /** Ключ атомарного правила внутри параметра (номер помещения, элемент). */
  ruleKey?: string;
  delta?: string;
  /** Сравнение по каждой стадии (РД и ИД): у протоколов до контракта 0.17.0 пусто. */
  stageComparisons?: StageComparisonRow[];
  /** Кто сформулировал обоснование: правила или ИИ. */
  rationaleSource?: 'RULES' | 'AI';
  /** Доказательства изменились после дозагрузки — прежнее решение сброшено. */
  evidenceChanged?: boolean;
  /** Все фрагменты доказательств (нужны для разделения на части). */
  fragments?: FragmentInfo[];
  /** История решений, новые сверху. */
  decisionHistory?: DecisionEntry[];
  /** Версии доказательств, от исходной к текущей. */
  evidenceVersions?: EvidenceVersionEntry[];
}

/** Шаблон комментария при отклонении: подставляется в поле заранее, инспектор его правит или дополняет (комментарий обязателен). */
export const REJECT_TEMPLATES: Record<RejectReason, string> = {
  WRONG_REVISION: 'Сравнение выполнено с неактуальной редакцией документа: расхождения по действующей редакции нет.',
  APPROVED_CHANGE: 'Расхождение согласовано изменением проекта и нарушением не является.',
  OCR_ERROR: 'Ошибка распознавания: значение в документе прочитано неверно.',
  LINKING_ERROR: 'Ошибка привязки: сопоставлены значения, относящиеся к разным элементам.',
  EXTRACTION_ERROR: 'Ошибка извлечения: система взяла из документа не то значение.',
  PARAMETER_NOT_APPLICABLE: 'Параметр неприменим для этого проекта.',
  NO_DISCREPANCY: 'Расхождения нет: значения в документах совпадают.',
  OTHER: 'Причина не входит в список, пояснение инспектора в комментарии.',
};


/**
 * Запись ждёт решения инспектора: обычный кандидат или «требуется уточнение» от модели (у параметра несколько разных
 * значений, решения инспектора ещё нет). Кнопки решения и клавиши 1–3 работают для обоих видов одинаково.
 */
export const isAwaitingDecision = (f: Pick<Finding, 'status' | 'modelClarification'>): boolean =>
  f.status === 'CANDIDATE' || (f.status === 'clarification' && Boolean(f.modelClarification));

/** Кандидаты, которых можно отметить для массового решения: без решения инспектора. */
export const isBulkCandidate = (f: Pick<Finding, 'status'>): boolean => f.status === 'CANDIDATE';

/**
 * Что можно отметить при уже выбранных: массовое решение — только по одному параметру (`BULK_MIXED` в api),
 * поэтому после первой отметки остальные параметры недоступны.
 */
export const canSelectForBulk = (selected: Pick<Finding, 'code'>[], candidate: Pick<Finding, 'code' | 'status'>): boolean =>
  isBulkCandidate(candidate) && (selected.length === 0 || selected[0].code === candidate.code);

/** Все кандидаты параметра — для «выбрать все по параметру». */
export const bulkCandidatesOf = <T extends Pick<Finding, 'code' | 'status'>>(findings: T[], code: string): T[] =>
  findings.filter((f) => f.code === code && isBulkCandidate(f));

/** Комментарий решения для карточки: свой текст, а при подтверждении без текста — само решение, а не «нет комментария». */
export const decisionCommentText = (f: Pick<Finding, 'status' | 'inspector_comment'>): string =>
  f.inspector_comment?.trim() ||
  (f.status === 'confirmed' ? 'Подтверждено' : f.status === 'rejected' ? 'Отклонено' : f.status === 'clarification' ? 'Требует уточнения' : 'Без комментария');
