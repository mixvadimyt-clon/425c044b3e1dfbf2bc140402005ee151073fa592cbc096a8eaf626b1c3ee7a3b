import { describe, expect, it } from 'vitest';
import { retrainProjectIds } from './retrainQueue';

const item = (patch: Partial<Parameters<typeof retrainProjectIds>[0][number]>) => ({ projectId: 'p1', verdict: 'rejected' as const, status: 'pending' as const, ...patch });

describe('retrainProjectIds', () => {
  it('только проекты с записями набора, ждущими решения', () => {
    expect(retrainProjectIds([item({ projectId: 'a' })])).toEqual(['a']);
    // подтверждённое нарушение — тоже запись для дообучения (GOLD POSITIVE), её нужно одобрить или исключить
    expect(retrainProjectIds([item({ projectId: 'a', verdict: 'confirmed' })])).toEqual(['a']);
    // уже отправленное или пропущенное решение не ждёт больше
    expect(retrainProjectIds([item({ projectId: 'a', status: 'sent' })])).toEqual([]);
    expect(retrainProjectIds([item({ projectId: 'a', status: 'skipped' })])).toEqual([]);
  });

  it('сначала проекты с бо́льшим числом ждущих записей', () => {
    const items = [
      item({ projectId: 'a' }),
      item({ projectId: 'b' }),
      item({ projectId: 'b' }),
      item({ projectId: 'b' }),
    ];
    expect(retrainProjectIds(items)).toEqual(['b', 'a']);
  });

  it('без ждущих записей список пуст', () => {
    expect(retrainProjectIds([])).toEqual([]);
  });
});
