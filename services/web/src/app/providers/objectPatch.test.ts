import { describe, expect, it } from 'vitest';
import { toObjectPatch } from './objectPatch';

describe('toObjectPatch', () => {
  it('пустая строка означает «стереть», api ждёт null, а не «»', () => {
    expect(toObjectPatch({ address: '' })).toMatchObject({ address: null });
    expect(toObjectPatch({ developer: '  ' })).toMatchObject({ customer: null });
  });

  it('непустое значение переносится, developer и permit переименованы под контракт', () => {
    expect(toObjectPatch({ address: 'г. Москва', developer: 'ООО Застройщик', permit: '77-1' })).toMatchObject({
      address: 'г. Москва',
      customer: 'ООО Застройщик',
      permit_number: '77-1',
    });
  });

  it('поле без правки не попадает в тело запроса', () => {
    const result = toObjectPatch({ name: 'Новое имя' });
    expect(result).toEqual({ name: 'Новое имя' });
  });
});
