import { useQuery } from '@tanstack/react-query';
import { apiClient } from './client';
import type { components } from './schema';

export type AuditEntry = components['schemas']['AuditEntry'];

/** `GET /audit` по одному действию (читают ADMIN и SUPERVISOR); для откатов финализации — `unfinalizeProcess`, причина в `details.reason`. */
export const useAuditByAction = (action: string, enabled: boolean) =>
  useQuery({
    queryKey: ['audit', action],
    enabled,
    staleTime: 0,
    queryFn: async () => {
      const { data, error } = await apiClient.GET('/api/v1/audit', { params: { query: { action, page_size: 100 } } });
      if (error || !data) throw new Error('Не удалось загрузить журнал аудита');
      return data.items;
    },
  });

/** `GET /audit` целиком, с необязательным фильтром по типу исполнителя (читают ADMIN и SUPERVISOR). */
export const useAudit = (actorType: 'USER' | 'SYSTEM' | undefined, enabled: boolean) =>
  useQuery({
    queryKey: ['audit', 'all', actorType],
    enabled,
    staleTime: 0,
    queryFn: async () => {
      const { data, error } = await apiClient.GET('/api/v1/audit', { params: { query: { actor_type: actorType, page_size: 100 } } });
      if (error || !data) throw new Error('Не удалось загрузить журнал аудита');
      return data.items;
    },
  });

/** Фильтры `GET /audit`, которые считает сервер (ADMIN и SUPERVISOR). */
export interface AuditFilters {
  actorType?: 'USER' | 'SYSTEM';
  objectId?: string;
  action?: string;
  /** ISO-дата и время начала и конца периода. */
  dateFrom?: string;
  dateTo?: string;
}

const auditQueryOf = (filters: AuditFilters, page: number, pageSize: number) => ({
  actor_type: filters.actorType,
  object_id: filters.objectId,
  action: filters.action,
  date_from: filters.dateFrom,
  date_to: filters.dateTo,
  page,
  page_size: pageSize,
});

/** Одна страница журнала с фильтрами; пока грузится следующая, остаётся предыдущая, таблица не мигает. */
export const useAuditPage = (filters: AuditFilters, page: number, pageSize: number) =>
  useQuery({
    queryKey: ['audit', 'page', filters, page, pageSize],
    staleTime: 0,
    placeholderData: (previous) => previous,
    queryFn: async () => {
      const { data, error } = await apiClient.GET('/api/v1/audit', { params: { query: auditQueryOf(filters, page, pageSize) } });
      if (error || !data) throw new Error('Не удалось загрузить журнал аудита');
      return data;
    },
  });

/** Весь журнал по фильтрам для выгрузки: страницами по 200, не больше `cap` записей. */
export const fetchAuditAll = async (filters: AuditFilters, cap = 5000): Promise<{ items: AuditEntry[]; total: number }> => {
  const items: AuditEntry[] = [];
  let total = 0;
  for (let page = 1; items.length < cap; page += 1) {
    const { data, error } = await apiClient.GET('/api/v1/audit', { params: { query: auditQueryOf(filters, page, 200) } });
    if (error || !data) throw new Error('Не удалось загрузить журнал аудита для выгрузки');
    total = data.total;
    items.push(...data.items);
    if (data.items.length === 0 || items.length >= data.total) break;
  }
  return { items: items.slice(0, cap), total };
};

/** Причина из журнала: сервер кладёт её в `details.reason`. */
export const reasonOf = (entry: AuditEntry): string => {
  const reason = (entry.details as { reason?: unknown } | undefined)?.reason;
  return typeof reason === 'string' ? reason : '';
};

/**
 * Объект действия для колонки «Объект»: у процессов это имя проекта (по `object_id`), у остальных сущностей
 * (параметр, правило, документ) — то, что действительно опознаёт запись, `object_id` у них не заполняется.
 */
export const auditObjectOf = (entry: AuditEntry, projectNames: Map<string, string>): string => {
  if (entry.object_id) return projectNames.get(entry.object_id) ?? 'нет';
  const details = entry.details as Record<string, unknown> | undefined;
  const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  switch (entry.entity_type) {
    case 'param':
      return text(entry.entity_id) ? `Параметр ${entry.entity_id}` : 'нет';
    case 'logical_rule':
      return text(details?.rule_name) ?? 'Правило';
    case 'normative_doc':
      return text(details?.document_name) ?? 'Документ';
    default:
      return 'нет';
  }
};

/** Детали действия для колонки «Детали»: причина (откат), иначе то немногое по смыслу действия, что есть в `details`. */
export const auditDetailsOf = (entry: AuditEntry): string => {
  const reason = reasonOf(entry);
  if (reason) return reason;
  const details = entry.details as Record<string, unknown> | undefined;
  if (!details) return 'нет';
  const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  switch (entry.action) {
    case 'login':
      return details.success === false ? `Неудачная попытка входа: ${text(details.login) ?? 'нет'}` : 'нет';
    case 'createLogicalRule':
    case 'updateLogicalRule':
      return [text(details.condition), text(details.expected)].filter(Boolean).join(' → ') || 'нет';
    case 'createNormativeDoc':
    case 'updateNormativeDoc':
      return text(details.document_number) ? `№ ${details.document_number}` : 'нет';
    case 'updateParam':
    case 'deactivateParam':
    case 'activateParam':
      return text(details.matrix_version) ? `Версия матрицы: ${details.matrix_version}` : 'нет';
    default:
      return 'нет';
  }
};
