import React from 'react';
import { createPortal } from 'react-dom';
import { GAP, arrowFor, placeCoach, unionOf } from './coachPlacement';
import type { Box, CoachArrow, CoachSide, CoachSizes } from './coachPlacement';
import { visibleRect } from './visibleBox';

/** Над и под подсвеченным карточка широкая (текст в две-четыре строки), сбоку узкая: широкая сбоку закрыла бы пол-экрана. */
const WIDE_MAX = 1100;
const NARROW_MAX = 480;
/** Карточка уже этой ширины переносит кнопки на вторую строку (+ROW); ширина текста меньше карточки на INNER (поля карточки). */
const WRAP_WIDTH = 520;
const BUTTON_ROW = 44;
const INNER = 44;
/** Запас к оценке высоты при другой ширине: перенос строк даёт погрешность. */
const SAFETY = 10;
const DOCK_GAP = 12;
/** Сколько кадров подряд положение не менялось, прежде чем проверять реже. */
const IDLE_FRAMES = 30;

/** Размер окна без полос прокрутки: на Windows они занимают место, на Mac накладные; fixed-подпись считается от этой области. */
const viewSize = (): { width: number; height: number } => ({ width: document.documentElement.clientWidth || window.innerWidth, height: document.documentElement.clientHeight || window.innerHeight });

const viewportBox = (): Box => {
  const view = viewSize();
  return { left: 0, top: 0, right: view.width, bottom: view.height };
};

const targetElements = (target: string | undefined): Element[] => (target ? [...document.querySelectorAll(`[data-tt="${target}"]`)] : []);

/** Видимая часть главного элемента шага: первого из помеченных `data-tt`, который сейчас на экране. */
const targetBox = (target: string | undefined): Box | null => {
  for (const el of targetElements(target)) {
    const box = visibleRect(el, viewportBox());
    if (box) return box;
  }
  return null;
};

/** Все подсвеченные видимые рамки шага: главная цель первой, дальше остальное (`also` и подобное). */
const litBoxes = (target: string | undefined): Box[] => {
  const main = targetBox(target);
  const others = [...document.querySelectorAll('.training-target, .training-target-np')]
    .map((el) => visibleRect(el, viewportBox()))
    .filter((box): box is Box => box !== null && !(main && box.left === main.left && box.top === main.top && box.right === main.right && box.bottom === main.bottom));
  return main ? [main, ...others] : others;
};

/** Где стоит полоса, когда рядом с целью места нет: под шапкой страницы (или под панелью инструментов полного экрана), на всю ширину рабочей области. */
const dockArea = (): { left: number; top: number; width: number } => {
  const fullscreen = document.querySelector('.verification-fullscreen-wrapper');
  if (fullscreen) {
    const toolbar = fullscreen.querySelector('.compare-toolbar');
    return { left: 24, top: toolbar ? toolbar.getBoundingClientRect().bottom + 8 : DOCK_GAP, width: window.innerWidth - 48 };
  }
  const main = document.querySelector('main');
  const rect = main?.getBoundingClientRect();
  if (!rect || rect.width < 320) return { left: DOCK_GAP, top: DOCK_GAP, width: window.innerWidth - DOCK_GAP * 2 };
  return { left: rect.left + DOCK_GAP, top: Math.max(rect.top, 0) + DOCK_GAP, width: rect.width - DOCK_GAP * 2 };
};

interface Layout {
  mode: 'float' | 'dock';
  left: number;
  top: number;
  width: number;
  side: CoachSide;
  arrows: CoachArrow[];
}

/**
 * Карточка с текстом шага. Если рядом с подсвеченным есть свободное место, она стоит рядом, и стрелка показывает, на что
 * смотреть. Если подсвеченного много или оно огромное и карточка закрыла бы его, она стоит широкой полосой вверху, а
 * подсвеченное прокручивается ниже полосы (один раз, на минимальное расстояние). Положение пересчитывается каждый кадр:
 * элементы двигаются при прокрутке, в полном экране и при перетаскивании панелей.
 */
export const CoachCard: React.FC<{ target?: string; textLength?: number; done?: boolean; hidden?: boolean; label?: string; pageHints?: boolean; preferSide?: CoachSide; children: React.ReactNode }> = ({ target, textLength = 0, done = false, hidden = false, label, pageHints = false, preferSide, children }) => {
  // Урок пройден: сообщение стоит в потоке страницы, под вкладками уроков и перед названием урока
  const [slot, setSlot] = React.useState<Element | null>(null);
  React.useLayoutEffect(() => {
    setSlot(done ? document.querySelector('.training-done-slot') : null);
  }, [done]);
  // Урок пройден: прокручиваем к сообщению, чтобы его было видно сразу (после перерисовки страницы)
  React.useEffect(() => {
    if (!slot) return;
    // Строго наверх: видны заголовок, вкладки уроков и сообщение
    const timer = window.setTimeout(() => {
      for (let p = slot.parentElement; p; p = p.parentElement) {
        if (p.scrollTop > 0) p.scrollTo?.({ top: 0, behavior: 'smooth' });
      }
      window.scrollTo?.({ top: 0, behavior: 'smooth' });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [slot]);

  const ariaLabel = label ?? 'Подсказка обучения';
  const ref = React.useRef<HTMLDivElement>(null);
  const [layout, setLayout] = React.useState<Layout | null>(null);
  // Между «рядом с подсвеченным» и «полоса сверху» переключаемся не сразу, а когда новое положение держится несколько
  // кадров: пока страница прокручивается к подсвеченному, оно ненадолго то видно целиком, то нет, и подсказка не должна мигать
  const modeRef = React.useRef<{ dock: boolean; ok: number; fail: number; float: Layout | null; side?: CoachSide }>({ dock: false, ok: 0, fail: 0, float: null });
  // Подсказка не показывается, пока её положение не устоялось (прокрутка, раскрытие меню): так она не «едет» на глазах
  const [settled, setSettled] = React.useState(false);
  // До отрисовки (layout-эффект): на новом шаге подпись скрывается сразу, а не после первого кадра, иначе новый текст на миг
  // стоял бы на старом месте и перепрыгивал на новое
  React.useLayoutEffect(() => {
    modeRef.current = { dock: false, ok: 0, fail: 0, float: null, side: preferSide };
    setSettled(false);
  }, [target, label]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    if (hidden || slot || typeof requestAnimationFrame !== 'function') return;
    let frame = 0;
    let timer = 0;
    // Пока ничего не движется, проверяем реже (раз в 120 мс), а при прокрутке, изменении окна или перетаскивании снова каждый кадр:
    // на слабых ноутбуках расчёт каждый кадр без нужды съедал бы заметную часть времени
    let idle = 0;
    let last = '';
    let changedAt = performance.now();
    const startedAt = performance.now();
    const tick = () => {
      const viewport = viewSize();
      const height = ref.current?.offsetHeight ?? 0;
      const lit = litBoxes(target);
      let next: Layout | null = null;
      const state = modeRef.current;
      if (lit.length > 0 && height > 0) {
        // Чем длиннее текст шага, тем шире карточка: короткая подсказка не растягивается на всю страницу.
        const wide = Math.min(Math.max(520, 380 + textLength * 2.7), WIDE_MAX, dockArea().width, viewport.width - 48);
        const narrow = Math.min(Math.max(340, 300 + textLength * 0.9), NARROW_MAX, viewport.width - 48);
        const current = ref.current?.offsetWidth || wide;
        // Высоту при другой ширине оцениваем по измеренной: текст переносится по ширине, кнопки в узкой карточке встают в два ряда
        const textHeight = ref.current?.querySelector<HTMLElement>('.training-coach-text')?.offsetHeight ?? Math.max(0, height - 100);
        const baseChrome = height - textHeight - (current < WRAP_WIDTH ? BUTTON_ROW : 0);
        const sized = (width: number) => ({ width, height: SAFETY + baseChrome + (width < WRAP_WIDTH ? BUTTON_ROW : 0) + (textHeight * Math.max(1, current - INNER)) / Math.max(1, width - INNER) });
        const sizes: CoachSizes = { top: sized(wide), bottom: sized(wide), left: sized(narrow), right: sized(narrow) };
        // Страницы с шапкой (протокол): подпись не закрывает шапку и заголовок страницы
        const topSafe = pageHints && !document.querySelector('.verification-fullscreen-wrapper') ? 150 : 0;
        const placed = placeCoach(lit, sizes, viewport, preferSide ?? state.side, topSafe);
        if (placed) {
          state.ok += 1;
          state.fail = 0;
          state.side = placed.side;
          state.float = { mode: 'float', ...placed };
          if (state.dock && state.ok >= 12) state.dock = false;
        } else {
          state.fail += 1;
          state.ok = 0;
          if (!state.dock && state.fail >= 6) state.dock = true;
        }
        // Рядом с подсвеченным, если место есть; в первые кадры без места держим прежнее положение, чтобы не мигать
        if (!state.dock) next = state.float;
      }
      if (!next && !target) {
        // У шага нет цели (например, «Урок пройден» без слота): полоса стоит внизу окна и ничего на странице не закрывает
        const dock = dockArea();
        next = { mode: 'dock', left: dock.left, top: Math.max(DOCK_GAP, viewport.height - height - DOCK_GAP), width: dock.width, side: 'top', arrows: [] };
      }
      if (!next) {
        const dock = dockArea();
        // Полоса вплотную над подсвеченным (или под ним, если сверху тесно): стрелка вниз или вверх касается его
        let top = dock.top;
        let edge: CoachArrow['edge'] = 'bottom';
        if (lit.length > 0 && height > 0) {
          const union = unionOf(lit);
          if (union.top - GAP - height >= dock.top) top = union.top - GAP - height;
          else if (union.bottom + GAP + height <= viewport.height - DOCK_GAP) {
            top = union.bottom + GAP;
            edge = 'top';
          }
        }
        const rect: Box = { left: dock.left, top, right: dock.left + dock.width, bottom: top + height };
        next = { mode: 'dock', left: dock.left, top, width: dock.width, side: 'top', arrows: lit.length > 0 && height > 0 ? [arrowFor(rect, lit, edge)] : [] };
      }
      const key = `${next.mode},${Math.round(next.left)},${Math.round(next.top)},${next.side},${next.arrows.map((a) => `${a.edge}${Math.round(a.offset)}`).join(';')},${Math.round(next.width)}`;
      const moved = key !== last;
      if (moved) {
        last = key;
        changedAt = performance.now();
        idle = 0;
        setLayout(next);
      }
      // Устоялось: положение не менялось 80 мс (по времени, а не по числу кадров: на 60 и 120 Гц одинаково), но не раньше 100 мс (прокрутка к цели успевает начаться) и не позже 600 мс
      const now = performance.now();
      if ((now - changedAt >= 80 && now - startedAt >= 100) || now - startedAt > 600) setSettled(true);
      if (!moved && idle < IDLE_FRAMES) idle += 1;
      if (document.hidden) idle = IDLE_FRAMES;
      if (idle >= IDLE_FRAMES) {
        timer = window.setTimeout(() => {
          timer = 0;
          frame = requestAnimationFrame(tick);
        }, 120);
      } else {
        frame = requestAnimationFrame(tick);
      }
    };
    const wake = () => {
      idle = 0;
      if (timer) {
        window.clearTimeout(timer);
        timer = 0;
        frame = requestAnimationFrame(tick);
      }
    };
    window.addEventListener('scroll', wake, true);
    window.addEventListener('resize', wake);
    document.addEventListener('pointermove', wake, true);
    document.addEventListener('wheel', wake, true);
    tick();
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      window.removeEventListener('scroll', wake, true);
      window.removeEventListener('resize', wake);
      document.removeEventListener('pointermove', wake, true);
      document.removeEventListener('wheel', wake, true);
    };
  }, [target, hidden, textLength, slot, pageHints, preferSide]);

  if (slot) {
    return createPortal(
      <div className="training-coach training-coach-inline" role="status" style={{ visibility: hidden ? 'hidden' : undefined }}>
        {children}
      </div>,
      slot,
    );
  }
  const mode = layout?.mode ?? 'dock';
  return createPortal(
    <div
      ref={ref}
      className={`training-coach training-coach-float training-coach-${layout?.side ?? 'top'}${mode === 'dock' ? ' training-coach-dock' : ''}`}
      role="dialog"
      aria-label={ariaLabel}
      style={{
        left: layout?.left ?? DOCK_GAP,
        top: layout?.top ?? DOCK_GAP,
        width: layout?.width ?? WIDE_MAX,
        // Пока открыто окно выхода или идёт «Назад», подсказка не видна (окно выше неё), но остаётся в странице
        visibility: hidden ? 'hidden' : undefined,
        opacity: settled ? 1 : 0,
        // Появляется плавно, исчезает сразу
        transition: settled ? 'opacity 0.1s ease' : 'none',
      }}
    >
      {layout?.arrows.map((arrow) => (
        <span key={arrow.edge} aria-hidden className={`training-coach-arrow training-coach-arrow-${arrow.edge}`} style={{ ['--a' as string]: `${arrow.offset}px` }} />
      ))}
      {children}
    </div>,
    document.body,
  );
};
