import { describe, expect, it } from 'vitest';
import { toProject, toProjectCounts, toProjectDocs } from './projects';

describe('toProjectDocs', () => {
  it('переводит статусы загрузки по стадиям в таблицу дашборда', () => {
    expect(toProjectDocs(['PD_UPLOADED', 'RD_PARTIAL', 'ID_MISSING'])).toEqual([
      { stage: 'ПД', loaded: true, partial: false },
      { stage: 'РД', loaded: true, partial: true },
      { stage: 'ИД', loaded: false, partial: false },
    ]);
  });

  it('без проверки все стадии «Нет»', () => {
    expect(toProjectDocs(undefined).every((d) => !d.loaded)).toBe(true);
  });
});

describe('toProject', () => {
  const object = {
    id: 'b41c3318-e707-4ac0-a351-c8a96ee68f1c',
    name: 'ЖК',
    address: 'г. Москва',
    customer: 'ООО Застройщик',
    contractor: undefined,
    permit_number: '77-1',
    indicator: 'GREEN' as const,
    created_at: '2026-09-19T10:05:00.000Z',
    updated_at: '2026-09-19T10:05:00.000Z',
    last_process_id: 'p-1',
    last_process_status: 'FINALIZED' as const,
  };

  it('сопоставляет поля контракта с полями проекта', () => {
    const project = toProject(object);
    expect(project).toMatchObject({
      id: object.id,
      name: 'ЖК',
      developer: 'ООО Застройщик',
      contractor: '',
      permit: '77-1',
      finalized: true,
      processId: 'p-1',
    });
    expect(project.updatedAt).toMatch(/^\d{2}\.\d{2}\.\d{2} \d{2}:\d{2}$/);
  });

  it('переносит светофор объекта', () => {
    expect(toProject({ ...object, indicator: 'RED' }).indicator).toBe('RED');
  });

  it('объект без проверок не считается финализированным', () => {
    expect(toProject({ ...object, last_process_id: null, last_process_status: null }).finalized).toBe(false);
  });
});

describe('toProjectCounts', () => {
  it('переносит счётчики проверки и «Соответствие»', () => {
    expect(
      toProjectCounts({ candidates_pending: 2, confirmed_violations: 1, clarification_required: 3, missing_evidence: 4, suspicions: 5, compliance_percent: 66.6 }),
    ).toEqual({ candidatesPending: 2, confirmedViolations: 1, clarificationRequired: 3, missingEvidence: 4, suspicions: 5, compliancePercent: 66.6 });
  });

  it('пустые поля — нули, а «Соответствие» без сопоставимых проверок — null', () => {
    expect(toProjectCounts({ compliance_percent: null })).toEqual({
      candidatesPending: 0,
      confirmedViolations: 0,
      clarificationRequired: 0,
      missingEvidence: 0,
      suspicions: 0,
      compliancePercent: null,
    });
  });

  it('без счётчиков (проверки не было) — undefined', () => {
    expect(toProjectCounts(undefined)).toBeUndefined();
  });
});
