import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '@/api/audit';
import { auditToCsv, csvCell } from './auditCsv';

const entry = (patch: Partial<AuditEntry>): AuditEntry => ({ id: '1', action: 'login', timestamp: '2026-09-25T18:02:00.000Z', ...patch }) as AuditEntry;

describe('csvCell', () => {
  it('значение без спецсимволов оставляет как есть', () => {
    expect(csvCell('Иванов Иван')).toBe('Иванов Иван');
  });

  it('значение с разделителем, кавычкой или переносом берёт в кавычки и удваивает кавычки', () => {
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('он сказал "да"')).toBe('"он сказал ""да"""');
    expect(csvCell('строка 1\nстрока 2')).toBe('"строка 1\nстрока 2"');
  });
});

describe('auditToCsv', () => {
  it('начинается с BOM и заголовка, строки разделены переводом строки', () => {
    const csv = auditToCsv([entry({ user_name: 'Иванов Иван', user_role: 'INSPECTOR' })], new Map());
    expect(csv.startsWith(String.fromCharCode(0xfeff) + 'Время;Кто;Роль;Действие;Проект;Детали\r\n')).toBe(true);
    expect(csv.split('\r\n')).toHaveLength(3);
  });

  it('действие системы подписано «Система», пустые «нет» превращаются в пустые ячейки', () => {
    const csv = auditToCsv([entry({ action: 'system.parse', actor_type: 'SYSTEM' })], new Map());
    const row = csv.split('\r\n')[1].split(';');
    expect(row[1]).toBe('Система');
    expect(row[3]).toBe('system.parse');
    expect(row[4]).toBe('');
    expect(row[5]).toBe('');
  });
});
