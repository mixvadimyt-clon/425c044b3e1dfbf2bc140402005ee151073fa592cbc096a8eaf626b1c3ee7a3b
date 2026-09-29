import { beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
vi.mock('./client', () => ({ apiClient: { POST: (...args: unknown[]) => post(...args), GET: vi.fn() } }));

import { RequestExistsError, rejectUnfinalizeRequest, requestUnfinalize } from './unfinalizeRequests';

const created = { id: 'r1', process_id: 'p1', object_id: 'o1', reason: 'Ошибка в решении', status: 'OPEN', created_at: '2026-09-24T10:00:00Z' };

describe('requestUnfinalize', () => {
  beforeEach(() => post.mockReset());

  it('отправляет причину и возвращает созданный запрос', async () => {
    post.mockResolvedValue({ data: created, response: { status: 201 } });
    await expect(requestUnfinalize('p1', 'Ошибка в решении')).resolves.toEqual(created);
    expect(post).toHaveBeenCalledWith('/api/v1/processes/{process_id}/unfinalize-request', { params: { path: { process_id: 'p1' } }, body: { reason: 'Ошибка в решении' } });
  });

  it('повтор на тот же процесс (409) даёт RequestExistsError', async () => {
    post.mockResolvedValue({ error: { message: 'exists' }, response: { status: 409 } });
    await expect(requestUnfinalize('p1', 'ещё раз')).rejects.toBeInstanceOf(RequestExistsError);
  });

  it('другая ошибка приходит с текстом сервера', async () => {
    post.mockResolvedValue({ error: { message: 'Нет прав' }, response: { status: 403 } });
    await expect(requestUnfinalize('p1', 'x')).rejects.toThrow('Нет прав');
  });
});

describe('rejectUnfinalizeRequest', () => {
  it('отклоняет запрос с причиной', async () => {
    post.mockResolvedValue({ data: { ...created, status: 'REJECTED' }, response: { status: 200 } });
    const result = await rejectUnfinalizeRequest('r1', 'Не нужно');
    expect(result.status).toBe('REJECTED');
    expect(post).toHaveBeenLastCalledWith('/api/v1/unfinalize-requests/{request_id}/reject', { params: { path: { request_id: 'r1' } }, body: { reason: 'Не нужно' } });
  });
});
