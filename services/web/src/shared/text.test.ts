import { describe, expect, it } from 'vitest';
import { pageLabel, withReasonNames, withoutLongDash } from './text';

describe('withoutLongDash', () => {
  it('заменяет длинное тире запятой', () => {
    expect(withoutLongDash('Recall 0.5 — нужно ≥ 0.8')).toBe('Recall 0.5, нужно ≥ 0.8');
    expect(withoutLongDash('Принято 3 из 3 — создана проверка. Реестра нет — полнота не подтверждена')).toBe('Принято 3 из 3, создана проверка. Реестра нет, полнота не подтверждена');
  });

  it('дефис внутри слов и коды не трогает', () => {
    expect(withoutLongDash('M-002: ПД-РД, 100 %')).toBe('M-002: ПД-РД, 100 %');
  });
});

describe('withReasonNames', () => {
  it('код причины заменяет названием с маленькой буквы', () => {
    expect(withReasonNames('Причина WRONG_REVISION: 2 из 2', { WRONG_REVISION: 'Неверная редакция' })).toBe('Причина неверная редакция: 2 из 2');
  });

  it('неизвестный код оставляет как есть', () => {
    expect(withReasonNames('Код SOME_CODE', {})).toBe('Код SOME_CODE');
  });
});

describe('pageLabel', () => {
  it('лист и страница через запятую', () => {
    expect(pageLabel('лист 3', 5)).toBe('лист 3, стр. 5');
  });

  it('без листа или файла только страница, без висящей запятой', () => {
    expect(pageLabel('', 1)).toBe('стр. 1');
    expect(pageLabel(undefined, 2)).toBe('стр. 2');
    expect(pageLabel('  ', 3)).toBe('стр. 3');
  });
});
