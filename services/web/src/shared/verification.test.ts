import { describe, expect, it } from 'vitest';
import { REJECT_TEMPLATES, bulkCandidatesOf, canSelectForBulk, isAwaitingDecision, isBulkCandidate } from './verification';
import { REJECT_REASON } from './statuses';

describe('шаблоны комментариев решения', () => {
  it('для каждой причины отклонения есть непустой шаблон', () => {
    for (const key of Object.keys(REJECT_REASON)) {
      expect(REJECT_TEMPLATES[key as keyof typeof REJECT_REASON].trim().length).toBeGreaterThan(10);
    }
  });
});

describe('запись ждёт решения инспектора', () => {
  it('кандидат и «требуется уточнение» от модели ждут, решённые и уточнения инспектора нет', () => {
    expect(isAwaitingDecision({ status: 'CANDIDATE' })).toBe(true);
    expect(isAwaitingDecision({ status: 'clarification', modelClarification: true })).toBe(true);
    expect(isAwaitingDecision({ status: 'clarification' })).toBe(false);
    expect(isAwaitingDecision({ status: 'confirmed' })).toBe(false);
    expect(isAwaitingDecision({ status: 'rejected', modelClarification: true })).toBe(false);
  });
});

describe('массовое решение', () => {
  const f = (code: string, status: 'CANDIDATE' | 'confirmed') => ({ code, status });

  it('после первой отметки доступен только тот же параметр', () => {
    expect(canSelectForBulk([], f('M-055', 'CANDIDATE'))).toBe(true);
    expect(canSelectForBulk([f('M-055', 'CANDIDATE')], f('M-055', 'CANDIDATE'))).toBe(true);
    expect(canSelectForBulk([f('M-055', 'CANDIDATE')], f('M-002', 'CANDIDATE'))).toBe(false);
  });

  it('отмечать можно только кандидатов без решения', () => {
    expect(canSelectForBulk([], f('M-055', 'confirmed'))).toBe(false);
    expect(isBulkCandidate(f('M-055', 'CANDIDATE'))).toBe(true);
  });

  it('«выбрать все по параметру»: кандидаты этого параметра, решённые и чужие не попадают', () => {
    const all = [f('M-055', 'CANDIDATE'), f('M-055', 'confirmed'), f('M-055', 'CANDIDATE'), f('M-002', 'CANDIDATE')];
    expect(bulkCandidatesOf(all, 'M-055')).toHaveLength(2);
  });
});
