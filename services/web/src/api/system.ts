import { useQuery } from '@tanstack/react-query';
import { apiClient } from './client';
import type { components } from './schema';

export type HealthInfo = components['schemas']['Health'];
export type IntegrationStatus = components['schemas']['IntegrationStatus'];

/** `unreachable` — до сервера не достучались (сеть, порт), в отличие от `down` — сервер отвечает, что зависимость лежит. */
export type ApiHealth = { status: HealthInfo['status'] | 'unreachable'; dependencies?: HealthInfo['dependencies'] };

const REFRESH_MS = 30_000;

/** `GET /health`: живость api и его зависимостей, раз в 30 с. */
export const useHealth = (enabled: boolean) =>
  useQuery<ApiHealth>({
    queryKey: ['system-health'],
    enabled,
    refetchInterval: REFRESH_MS,
    retry: 0,
    queryFn: async () => {
      try {
        const { data, error } = await apiClient.GET('/health');
        return error || !data ? { status: 'unreachable' } : data;
      } catch {
        return { status: 'unreachable' };
      }
    },
  });

/** `GET /integration/status`: обмен с внешней ИС. Роль без доступа (403) получает `null` — плашка не показывается. */
export const useIntegrationStatus = (enabled: boolean) =>
  useQuery<IntegrationStatus | null>({
    queryKey: ['integration-status'],
    enabled,
    refetchInterval: REFRESH_MS,
    retry: 0,
    queryFn: async () => {
      try {
        const { data, error } = await apiClient.GET('/api/v1/integration/status');
        return error || !data ? null : data;
      } catch {
        return null;
      }
    },
  });

export type StatusLevel = 'ok' | 'warn' | 'bad' | 'off';

export interface StatusChip {
  key: 'api' | 'ml' | 'sync';
  label: string;
  level: StatusLevel;
  /** Подробности для подсказки. */
  detail: string;
}

export interface SystemInput {
  health?: ApiHealth;
  integration?: IntegrationStatus | null;
  /** Статусы разбора проверок (из списка проектов). */
  processStatuses: Array<string | null | undefined>;
}

const DEPENDENCY_LABEL: Record<string, string> = { db: 'база данных', storage: 'хранилище файлов' };

/** Сводка состояния системы для шапки: api, очередь разбора (ML) и обмен с внешней ИС. */
export const summarizeSystem = ({ health, integration, processStatuses }: SystemInput): StatusChip[] => {
  const chips: StatusChip[] = [];

  if (health) {
    const down = Object.entries(health.dependencies ?? {})
      .filter(([, state]) => state === 'down')
      .map(([name]) => DEPENDENCY_LABEL[name] ?? name);
    const list = down.length ? `: недоступно, ${down.join(', ')}` : '';
    if (health.status === 'ok') chips.push({ key: 'api', label: 'API', level: 'ok', detail: 'Сервер отвечает, база и хранилище доступны' });
    else if (health.status === 'degraded') chips.push({ key: 'api', label: 'API', level: 'warn', detail: `Сервер работает с ограничениями${list}` });
    else if (health.status === 'down') chips.push({ key: 'api', label: 'API', level: 'bad', detail: `Сервер сообщает о сбое${list}` });
    else chips.push({ key: 'api', label: 'API', level: 'bad', detail: 'Нет связи с сервером' });
  }

  const waiting = processStatuses.filter((s) => s === 'PENDING' || s === 'PARSING').length;
  const failed = processStatuses.filter((s) => s === 'FAILED').length;
  if (failed > 0) chips.push({ key: 'ml', label: 'Разбор', level: 'bad', detail: `Проверок с ошибкой разбора: ${failed}${waiting ? `, в работе: ${waiting}` : ''}` });
  else if (waiting > 0) chips.push({ key: 'ml', label: 'Разбор', level: 'warn', detail: `Проверок в работе: ${waiting}` });
  else chips.push({ key: 'ml', label: 'Разбор', level: 'ok', detail: 'Очередь разбора пуста, ошибок нет' });

  if (integration) {
    const name = integration.external_system;
    if (!integration.enabled) chips.push({ key: 'sync', label: name, level: 'off', detail: `Обмен с ${name} не настроен` });
    else if (integration.outbox.failed > 0) chips.push({ key: 'sync', label: name, level: 'bad', detail: `Не передано в ${name}: ${integration.outbox.failed}` });
    else if (integration.last_pull_error) chips.push({ key: 'sync', label: name, level: 'warn', detail: `Ошибка последнего забора документов: ${integration.last_pull_error}` });
    else if (integration.outbox.pending > 0) chips.push({ key: 'sync', label: name, level: 'warn', detail: `Ждёт отправки в ${name}: ${integration.outbox.pending}` });
    else chips.push({ key: 'sync', label: name, level: 'ok', detail: `Обмен с ${name} работает, очередь пуста` });
  }

  return chips;
};
