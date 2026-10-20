import { useQuery } from '@tanstack/react-query';
import { apiClient } from './client';
import type { components } from './schema';

export type ProcessInfo = components['schemas']['ProcessInfo'];
export type ProcessStatusInfo = components['schemas']['ProcessStatusInfo'];
export type FileInfo = components['schemas']['FileInfo'];
export type CompletenessSummary = components['schemas']['CompletenessSummary'];

const POLL_INTERVAL_MS = 2000;

/** Пока проверка в работе, интерфейс опрашивает статус раз в 2 с (REQ-STK-06). */
export const isProcessBusy = (status: string | undefined): boolean => status === 'PENDING' || status === 'PARSING';

/** Разбор считаем зависшим, если статус не менялся дольше {@link STALL_THRESHOLD_MS}: сервер пока не умеет сам возвращать зависшую задачу в работу. */
export const STALL_THRESHOLD_MS = 5 * 60 * 1000;

export const isProcessStalled = (updatedAt: string | undefined, now: number, thresholdMs = STALL_THRESHOLD_MS): boolean => {
  if (!updatedAt) return false;
  const updatedAtMs = new Date(updatedAt).getTime();
  if (Number.isNaN(updatedAtMs)) return false;
  return now - updatedAtMs > thresholdMs;
};

export const useProcessStatus = (processId: string | null | undefined) =>
  useQuery({
    queryKey: ['process-status', processId],
    enabled: Boolean(processId),
    staleTime: 0,
    queryFn: async () => {
      const { data, error } = await apiClient.GET('/api/v1/processes/{process_id}/status', { params: { path: { process_id: processId! } } });
      if (error || !data) throw new Error('Не удалось получить статус проверки');
      return data;
    },
    refetchInterval: (query) => (isProcessBusy(query.state.data?.status) ? POLL_INTERVAL_MS : false),
  });

export const useProcess = (processId: string | null | undefined, refreshKey?: string) =>
  useQuery({
    queryKey: ['process', processId, refreshKey],
    enabled: Boolean(processId),
    staleTime: 0,
    queryFn: async () => {
      const { data, error } = await apiClient.GET('/api/v1/processes/{process_id}', { params: { path: { process_id: processId! } } });
      if (error || !data) throw new Error('Не удалось получить проверку');
      return data;
    },
  });

export const useProcessFiles = (processId: string | null | undefined, refreshKey?: string) =>
  useQuery({
    queryKey: ['process-files', processId, refreshKey],
    enabled: Boolean(processId),
    staleTime: 0,
    queryFn: async () => {
      const { data, error } = await apiClient.GET('/api/v1/processes/{process_id}/files', { params: { path: { process_id: processId! } } });
      if (error || !data) throw new Error('Не удалось получить список файлов');
      return data;
    },
  });

export type FileMetadataPatch = components['schemas']['FileMetadataPatch'];

/** PATCH /files/{id}: выбор эталонной редакции или связь с предыдущей — только с основанием. */
export const patchFile = async (fileId: string, body: FileMetadataPatch): Promise<FileInfo> => {
  const { data, error } = await apiClient.PATCH('/api/v1/files/{file_id}', { params: { path: { file_id: fileId } }, body });
  if (error || !data) throw new Error(error?.message ?? 'Не удалось сохранить выбор редакции');
  return data;
};
