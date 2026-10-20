import React from 'react';
import { createPortal } from 'react-dom';
import { holeOf, toRect } from './visibleBox';
import type { Rect } from './visibleBox';

const PAD = 6;
/** Окна ближе друг к другу, чем на столько, сливаем в одно, чтобы подсветка не рассыпалась на кусочки. */
const MERGE_GAP = 24;

const near = (a: Rect, b: Rect): boolean =>
  a.left - MERGE_GAP < b.right && b.left - MERGE_GAP < a.right && a.top - MERGE_GAP < b.bottom && b.top - MERGE_GAP < a.bottom;

/** Сливает близкие окна в одно (по объединению границ). */
const mergeHoles = (holes: Rect[]): Rect[] => {
  const list = [...holes];
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        if (!near(list[i], list[j])) continue;
        list[i] = {
          left: Math.min(list[i].left, list[j].left),
          top: Math.min(list[i].top, list[j].top),
          right: Math.max(list[i].right, list[j].right),
          bottom: Math.max(list[i].bottom, list[j].bottom),
        };
        list.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  return list;
};

/** Где рисуется затемнение: рабочая область урока (рамка «Учебный проект»), полный экран или, для урока про окно, вся страница. */
const findRoot = (global: boolean): HTMLElement | null => {
  const fullscreen = document.querySelector<HTMLElement>('.verification-fullscreen-wrapper');
  if (fullscreen) return fullscreen;
  return global ? document.body : document.querySelector<HTMLElement>('.training-dim-root');
};

/**
 * Затемняет рабочую область урока, оставляя светлыми подсвеченные элементы шага (и подсказку, если она внутри области).
 * Слой не перехватывает нажатия: ненужные действия учебные экраны и так не засчитывают. Окна обрезаются по видимой
 * части элементов и пересчитываются каждый кадр: элементы двигаются при прокрутке, в полном экране и при
 * перетаскивании панелей.
 */
export const Spotlight: React.FC<{ target?: string; active: boolean; global?: boolean }> = ({ target, active, global = false }) => {
  const maskId = `training-spot-${React.useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [root, setRoot] = React.useState<HTMLElement | null>(null);
  const [holes, setHoles] = React.useState<Rect[]>([]);

  React.useEffect(() => {
    if (!active || !target || typeof requestAnimationFrame !== 'function') {
      setRoot(null);
      setHoles([]);
      return;
    }
    let frame = 0;
    let last = '';
    const tick = () => {
      const area = findRoot(global);
      setRoot((prev) => (prev === area ? prev : area));
      if (area) {
        const fixed = area === document.body;
        const areaRect: Rect = fixed ? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight } : toRect(area.getBoundingClientRect());
        const marked = new Set<Element>(area.querySelectorAll(`[data-tt="${target}"], .training-target, .training-target-np`));
        // Подсвеченное в шапке и меню (урок про окно) лежит вне body-узла area.querySelectorAll только при global
        const list = [...marked].map((el) => holeOf(el, areaRect, PAD)).filter((h): h is Rect => h !== null);
        const all = mergeHoles(list);
        // Подсказка урока внутри области (полный экран, урок про окно) тоже остаётся светлой
        const coach = area.querySelector('.training-coach');
        const coachHole = coach ? holeOf(coach, areaRect, 0) : null;
        if (coachHole) all.push(coachHole);
        const relative = all.map((h) => ({
          left: h.left - areaRect.left,
          top: h.top - areaRect.top,
          right: h.right - areaRect.left,
          bottom: h.bottom - areaRect.top,
        }));
        const key = relative.map((h) => `${Math.round(h.left)},${Math.round(h.top)},${Math.round(h.right)},${Math.round(h.bottom)}`).join('|');
        if (key !== last) {
          last = key;
          setHoles(relative);
        }
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [active, target, global]);

  // Даже если подсвеченное прокручено за край, область остаётся затемнённой (окон тогда нет)
  if (!active || !target || !root) return null;
  const fixed = root === document.body;
  // В рабочей области слой лежит ниже закреплённой подсказки урока (z-index 20), а в полном экране и на всей странице поверх всего
  const inFrame = root.classList.contains('training-dim-root');
  // В тёмной теме обычное затемнение почти не видно: делаем его плотнее и обводим светлое окно тонкой светлой линией
  const dark = document.body.getAttribute('data-theme') === 'dark';
  return createPortal(
    <svg
      aria-hidden
      data-testid="training-spotlight"
      style={{ position: fixed ? 'fixed' : 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: inFrame ? 10 : 1200 }}
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
          <rect x="0" y="0" width="100%" height="100%" fill="white" />
          {holes.map((h, i) => (
            <rect key={i} x={h.left} y={h.top} width={h.right - h.left} height={h.bottom - h.top} rx={12} fill="black" />
          ))}
        </mask>
      </defs>
      <rect x="0" y="0" width="100%" height="100%" fill={dark ? 'rgba(0, 0, 0, 0.65)' : 'rgba(17, 24, 39, 0.42)'} mask={`url(#${maskId})`} />
      {dark &&
        holes.map((h, i) => (
          <rect key={`ring-${i}`} x={h.left} y={h.top} width={h.right - h.left} height={h.bottom - h.top} rx={12} fill="none" stroke="rgba(255, 255, 255, 0.6)" strokeWidth={1.5} />
        ))}
    </svg>,
    root,
  );
};
