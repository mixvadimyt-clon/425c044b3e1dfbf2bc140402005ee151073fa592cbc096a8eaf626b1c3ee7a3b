import type { AuditEntry } from '@/api/audit';
import { auditDetailsOf, auditObjectOf } from '@/api/audit';
import { formatDateTime } from '@/api/protocols';

/** Ячейка CSV: кавычки удваиваем, значение берём в кавычки, если в нём есть разделитель, кавычка или перенос строки. */
export const csvCell = (value: string): string => (/[";\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

// Метка порядка байтов: без неё Excel открывает UTF-8 как «крякозябры»
const BOM = String.fromCharCode(0xfeff);
const HEADER = ['Время', 'Кто', 'Роль', 'Действие', 'Проект', 'Детали'];

/**
 * Журнал аудита в CSV для Excel: разделитель «;» (так открывает русская локаль), в начале BOM, чтобы кириллица не ломалась.
 * Пустое «нет» из интерфейса в файл не попадает: пустая ячейка честнее.
 */
export const auditToCsv = (entries: AuditEntry[], projectNames: Map<string, string>): string => {
  const empty = (text: string) => (text === 'нет' ? '' : text);
  const rows = entries.map((e) =>
    [
      formatDateTime(e.timestamp),
      e.actor_type === 'SYSTEM' ? 'Система' : (e.user_name ?? ''),
      e.user_role ?? '',
      e.action,
      empty(auditObjectOf(e, projectNames)),
      empty(auditDetailsOf(e)),
    ]
      .map(csvCell)
      .join(';'),
  );
  const CRLF = String.fromCharCode(13, 10);
  return BOM + [HEADER.join(';'), ...rows].join(CRLF) + CRLF;
};
