import { API_URL } from './client';
import type { FileInfo } from './processes';

/** Открепленная подпись: `.sig`, `.p7s`, `.sgn` до 256 КБ (`POST /files/{id}/signature`). */
export const SIGNATURE_EXTENSIONS = ['.sig', '.p7s', '.sgn'] as const;
export const SIGNATURE_MAX_BYTES = 256 * 1024;

/** Текст для подсказок: подпись принимается и хранится, проверки к сдаче нет (доступа к УКЭП не дают, `verification` всегда `NOT_VERIFIED`). */
export const SIGNATURE_NOT_VERIFIED_NOTE = 'Файл подписи принимается и хранится. Проверка подписи не выполняется, она появится в следующей версии.';

/** Проверка выбранного файла подписи до отправки: расширение и размер. */
export const validateSignatureFile = (file: Pick<File, 'name' | 'size'>): string | null => {
  const name = file.name.toLowerCase();
  if (!SIGNATURE_EXTENSIONS.some((ext) => name.endsWith(ext))) return `Ожидается открепленная подпись: ${SIGNATURE_EXTENSIONS.join(', ')}`;
  if (file.size > SIGNATURE_MAX_BYTES) return `Файл подписи больше ${SIGNATURE_MAX_BYTES / 1024} КБ`;
  if (file.size === 0) return 'Файл подписи пустой';
  return null;
};

/** Размер файла для людей: «312 Б», «2,1 КБ». */
export const formatFileSize = (bytes: number): string => (bytes < 1024 ? `${bytes} Б` : `${(bytes / 1024).toFixed(1).replace('.', ',')} КБ`);

const ERROR_TEXT: Record<number, string> = {
  404: 'Файл не найден',
  409: 'Проверка финализирована: подпись приложить нельзя',
  413: `Файл подписи больше ${SIGNATURE_MAX_BYTES / 1024} КБ`,
};

/** `POST /files/{file_id}/signature`: приложить (или заменить) файл подписи; в ответе карточка файла с полем `signature`. */
export const attachSignature = async (fileId: string, file: File): Promise<FileInfo> => {
  const form = new FormData();
  form.append('signature', file, file.name);
  const token = localStorage.getItem('auth_token');
  let response: Response;
  try {
    response = await fetch(`${API_URL}/api/v1/files/${fileId}/signature`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: form,
    });
  } catch {
    throw new Error('Нет связи с сервером');
  }
  const body = (await response.json().catch(() => null)) as (FileInfo & { message?: string }) | null;
  if (!response.ok) throw new Error(body?.message ?? ERROR_TEXT[response.status] ?? `Не удалось приложить подпись (${response.status})`);
  return body as FileInfo;
};
