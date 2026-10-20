import { describe, expect, it } from 'vitest';
import { filterSuspicions } from './suspicions';
import type { ApiSuspicion } from './suspicions';

const make = (id: string, status: ApiSuspicion['inspector_status'], description: string, pd = 'KR-AR, стр. 1'): ApiSuspicion =>
  ({ suspicion_id: id, inspector_status: status, description, pd_reference: pd, discovery_method: 'VISUAL_DIFF', confidence: 0.6, review_priority: 'MEDIUM' }) as ApiSuspicion;

const list = [make('1', 'PENDING', 'Изменена геометрия'), make('2', 'DISMISSED', 'Другая толщина плиты', 'KR-2, стр. 4'), make('3', 'PROMOTED', 'Класс бетона')];

describe('filterSuspicions', () => {
  it('без фильтра возвращает всё', () => {
    expect(filterSuspicions(list, 'all', '')).toHaveLength(3);
  });

  it('фильтрует по статусу', () => {
    expect(filterSuspicions(list, 'DISMISSED', '').map((s) => s.suspicion_id)).toEqual(['2']);
  });

  it('ищет по описанию, документам и способу поиска без учёта регистра', () => {
    expect(filterSuspicions(list, 'all', 'ТОЛЩИНА').map((s) => s.suspicion_id)).toEqual(['2']);
    expect(filterSuspicions(list, 'all', 'kr-2').map((s) => s.suspicion_id)).toEqual(['2']);
    expect(filterSuspicions(list, 'all', 'визуальное')).toHaveLength(3);
  });

  it('статус и текст работают вместе', () => {
    expect(filterSuspicions(list, 'PENDING', 'бетона')).toHaveLength(0);
  });
});
