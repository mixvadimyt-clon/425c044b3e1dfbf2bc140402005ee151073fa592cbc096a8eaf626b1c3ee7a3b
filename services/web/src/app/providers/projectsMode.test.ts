import { describe, expect, it } from 'vitest';
import { computeProjectsMode } from './projectsMode';

describe('computeProjectsMode', () => {
  it('демо-режим побеждает всё остальное', () => {
    expect(computeProjectsMode({ demoMode: true, hasData: false, dataUpdatedAt: 0, errorUpdatedAt: 100 })).toBe('demo');
  });

  it('успешный запрос без ошибок — live', () => {
    expect(computeProjectsMode({ demoMode: false, hasData: true, dataUpdatedAt: 100, errorUpdatedAt: 0 })).toBe('live');
  });

  it('первый запрос упал без кеша — offline', () => {
    expect(computeProjectsMode({ demoMode: false, hasData: false, dataUpdatedAt: 0, errorUpdatedAt: 100 })).toBe('offline');
  });

  it('фоновое обновление упало, но в кеше есть данные — stale, а не live', () => {
    // Именно этот случай раньше не показывал полосу «нет связи»: `query.isError`
    // не флипается, пока в кеше есть успешные данные, поэтому сравниваем время напрямую.
    expect(computeProjectsMode({ demoMode: false, hasData: true, dataUpdatedAt: 100, errorUpdatedAt: 200 })).toBe('stale');
  });

  it('связь восстановилась после ошибки — снова live', () => {
    expect(computeProjectsMode({ demoMode: false, hasData: true, dataUpdatedAt: 300, errorUpdatedAt: 200 })).toBe('live');
  });
});
