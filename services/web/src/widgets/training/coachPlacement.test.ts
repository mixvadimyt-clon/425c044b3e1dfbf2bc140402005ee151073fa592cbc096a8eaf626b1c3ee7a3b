import { describe, expect, it } from 'vitest';
import { placeCoach } from './coachPlacement';
import type { CoachSizes } from './coachPlacement';

const viewport = { width: 1280, height: 800 };
const wide = { width: 760, height: 130 };
const narrow = { width: 380, height: 220 };
const sizes: CoachSizes = { top: wide, bottom: wide, left: narrow, right: narrow };

describe('placeCoach', () => {
  it('компактная цель (кнопка): карточка сбоку, стрелка на кнопку', () => {
    const button = { left: 300, top: 300, right: 420, bottom: 340 };
    const p = placeCoach([button], sizes, viewport);
    expect(p?.side).toBe('right');
    expect(p?.left).toBe(434);
    expect(p?.arrows).toHaveLength(1);
    // стрелка на левом краю карточки, на уровне середины кнопки
    expect(p?.arrows[0].edge).toBe('left');
    expect(p ? p.top + p.arrows[0].offset : 0).toBe(320);
  });

  it('страница с шапкой: невысокая цель подписывается над собой по центру, стрелка вниз', () => {
    const button = { left: 300, top: 300, right: 420, bottom: 340 };
    const p = placeCoach([button], sizes, viewport, undefined, 140);
    expect(p?.side).toBe('top');
    expect(p?.arrows[0].edge).toBe('bottom');
    expect(p ? p.left + p.arrows[0].offset : 0).toBe(360);
  });

  it('страница с шапкой: над целью закрыло бы шапку, карточка под ней', () => {
    const button = { left: 300, top: 150, right: 420, bottom: 190 };
    const p = placeCoach([button], sizes, viewport, undefined, 140);
    expect(p?.side).toBe('bottom');
    expect(p?.arrows[0].edge).toBe('top');
  });

  it('высокая узкая цель (колонка): карточка сбоку', () => {
    const column = { left: 100, top: 100, right: 300, bottom: 700 };
    expect(placeCoach([column], sizes, viewport)?.side).toBe('right');
  });

  it('компактная цель у правого края: карточка слева от неё', () => {
    const button = { left: 1150, top: 300, right: 1190, bottom: 340 };
    const p = placeCoach([button], sizes, viewport);
    expect(p?.side).toBe('left');
    expect(p?.arrows[0].edge).toBe('right');
  });

  it('страница с шапкой, цель у правого края: карточка над ней, прижата к краю окна, стрелка на кнопку', () => {
    const button = { left: 1150, top: 300, right: 1190, bottom: 340 };
    const p = placeCoach([button], sizes, viewport, undefined, 140);
    expect(p?.side).toBe('top');
    expect(p ? p.left + p.width : 0).toBeLessThanOrEqual(viewport.width);
    expect(p ? p.left + p.arrows[0].offset : 0).toBe(1170);
  });

  it('элемент шапки (лампочка): подпись снизу, а не сбоку', () => {
    const lamp = { left: 1100, top: 10, right: 1140, bottom: 50 };
    const p = placeCoach([lamp], sizes, viewport);
    expect(p?.side).toBe('bottom');
    expect(p?.arrows[0].edge).toBe('top');
  });

  it('высокая узкая колонка слева: подпись справа сбоку, а не сверху', () => {
    const column = { left: 20, top: 150, right: 330, bottom: 700 };
    const p = placeCoach([column], sizes, viewport);
    expect(p?.side).toBe('right');
    expect(p?.left).toBe(330 + 14);
  });

  it('широкая группа (полоса прогресса и кнопки) считается одной: карточка и стрелка по её центру', () => {
    const buttons = { left: 900, top: 100, right: 1250, bottom: 140 };
    const progress = { left: 40, top: 150, right: 1250, bottom: 190 };
    const p = placeCoach([progress, buttons], sizes, viewport);
    expect(p?.side).toBe('bottom');
    // центр группы: (40 + 1250) / 2 = 645
    expect(p ? p.left + p.width / 2 : 0).toBeCloseTo(645, 0);
    expect(p ? p.left + p.arrows[0].offset : 0).toBeCloseTo(645, 0);
  });

  it('широкая цель (ряд карточек): подпись над ней, широкая, стрелка вниз', () => {
    const row = { left: 100, top: 300, right: 1180, bottom: 460 };
    const p = placeCoach([row], sizes, viewport);
    expect(p?.side).toBe('top');
    expect(p?.width).toBe(760);
    // карточка над целью: нижний край на зазор выше верха цели
    expect(p ? p.top + wide.height : 0).toBe(300 - 14);
    expect(p?.arrows[0].edge).toBe('bottom');
  });

  it('над широкой целью места нет (она у самого верха): подпись под ней', () => {
    const row = { left: 100, top: 40, right: 1180, bottom: 200 };
    const p = placeCoach([row], sizes, viewport);
    expect(p?.side).toBe('bottom');
    expect(p?.top).toBe(214);
    expect(p?.arrows[0].edge).toBe('top');
  });

  it('цель внизу окна: подпись над ней', () => {
    const wideRow = { left: 100, top: 740, right: 1180, bottom: 780 };
    expect(placeCoach([wideRow], sizes, viewport)?.side).toBe('top');
  });

  it('несколько кучных подсвеченных мест считаются одной группой, карточка рядом со всей группой', () => {
    const buttons = { left: 900, top: 100, right: 1250, bottom: 140 };
    const progress = { left: 40, top: 160, right: 1250, bottom: 200 };
    const p = placeCoach([progress, buttons], sizes, viewport);
    expect(p?.side).toBe('bottom');
    // под группой, а не между кнопками и полосой
    expect(p?.top).toBeGreaterThanOrEqual(214);
  });

  it('две разнесённые панели: карточка между ними, стрелки на обе', () => {
    const left = { left: 20, top: 150, right: 340, bottom: 620 };
    const right = { left: 800, top: 150, right: 1160, bottom: 620 };
    const p = placeCoach([right, left], sizes, { width: 1180, height: 700 });
    expect(p?.side).toBe('between');
    expect(p?.arrows.map((a) => a.edge).sort()).toEqual(['left', 'right']);
    // карточка целиком в промежутке между панелями
    expect(p!.left).toBeGreaterThanOrEqual(340 + 14);
    expect(p!.left + p!.width).toBeLessThanOrEqual(800 - 14);
  });

  it('промежуток между панелями слишком узкий: карточка не между, а рядом с одной', () => {
    const left = { left: 20, top: 150, right: 500, bottom: 620 };
    const right = { left: 560, top: 150, right: 1160, bottom: 620 };
    const p = placeCoach([left, right], sizes, { width: 1180, height: 700 });
    expect(p?.side).not.toBe('between');
  });

  it('карточка не выходит за экран, а стрелка остаётся на карточке', () => {
    const cell = { left: 20, top: 700, right: 120, bottom: 716 };
    const p = placeCoach([cell], sizes, viewport);
    expect(p).not.toBeNull();
    expect(p!.left).toBeGreaterThanOrEqual(12);
    expect(p!.top).toBeGreaterThanOrEqual(12);
    p!.arrows.forEach((a) => expect(a.offset).toBeGreaterThanOrEqual(22));
  });

  it('цель огромная и рядом места нет: null, подсказка встанет полосой', () => {
    expect(placeCoach([{ left: 0, top: 0, right: 1280, bottom: 800 }], sizes, viewport)).toBeNull();
  });

  it('ничего не подсвечено: null', () => {
    expect(placeCoach([], sizes, viewport)).toBeNull();
  });

  it('карточка никогда не закрывает подсвеченное', () => {
    const lit = [
      { left: 100, top: 100, right: 400, bottom: 160 },
      { left: 700, top: 300, right: 1000, bottom: 700 },
    ];
    const p = placeCoach(lit, sizes, viewport);
    expect(p).not.toBeNull();
    const rect = { left: p!.left, top: p!.top, right: p!.left + p!.width, bottom: p!.top + (p!.side === 'bottom' || p!.side === 'top' ? wide.height : narrow.height) };
    lit.forEach((box) => {
      const overlaps = rect.left < box.right && box.left < rect.right && rect.top < box.bottom && box.top < rect.bottom;
      expect(overlaps).toBe(false);
    });
  });
});
