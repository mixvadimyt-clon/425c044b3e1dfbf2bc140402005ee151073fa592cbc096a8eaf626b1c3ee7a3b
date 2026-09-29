import { describe, expect, it } from 'vitest';
import { findingStatusView } from './statuses';

describe('findingStatusView', () => {
  it('«нарушения нет» от движка без решения инспектора не называется отклонением', () => {
    expect(findingStatusView('NEGATIVE_VERIFIED', false)).toEqual({ label: 'Нарушения нет', color: 'success' });
  });

  it('отклонение инспектора остаётся отклонением', () => {
    expect(findingStatusView('NEGATIVE_VERIFIED', true).label).toBe('Отклонено');
  });

  it('остальные статусы не меняются', () => {
    expect(findingStatusView('CANDIDATE', false).label).toBe('Кандидат');
    expect(findingStatusView('CONFIRMED_VIOLATION', true).label).toBe('Подтверждено');
  });
});
