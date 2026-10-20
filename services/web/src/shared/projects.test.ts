import { describe, expect, it } from 'vitest';
import { finalizedProjects, projectsWithOpenRollbackRequest, updatedAtMs } from './projects';

describe('updatedAtMs', () => {
  it('более поздняя дата даёт большее число, время учитывается', () => {
    expect(updatedAtMs('25.09.26 10:00')).toBeGreaterThan(updatedAtMs('24.09.26 23:59'));
    expect(updatedAtMs('24.09.26 22:54')).toBeGreaterThan(updatedAtMs('24.09.26 22:53'));
  });

  it('пустая или нераспознанная дата считается самой ранней', () => {
    expect(updatedAtMs('')).toBe(0);
    expect(updatedAtMs('нет')).toBe(0);
  });
});

describe('finalizedProjects', () => {
  const p = (id: string, finalized?: boolean) => ({ id, finalized } as unknown as Parameters<typeof finalizedProjects>[0][number]);

  it('оставляет только финализированные', () => {
    expect(finalizedProjects([p('a', true), p('b', false), p('c')]).map((x) => x.id)).toEqual(['a']);
  });

  it('без финализированных — пустой список', () => {
    expect(finalizedProjects([p('a'), p('b')])).toEqual([]);
  });
});

describe('projectsWithOpenRollbackRequest', () => {
  const p = (id: string, finalized = true) => ({ id, finalized } as unknown as Parameters<typeof projectsWithOpenRollbackRequest>[0][number]);

  it('только проекты с открытым запросом на откат', () => {
    const list = [p('a'), p('b'), p('c')];
    expect(projectsWithOpenRollbackRequest(list, new Set(['c'])).map((x) => x.id)).toEqual(['c']);
  });

  it('без запросов — пустой список', () => {
    expect(projectsWithOpenRollbackRequest([p('a'), p('b')], new Set())).toEqual([]);
  });

  it('нефинализированные в список не попадают, даже если есть запрос', () => {
    expect(projectsWithOpenRollbackRequest([p('a', false), p('b')], new Set(['a', 'b']))).toHaveLength(1);
  });
});
