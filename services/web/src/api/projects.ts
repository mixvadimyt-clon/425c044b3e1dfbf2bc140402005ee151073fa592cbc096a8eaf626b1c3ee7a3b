import { API_URL, apiClient } from './client';
import type { components } from './schema';
import type { Project, ProjectCounts, ProjectDoc } from '@/shared/projects';

type ObjectInfo = components['schemas']['ObjectInfo'];
type FindingCounts = components['schemas']['FindingCounts'];
type ProcessInfo = components['schemas']['ProcessInfo'];
type ObjectCreate = components['schemas']['ObjectCreate'];

const STAGES: Array<{ code: 'PD' | 'RD' | 'ID'; label: ProjectDoc['stage'] }> = [
  { code: 'PD', label: 'ПД' },
  { code: 'RD', label: 'РД' },
  { code: 'ID', label: 'ИД' },
];

const formatUpdatedAt = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${String(date.getFullYear()).slice(2)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** `PD_UPLOADED` / `PD_PARTIAL` / `PD_MISSING` → состояние стадии для таблицы дашборда. */
export const toProjectDocs = (uploadStatus: ProcessInfo['upload_status'] | undefined): ProjectDoc[] =>
  STAGES.map(({ code, label }) => {
    const status = uploadStatus?.find((s) => s.startsWith(`${code}_`));
    return { stage: label, loaded: status === `${code}_UPLOADED` || status === `${code}_PARTIAL`, partial: status === `${code}_PARTIAL` };
  });

/** `FindingCounts` объекта → счётчики строки дашборда; без счётчиков (проверки ещё не было) — `undefined`. */
export const toProjectCounts = (counts: FindingCounts | undefined): ProjectCounts | undefined =>
  counts && {
    candidatesPending: counts.candidates_pending ?? 0,
    confirmedViolations: counts.confirmed_violations ?? 0,
    clarificationRequired: counts.clarification_required ?? 0,
    missingEvidence: counts.missing_evidence ?? 0,
    suspicions: counts.suspicions ?? 0,
    compliancePercent: counts.compliance_percent ?? null,
  };

export const toProject = (object: ObjectInfo, process?: ProcessInfo): Project => ({
  id: object.id,
  name: object.name,
  address: object.address ?? '',
  developer: object.customer ?? '',
  contractor: object.contractor ?? '',
  permit: object.permit_number ?? '',
  docs: toProjectDocs(process?.upload_status),
  updatedAt: formatUpdatedAt(object.updated_at ?? object.created_at),
  finalized: object.last_process_status === 'FINALIZED',
  processId: object.last_process_id ?? null,
  processStatus: object.last_process_status ?? null,
  indicator: object.indicator,
  counts: toProjectCounts(object.counts),
});

/** Объекты и их последние проверки: две выборки, склеенные по `last_process_id`. */
export const fetchProjects = async (): Promise<Project[]> => {
  const objects = await apiClient.GET('/api/v1/objects', { params: { query: { page_size: 200 } } });
  if (objects.error || !objects.data) throw new Error('Не удалось загрузить список проектов');

  const processes = await apiClient.GET('/api/v1/processes', { params: { query: { page_size: 200 } } });
  const byId = new Map<string, ProcessInfo>((processes.data?.items ?? []).map((p) => [p.process_id, p]));

  return objects.data.items.map((object) => toProject(object, object.last_process_id ? byId.get(object.last_process_id) : undefined));
};

export const createObject = async (body: ObjectCreate): Promise<ObjectInfo> => {
  const { data, error } = await apiClient.POST('/api/v1/objects', { body });
  if (error || !data) throw new Error(error?.message ?? 'Не удалось создать проект');
  return data;
};

export type ObjectPatch = components['schemas']['ObjectPatch'];

/** PATCH /objects/{id}: реквизиты (название, адрес, застройщик, подрядчик, номер разрешения). У финализированной проверки 409. */
export const patchObject = async (id: string, body: ObjectPatch): Promise<ObjectInfo> => {
  const { data, error } = await apiClient.PATCH('/api/v1/objects/{object_id}', { params: { path: { object_id: id } }, body });
  if (error || !data) throw new Error((error as { message?: string } | undefined)?.message ?? 'Не удалось сохранить реквизиты');
  return data;
};


/** Сервер ещё не умеет удалять объекты (в контракте нет DELETE /objects/{id}). */
export class DeleteNotSupportedError extends Error {}

/**
 * DELETE /objects/{id}. Эндпоинта в контракте пока нет,
 * поэтому вызов не типизирован из схемы: 404 и 405 означают «сервер не умеет».
 */
export const deleteObject = async (objectId: string): Promise<void> => {
  const token = localStorage.getItem('auth_token');
  let response: Response;
  try {
    response = await fetch(`${API_URL}/api/v1/objects/${objectId}`, {
      method: 'DELETE',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
  } catch {
    // Браузер отменяет DELETE, если api не разрешил метод в CORS; отличить это от обрыва связи нельзя
    throw new DeleteNotSupportedError('Не удалось удалить проект: сервер недоступен или пока не поддерживает удаление');
  }
  if (response.ok) return;
  const body = (await response.json().catch(() => null)) as { code?: string; message?: string } | null;
  // Fastify отвечает 404 на неизвестный маршрут без нашего кода NOT_FOUND
  if (response.status === 405 || (response.status === 404 && body?.code !== 'NOT_FOUND')) throw new DeleteNotSupportedError('Удаление проектов на сервере пока недоступно');
  throw new Error(body?.message ?? `Не удалось удалить проект (${response.status})`);
};
