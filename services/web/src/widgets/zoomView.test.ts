import { describe, expect, it } from 'vitest';
import { MAX_ZOOM, clampPan, zoomStep } from './zoomView';

describe('clampPan', () => {
  it('увеличенная страница двигается, пока её край не дойдёт до края панели', () => {
    // 200 %: панель 400 px, страница 800 px, край может сместиться на 200 px экрана = 100 единиц сдвига
    expect(clampPan({ x: 60, y: -20 }, 200, 400, 500)).toEqual({ x: 60, y: -20 });
    expect(clampPan({ x: 999, y: -999 }, 200, 400, 500)).toEqual({ x: 100, y: -125 });
  });

  it('при масштабе 100 % сдвигать нечего', () => {
    expect(clampPan({ x: 50, y: 50 }, 100, 400, 500)).toEqual({ x: 0, y: 0 });
  });

  it('уменьшенная страница остаётся целиком внутри панели', () => {
    // 50 %: панель 400 px, страница 200 px, запас с каждой стороны 100 px = 200 единиц сдвига
    expect(clampPan({ x: 999, y: 0 }, 50, 400, 500).x).toBe(200);
  });
});

describe('zoomStep', () => {
  it('шаг крупнее на больших масштабах: до 1600 % не нужно нажимать десятки раз', () => {
    expect(zoomStep(100, 25)).toBe(25);
    expect(zoomStep(200, 25)).toBe(50);
    expect(zoomStep(400, 25)).toBe(100);
    expect(zoomStep(400, 10)).toBe(40);
  });

  it('максимум 1600 %, достижим кнопкой «+» из 100 % за разумное число нажатий', () => {
    let zoom = 100;
    let clicks = 0;
    while (zoom < MAX_ZOOM) {
      zoom = Math.min(MAX_ZOOM, zoom + zoomStep(zoom, 25));
      clicks += 1;
    }
    expect(MAX_ZOOM).toBe(1600);
    expect(clicks).toBeLessThanOrEqual(20);
  });
});
