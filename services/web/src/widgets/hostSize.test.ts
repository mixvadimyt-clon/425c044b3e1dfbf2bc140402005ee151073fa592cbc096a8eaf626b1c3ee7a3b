import { describe, expect, it } from 'vitest';
import { layoutSize } from './hostSize';

const el = (clientWidth: number, clientHeight: number) => ({ clientWidth, clientHeight }) as unknown as HTMLElement;
const entry = (inlineSize: number, blockSize: number) => ({ contentBoxSize: [{ inlineSize, blockSize }] }) as unknown as ResizeObserverEntry;

describe('layoutSize', () => {
  it('берёт дробный размер из наблюдателя и округляет вниз: страница не выходит за панель на долю пикселя', () => {
    expect(layoutSize(el(360, 711), entry(359.6, 710.6))).toEqual({ w: 359, h: 710 });
  });

  it('целый размер не меняется', () => {
    expect(layoutSize(el(360, 711), entry(360, 711))).toEqual({ w: 360, h: 711 });
  });

  it('без данных наблюдателя (первый кадр) берёт размер элемента', () => {
    expect(layoutSize(el(360, 711))).toEqual({ w: 360, h: 711 });
  });
});
