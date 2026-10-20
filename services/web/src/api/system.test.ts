import { describe, expect, it } from 'vitest';
import { summarizeSystem } from './system';
import type { IntegrationStatus } from './system';

const integration = (over: Partial<IntegrationStatus> = {}): IntegrationStatus => ({
  enabled: true,
  external_system: 'ИАИС «РиН»',
  outbox: { pending: 0, synced: 3, failed: 0 },
  ...over,
});

const levels = (chips: ReturnType<typeof summarizeSystem>) => Object.fromEntries(chips.map((c) => [c.key, c.level]));

describe('сводка состояния системы', () => {
  it('всё работает: api, разбор и обмен зелёные', () => {
    const chips = summarizeSystem({ health: { status: 'ok' }, integration: integration(), processStatuses: ['COMPLETED', 'FINALIZED'] });
    expect(levels(chips)).toEqual({ api: 'ok', ml: 'ok', sync: 'ok' });
  });

  it('до сервера не достучались — api красный', () => {
    const chips = summarizeSystem({ health: { status: 'unreachable' }, processStatuses: [] });
    expect(chips[0]).toMatchObject({ key: 'api', level: 'bad', detail: 'Нет связи с сервером' });
  });

  it('зависимость лежит: в подсказке названа, а не код', () => {
    const chips = summarizeSystem({ health: { status: 'degraded', dependencies: { db: 'ok', storage: 'down' } }, processStatuses: [] });
    expect(chips[0].level).toBe('warn');
    expect(chips[0].detail).toContain('хранилище файлов');
  });

  it('разбор: в работе — жёлтый, ошибка разбора — красный и важнее очереди', () => {
    expect(levels(summarizeSystem({ processStatuses: ['PENDING', 'PARSING'] })).ml).toBe('warn');
    const failed = summarizeSystem({ processStatuses: ['PARSING', 'FAILED'] });
    expect(failed[0]).toMatchObject({ level: 'bad' });
    expect(failed[0].detail).toContain('в работе: 1');
  });

  it('обмен с внешней ИС: не передано — красный, ждёт — жёлтый, не настроен — серый', () => {
    const level = (over: Partial<IntegrationStatus>) => levels(summarizeSystem({ integration: integration(over), processStatuses: [] })).sync;
    expect(level({ outbox: { pending: 1, synced: 0, failed: 2 } })).toBe('bad');
    expect(level({ outbox: { pending: 2, synced: 0, failed: 0 } })).toBe('warn');
    expect(level({ last_pull_error: 'timeout' })).toBe('warn');
    expect(level({ enabled: false })).toBe('off');
  });

  it('роль без доступа к обмену (нет данных) — плашки обмена нет', () => {
    const chips = summarizeSystem({ health: { status: 'ok' }, integration: null, processStatuses: [] });
    expect(chips.map((c) => c.key)).toEqual(['api', 'ml']);
  });
});
