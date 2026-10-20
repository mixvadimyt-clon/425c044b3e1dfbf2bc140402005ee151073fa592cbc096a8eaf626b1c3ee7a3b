import { describe, expect, it } from 'vitest';
import { guideProgress, highlight, stepAllows } from './guide';
import type { GuideStep } from './guide';

const action: GuideStep = { id: 'a', target: 'btn', expect: 'confirm', text: 'Нажмите кнопку' };
const info: GuideStep = { id: 'b', target: 'list', text: 'Это список' };

describe('stepAllows', () => {
  it('допускает только то действие, которого ждёт шаг', () => {
    expect(stepAllows(action, 'confirm')).toBe(true);
    expect(stepAllows(action, 'clarify')).toBe(false);
  });

  it('на шаге-пояснении и без шага экранные действия не работают', () => {
    expect(stepAllows(info, 'confirm')).toBe(false);
    expect(stepAllows(undefined, 'confirm')).toBe(false);
  });
});

describe('guideProgress', () => {
  it('считает шаги; после последнего урок пройден, номер не выходит за число шагов', () => {
    expect(guideProgress([action, info], 0)).toEqual({ done: false, current: 1, total: 2 });
    expect(guideProgress([action, info], 1)).toEqual({ done: false, current: 2, total: 2 });
    expect(guideProgress([action, info], 2)).toEqual({ done: true, current: 2, total: 2 });
  });
});

describe('highlight', () => {
  it('подсвечивает только цель текущего шага', () => {
    expect(highlight(action, 'btn')).toBe('training-target');
    expect(highlight(action, 'list')).toBe('');
    expect(highlight(undefined, 'btn')).toBe('');
  });

  it('подсвечивает и дополнительные цели шага', () => {
    const step = { id: 'x', target: 'main', also: ['extra'], text: 'т' };
    expect(highlight(step, 'main')).toBe('training-target');
    expect(highlight(step, 'extra')).toBe('training-target');
    expect(highlight(step, 'other')).toBe('');
  });
});
