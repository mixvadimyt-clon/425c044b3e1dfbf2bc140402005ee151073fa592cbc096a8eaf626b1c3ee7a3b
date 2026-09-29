import { beforeEach, describe, expect, it, vi } from 'vitest';

const patch = vi.fn();
vi.mock('./client', () => ({ apiClient: { PATCH: (...args: unknown[]) => patch(...args), GET: vi.fn() } }));

import { patchObject } from './projects';

describe('patchObject', () => {
  beforeEach(() => patch.mockReset());

  it('отправляет реквизиты и возвращает обновлённый объект', async () => {
    const updated = { id: 'o1', name: 'ЖК', address: 'г. Москва' };
    patch.mockResolvedValue({ data: updated });
    await expect(patchObject('o1', { address: 'г. Москва' })).resolves.toEqual(updated);
    expect(patch).toHaveBeenCalledWith('/api/v1/objects/{object_id}', { params: { path: { object_id: 'o1' } }, body: { address: 'г. Москва' } });
  });

  it('на финализированной проверке (409) даёт понятную ошибку', async () => {
    patch.mockResolvedValue({ error: { message: 'Протокол финализирован, изменение недоступно' } });
    await expect(patchObject('o1', { name: 'Новое имя' })).rejects.toThrow('Протокол финализирован, изменение недоступно');
  });
});
