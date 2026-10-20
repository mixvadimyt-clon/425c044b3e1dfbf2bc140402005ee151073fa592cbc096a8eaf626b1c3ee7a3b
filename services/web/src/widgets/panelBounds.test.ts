import { describe, expect, it } from 'vitest';
import { clampPanelOffset } from './panelBounds';

const viewport = { width: 1200, height: 800 };

describe('clampPanelOffset', () => {
  it('панель на месте не двигается', () => {
    expect(clampPanelOffset('findings', { x: 0, y: 0 }, 320, viewport)).toEqual({ x: 0, y: 0 });
    expect(clampPanelOffset('evidence', { x: 0, y: 0 }, 360, viewport)).toEqual({ x: 0, y: 0 });
  });

  it('левую панель нельзя унести за правый край: остаётся 60 пикселей', () => {
    const { x } = clampPanelOffset('findings', { x: 5000, y: 0 }, 320, viewport);
    expect(20 + x).toBe(1200 - 60);
  });

  it('левую панель нельзя унести за левый край: остаётся 60 пикселей', () => {
    const { x } = clampPanelOffset('findings', { x: -5000, y: 0 }, 320, viewport);
    expect(20 + x + 320).toBe(60);
  });

  it('правую панель нельзя унести ни влево, ни вправо за экран', () => {
    // сдвиг x < 0 уводит правую панель влево: справа от неё остаётся полоса в 60 пикселей
    const farLeft = clampPanelOffset('evidence', { x: -5000, y: 0 }, 360, viewport);
    expect(1200 - (20 - farLeft.x)).toBe(60);
    // сдвиг x > 0 уводит её вправо: слева от неё остаётся полоса в 60 пикселей до края экрана
    const farRight = clampPanelOffset('evidence', { x: 5000, y: 0 }, 360, viewport);
    expect(1200 - (20 - farRight.x) - 360).toBe(1200 - 60);
  });

  it('заголовок остаётся на экране сверху и снизу', () => {
    expect(84 + clampPanelOffset('findings', { x: 0, y: -5000 }, 320, viewport).y).toBe(0);
    expect(84 + clampPanelOffset('findings', { x: 0, y: 5000 }, 320, viewport).y).toBe(800 - 48);
  });
});
