import { beforeEach, describe, expect, it } from 'vitest';
import { isWelcomeSeen, markWelcomeSeen, welcomeGuide } from './welcome';

describe('welcomeGuide', () => {
  it('у каждой роли есть шаги с названием и описанием', () => {
    for (const role of ['INSPECTOR', 'SUPERVISOR', 'ADMIN', 'ML_ENGINEER'] as const) {
      expect(welcomeGuide(role).steps.length).toBeGreaterThanOrEqual(3);
      for (const step of welcomeGuide(role).steps) expect(step.text.length).toBeGreaterThan(20);
    }
  });
});

describe('isWelcomeSeen', () => {
  beforeEach(() => window.localStorage.clear());

  it('до закрытия подсказка не считается прочитанной', () => {
    expect(isWelcomeSeen('inspector')).toBe(false);
  });

  it('после закрытия помнит выбор для этого пользователя, но не для другого', () => {
    markWelcomeSeen('inspector');
    expect(isWelcomeSeen('inspector')).toBe(true);
    expect(isWelcomeSeen('admin')).toBe(false);
  });
});
