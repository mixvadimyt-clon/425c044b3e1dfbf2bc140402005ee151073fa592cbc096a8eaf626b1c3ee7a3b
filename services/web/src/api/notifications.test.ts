import { describe, expect, it } from 'vitest';
import { groupNotifications, hypothesesCountIn, isNotificationForRole } from './notifications';
import type { ApiNotification } from './notifications';

describe('hypothesesCountIn', () => {
  it('берёт число гипотез из текста о готовом протоколе', () => {
    expect(hypothesesCountIn('Протокол готов (версия 1): кандидатов 1, гипотез 3')).toBe(3);
  });

  it('без упоминания гипотез — ноль', () => {
    expect(hypothesesCountIn('Не удалось разобрать файл')).toBe(0);
  });
});

describe('isNotificationForRole', () => {
  it('ML-инженеру не нужны протоколы и запросы на откат, нужны записи для дообучения', () => {
    expect(isNotificationForRole('ML_ENGINEER', 'PROTOCOL_READY')).toBe(false);
    expect(isNotificationForRole('ML_ENGINEER', 'UNFINALIZE_REQUESTED')).toBe(false);
    expect(isNotificationForRole('ML_ENGINEER', 'RETRAIN_ITEM_PENDING')).toBe(true);
  });

  it('запрос на откат нужен администратору и супервизору, но не инспектору', () => {
    expect(isNotificationForRole('ADMIN', 'UNFINALIZE_REQUESTED')).toBe(true);
    expect(isNotificationForRole('SUPERVISOR', 'UNFINALIZE_REQUESTED')).toBe(true);
    expect(isNotificationForRole('INSPECTOR', 'UNFINALIZE_REQUESTED')).toBe(false);
  });

  it('инспектор получает готовые протоколы, записи для дообучения не получает; без роли показываем всё', () => {
    expect(isNotificationForRole('INSPECTOR', 'PROTOCOL_READY')).toBe(true);
    expect(isNotificationForRole('INSPECTOR', 'RETRAIN_ITEM_PENDING')).toBe(false);
    expect(isNotificationForRole(undefined, 'RETRAIN_ITEM_PENDING')).toBe(true);
  });
});

describe('groupNotifications', () => {
  const n = (id: string, over: Partial<ApiNotification> = {}): ApiNotification => ({
    id,
    type: 'PROTOCOL_READY',
    message: 'Протокол готов (версия 1): кандидатов 3, гипотез 0',
    object_id: 'o1',
    is_read: false,
    created_at: '2026-09-28T20:00:00Z',
    ...over,
  });

  it('одинаковые уведомления об одном проекте схлопываются, свежее остаётся сверху', () => {
    const groups = groupNotifications([n('a'), n('b', { is_read: true }), n('c')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ count: 3, ids: ['a', 'b', 'c'], unreadIds: ['a', 'c'] });
    expect(groups[0].latest.id).toBe('a');
  });

  it('разные проекты и разный текст не склеиваются', () => {
    const groups = groupNotifications([n('a'), n('b', { object_id: 'o2' }), n('c', { message: 'кандидатов 0' })]);
    expect(groups.map((g) => g.latest.id)).toEqual(['a', 'b', 'c']);
  });
});
