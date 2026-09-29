import { describe, expect, it } from 'vitest';
import { toStageComparisons } from './stageComparisons';

describe('toStageComparisons', () => {
  it('строит строки по стадиям, значение берёт как в документе', () => {
    const rows = toStageComparisons([
      { stage: 'RD', value: '7862.5', raw_value: '7 862,5', delta: '+12.5 (+0.16 %)', triggered: false, verdict: 'Отклонение 0.16 % не больше порога 1 %' },
      { stage: 'ID', value: '8105.3', delta: null, triggered: true, verdict: null },
    ]);
    expect(rows).toEqual([
      { stage: 'РД', value: '7 862,5', delta: '+12.5 (+0.16 %)', triggered: false, verdict: 'Отклонение 0.16 % не больше порога 1 %' },
      { stage: 'ИД', value: '8105.3', delta: undefined, triggered: true, verdict: undefined },
    ]);
  });

  it('пусто у протоколов до 0.17.0 и когда стадия одна', () => {
    expect(toStageComparisons(undefined)).toEqual([]);
    expect(toStageComparisons([])).toEqual([]);
    expect(toStageComparisons([{ stage: 'RD', value: '1', triggered: true }])).toEqual([]);
  });
});
