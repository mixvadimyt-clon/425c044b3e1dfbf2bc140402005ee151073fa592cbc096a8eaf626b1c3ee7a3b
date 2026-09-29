import { describe, expect, it } from 'vitest';
import { checkGroupOf, nextAction } from './nextAction';
import type { Project } from './projects';

const project = (patch: Partial<Project>): Project => ({
  id: 'p', name: 'P', address: '', developer: '', contractor: '', permit: '', docs: [], updatedAt: '', ...patch,
});

describe('nextAction', () => {
  it('без проверки предлагает загрузить документы', () => {
    expect(nextAction(project({ processStatus: null })).target).toBe('upload');
  });

  it('с кандидатами без решения ведёт в верификацию и показывает число', () => {
    const action = nextAction(project({ processStatus: 'COMPLETED', counts: { candidatesPending: 34, confirmedViolations: 0, clarificationRequired: 0, missingEvidence: 0, suspicions: 0, compliancePercent: 50 } }));
    expect(action.target).toBe('verification');
    expect(action.label).toContain('34');
  });

  it('когда решения приняты, предлагает завершить проверку', () => {
    expect(nextAction(project({ processStatus: 'COMPLETED', counts: { candidatesPending: 0, confirmedViolations: 1, clarificationRequired: 0, missingEvidence: 0, suspicions: 0, compliancePercent: 90 } })).target).toBe('protocol');
  });

  it('у финализированного действий нет', () => {
    expect(nextAction(project({ finalized: true })).priority).toBeNull();
  });
});

describe('checkGroupOf', () => {
  const counts = (pending: number) => ({ candidatesPending: pending, confirmedViolations: 0, clarificationRequired: 0, missingEvidence: 0, suspicions: 0, compliancePercent: null });

  it('раскладывает проекты по группам колонки «Проверка»', () => {
    expect(checkGroupOf(project({ processStatus: 'FAILED' }))).toBe('failed');
    expect(checkGroupOf(project({ processStatus: 'PARSING' }))).toBe('parsing');
    expect(checkGroupOf(project({ processStatus: null }))).toBe('none');
    expect(checkGroupOf(project({ processStatus: 'COMPLETED', counts: counts(4) }))).toBe('pending');
    expect(checkGroupOf(project({ processStatus: 'COMPLETED', counts: counts(0) }))).toBe('ready');
  });
});
