import { describe, expect, it } from 'vitest';
import { MlApiError, failedChecksOf, isoWeekOf, shiftIsoWeek, suggestNextVersion } from './ml';

describe('isoWeekOf', () => {
  it('считает ISO-неделю', () => {
    expect(isoWeekOf(new Date(2026, 8, 24))).toBe('2026-W39');
    expect(isoWeekOf(new Date(2026, 0, 1))).toBe('2026-W01');
    expect(isoWeekOf(new Date(2021, 0, 3))).toBe('2020-W53');
  });
});

describe('shiftIsoWeek', () => {
  it('двигает неделю через границу года', () => {
    expect(shiftIsoWeek('2026-W01', -1)).toBe('2025-W52');
    expect(shiftIsoWeek('2025-W52', 1)).toBe('2026-W01');
    expect(shiftIsoWeek('2026-W38', 1)).toBe('2026-W39');
  });

  it('неверный формат возвращает как есть', () => {
    expect(shiftIsoWeek('вчера', 1)).toBe('вчера');
  });
});

describe('suggestNextVersion', () => {
  const now = new Date(2026, 8, 24);
  it('первая версия месяца', () => {
    expect(suggestNextVersion([], now)).toBe('ds-2026.09.1');
    expect(suggestNextVersion([{ version: 'ds-2026.08.4' }], now)).toBe('ds-2026.09.1');
  });

  it('следующий номер после самого большого', () => {
    expect(suggestNextVersion([{ version: 'ds-2026.09.1' }, { version: 'ds-2026.09.3' }], now)).toBe('ds-2026.09.4');
  });
});

describe('failedChecksOf', () => {
  it('берёт непройденные проверки из details.failed', () => {
    const error = new MlApiError('Проверки не пройдены', 'THRESHOLDS_FAILED', { failed: ['recall ниже 0,9', { message: 'FPR выше 0,05' }] });
    expect(failedChecksOf(error)).toEqual(['recall ниже 0,9', 'FPR выше 0,05']);
  });

  it('другие ошибки не трогает', () => {
    expect(failedChecksOf(new MlApiError('нет', 'INVALID_STATUS'))).toEqual([]);
    expect(failedChecksOf(new Error('x'))).toEqual([]);
  });
});
