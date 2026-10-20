import type { components } from './schema';
import { API_URL } from './client';

export type UploadResponse = components['schemas']['UploadResponse'];
export type UploadedFileResult = components['schemas']['UploadedFileResult'];
export type RegistryIssue = components['schemas']['RegistryIssue'];
type ApiError = components['schemas']['Error'];


export const MAX_FILE_MB = 50;
export const MAX_BATCH_MB = 200;
export const ALLOWED_EXTENSIONS = ['pdf', 'docx', 'xml'];
export const ALLOWED_REGISTRY_EXTENSIONS = ['csv', 'xlsx', 'json'];

export type ApiStage = 'PD' | 'RD' | 'ID';

export interface UploadRequest {
  files: Array<{ file: File; stage?: ApiStage }>;
  registry?: File;
  /** Дозагрузка в существующую проверку; без него создаётся новая для `objectId`. */
  processId?: string | null;
  objectId?: string;
}

export class UploadFailedError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

const extensionOf = (name: string): string => name.split('.').pop()?.toLowerCase() ?? '';

/** Клиентская проверка формата и размера файла (REQ-UPL-01..05); `null` — файл подходит. */
/** Ошибки строк реестра из ответа REGISTRY_INVALID (с номерами строк). */
export const registryErrorsOf = (error: unknown): string[] => {
  if (!(error instanceof UploadFailedError) || error.code !== 'REGISTRY_INVALID') return [];
  const list = (error.details as { errors?: unknown[] } | undefined)?.errors;
  return Array.isArray(list) ? list.map(String) : [];
};

/** Путь файла внутри выбранной папки («Комплект/РД/АР.pdf»); у отдельно выбранного файла — пусто. */
export const folderPathOf = (file: File): string => (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';

/** Архив .zip: api раскрывает его сам, стадию берёт по папкам внутри. */
export const isArchive = (file: File): boolean => extensionOf(file.name) === 'zip';

export const validateFile = (file: File, allowed: string[] = ALLOWED_EXTENSIONS): string | null => {
  // Файлы из папки (реестр, DWG, картинки) и архив не фильтруем по формату: решает api. Архив ограничен пакетом.
  const passthrough = allowed === ALLOWED_EXTENSIONS && (folderPathOf(file) !== '' || isArchive(file));
  if (!passthrough && !allowed.includes(extensionOf(file.name))) return `«${file.name}»: допустимы ${allowed.map((e) => e.toUpperCase()).join(', ')}`;
  const limitMb = allowed === ALLOWED_EXTENSIONS && isArchive(file) ? MAX_BATCH_MB : MAX_FILE_MB;
  if (file.size > limitMb * 1024 * 1024) return `«${file.name}»: больше ${limitMb} МБ`;
  return null;
};

/** Общий размер пакета ≤ 200 МБ. */
export const batchTooLarge = (files: File[]): boolean => files.reduce((sum, f) => sum + f.size, 0) > MAX_BATCH_MB * 1024 * 1024;

/**
 * POST /documents/upload с индикацией отправки. Отдельный XHR, а не openapi-fetch:
 * fetch не сообщает, сколько байт уже ушло.
 */
export const uploadDocuments = (request: UploadRequest, onProgress?: (percent: number) => void): Promise<UploadResponse> =>
  new Promise((resolve, reject) => {
    const form = new FormData();
    if (request.processId) form.append('process_id', request.processId);
    else if (request.objectId) form.append('object_id', request.objectId);
    form.append('auto_start', 'true');

    const hints: Record<string, ApiStage> = {};
    for (const { file, stage } of request.files) {
      // Для файла из папки в имени — путь: по папкам api определяет стадию
      form.append('files', file, folderPathOf(file) || file.name);
      if (stage) hints[file.name] = stage;
    }
    if (Object.keys(hints).length > 0) form.append('stage_hints', JSON.stringify(hints));
    if (request.registry) form.append('registry', request.registry, request.registry.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_URL}/api/v1/documents/upload`);
    const token = localStorage.getItem('auth_token');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onerror = () => reject(new UploadFailedError('Нет связи с сервером', 0));
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* не JSON — сообщим общим текстом */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as UploadResponse);
        return;
      }
      if (xhr.status === 401) {
        localStorage.removeItem('auth_token');
        localStorage.removeItem('user');
        window.location.href = '/login';
      }
      const error = body as Partial<ApiError> | null;
      reject(new UploadFailedError(error?.message ?? `Ошибка загрузки (${xhr.status})`, xhr.status, error?.code, error?.details));
    };
    xhr.send(form);
  });

export type RegistryApplyResult = components['schemas']['RegistryApplyResult'];

/** POST /processes/{id}/registry — загрузить или заменить реестр без новых файлов. */
export const uploadRegistry = async (processId: string, registry: File): Promise<RegistryApplyResult> => {
  const form = new FormData();
  form.append('registry', registry, registry.name);
  form.append('auto_start', 'true');
  const token = localStorage.getItem('auth_token');
  const response = await fetch(`${API_URL}/api/v1/processes/${processId}/registry`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });
  const body = (await response.json().catch(() => null)) as (RegistryApplyResult & Partial<ApiError>) | null;
  if (!response.ok) {
    throw new UploadFailedError(body?.message ?? `Ошибка загрузки реестра (${response.status})`, response.status, body?.code, body?.details);
  }
  return body as RegistryApplyResult;
};
