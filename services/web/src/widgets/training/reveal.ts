import { visibleRect } from './visibleBox';

/** Прокрутка к подсвеченному: подсвеченное ставится в удобную часть окна, а не туда, где оно «ещё видно». */
interface Span {
  top: number;
  bottom: number;
}

export interface Rect extends Span {
  left: number;
  right: number;
}

/** Часть высоты области, на которой стоит середина подсвеченного (выше середины, чтобы подпись и подсвеченное были на виду). */
const TARGET_CENTER = 0.35;
/** Зона, где подсвеченное считается удобно стоящим: прокручивать не нужно (нет лишних прыжков). */
const GOOD_TOP = 0.1;
const GOOD_BOTTOM = 0.75;
/** Для высокого подсвеченного (больше 60 % области) верх должен быть в этой зоне. */
const TALL_RATIO = 0.6;
const TALL_TOP_MIN = 0.03;
const TALL_TOP_MAX = 0.25;
const TALL_MARGIN = 16;
const SIDE_MARGIN = 8;
/** Дальше этого расстояния (px) прокручиваем сразу, без плавной анимации. */
const SMOOTH_MAX = 350;

/**
 * На сколько пикселей прокрутить область по вертикали (вниз положительное), чтобы подсвеченное встало удобно; 0, если оно и
 * так в удобной зоне. Невысокое ставим серединой на 35 % высоты области, высокое (таблица) верхом с небольшим отступом.
 */
export const scrollDeltaFor = (item: Span, fullArea: Span, reserveTop = 0, reserveBottom = 0): number => {
  // Под целью нужно место для подписи (шаг со стороной «снизу»): считаем, что область заканчивается выше
  const area = { top: fullArea.top, bottom: fullArea.bottom - reserveBottom };
  const areaHeight = area.bottom - area.top;
  const itemHeight = item.bottom - item.top;
  if (areaHeight <= 0) return 0;
  if (itemHeight > areaHeight * TALL_RATIO || reserveTop > 0) {
    // Высокое или широкое подсвеченное (таблица, карточка на всю ширину): подпись может встать только над ним или под ним,
    // поэтому оставляем над ним `reserveTop` пикселей от верха окна (высота подписи с зазором), но не меньше небольшого
    // отступа от верха области
    const desired = Math.max(area.top + TALL_MARGIN, reserveTop);
    const offset = item.top - desired;
    return offset >= -areaHeight * TALL_TOP_MIN && offset <= areaHeight * TALL_TOP_MAX ? 0 : offset;
  }
  const topRatio = (item.top - area.top) / areaHeight;
  const bottomRatio = (item.bottom - area.top) / areaHeight;
  if (topRatio >= GOOD_TOP && bottomRatio <= GOOD_BOTTOM) return 0;
  return (item.top + item.bottom) / 2 - (area.top + areaHeight * TARGET_CENTER);
};

/**
 * На сколько прокрутить область по горизонтали (вправо положительное): широкие таблицы прокручиваются вбок, и подсвеченная
 * колонка может быть за краем. Целиком на виду: 0; помещается: ставим по центру; шире области: левым краем.
 */
export const scrollDeltaX = (item: { left: number; right: number }, area: { left: number; right: number }): number => {
  const areaWidth = area.right - area.left;
  if (areaWidth <= 0) return 0;
  if (item.left >= area.left + SIDE_MARGIN && item.right <= area.right - SIDE_MARGIN) return 0;
  if (item.right - item.left > areaWidth - SIDE_MARGIN * 2) return item.left - (area.left + SIDE_MARGIN);
  return (item.left + item.right) / 2 - (area.left + area.right) / 2;
};

/** Прокручиваемые предки элемента от внутреннего к внешнему (внутренняя область учебного экрана, потом страница). */
export const scrollersOf = (el: Element): HTMLElement[] => {
  const list: HTMLElement[] = [];
  for (let p = el.parentElement; p; p = p.parentElement) {
    const style = getComputedStyle(p);
    const vertical = /(auto|scroll)/.test(style.overflowY) && p.scrollHeight > p.clientHeight + 1;
    const horizontal = /(auto|scroll)/.test(style.overflowX) && p.scrollWidth > p.clientWidth + 1;
    if (vertical || horizontal) list.push(p);
  }
  return list;
};

/** Рамка, объединяющая главную цель шага (или её «точку прокрутки») и остальное подсвеченное. */
const litRect = (target: string): Rect | null => {
  const marked = [...document.querySelectorAll<HTMLElement>(`[data-tt="${target}"], .training-target, .training-target-np`)];
  const anchor = document.querySelector<HTMLElement>(`[data-scroll-for~="${target}"]`);
  if (anchor) marked.push(anchor);
  const rects = marked.map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
  if (rects.length === 0) return null;
  return {
    top: Math.min(...rects.map((r) => r.top)),
    bottom: Math.max(...rects.map((r) => r.bottom)),
    left: Math.min(...rects.map((r) => r.left)),
    right: Math.max(...rects.map((r) => r.right)),
  };
};

/** Видимая часть прокручиваемой области: пересечение с окном и с внешними областями, которые её обрезают (вложенные прокрутки). */
const visibleRectOf = (el: HTMLElement): Rect => {
  const frame = { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
  return visibleRect(el, frame) ?? frame;
};

/**
 * Ставит подсвеченное шага в удобную зону: сначала во внутренних прокручиваемых областях (рамка учебного экрана и широкие
 * таблицы прокручиваются сами, по вертикали и вбок), потом в странице. После каждой внутренней прокрутки подсвеченное
 * измеряется заново: область могла упереться в край и сдвинуть его меньше, чем нужно, тогда внешней области достаётся
 * остаток. Внутренние прокрутки мгновенные, последняя плавная (`behavior`), чтобы взгляд не терял страницу. Если
 * подсвеченное уже удобно стоит, ничего не двигаем.
 */
export const revealLit = (target: string, behavior: ScrollBehavior, reserveTop = 0, reserveBottom = 0): void => {
  const first = document.querySelector<HTMLElement>(`[data-tt="${target}"]`);
  if (!first) return;
  // Мгновенно: 'auto' (в странице нет CSS scroll-behavior), потому что 'instant' есть не во всех версиях Safari
  const instant: ScrollBehavior = 'auto';
  const viewport = { top: 0, bottom: window.innerHeight };
  // Место над высоким подсвеченным нужно только широкому: узкое (колонка, панель) подпись ставит сбоку
  const wide = (litRect(target)?.right ?? 0) - (litRect(target)?.left ?? 0) > window.innerWidth * 0.45;
  const reserve = wide ? reserveTop : 0;
  const scrollers = scrollersOf(first);
  const pageIsWindow = scrollers.includes(document.scrollingElement as HTMLElement);
  for (let i = 0; i < scrollers.length; i += 1) {
    const item = litRect(target);
    if (!item) return;
    const scroller = scrollers[i];
    const area = visibleRectOf(scroller);
    const top = scroller.scrollHeight > scroller.clientHeight + 1 ? scrollDeltaFor(item, area, reserve, reserveBottom) : 0;
    const left = scroller.scrollWidth > scroller.clientWidth + 1 ? scrollDeltaX(item, area) : 0;
    if (Math.abs(top) <= 1 && Math.abs(left) <= 1) continue;
    const lastScroller = i === scrollers.length - 1;
    // Плавно только если после этой прокрутки больше ничего не понадобится (проверяем, где окажется подсвеченное)
    const moved = { top: item.top - top, bottom: item.bottom - top };
    const windowNeeded = lastScroller && !pageIsWindow && Math.abs(scrollDeltaFor(moved, viewport, reserve, reserveBottom)) > 1;
    // Плавно только на небольшое расстояние: долгая прокрутка задерживает появление подписи (она ждёт, пока цель остановится)
    const near = Math.max(Math.abs(top), Math.abs(left)) <= SMOOTH_MAX;
    scroller.scrollBy({ top, left, behavior: lastScroller && !windowNeeded && near ? behavior : instant });
    if (lastScroller && !windowNeeded) return;
  }
  if (!pageIsWindow) {
    const item = litRect(target);
    if (!item) return;
    const delta = scrollDeltaFor(item, viewport, reserve, reserveBottom);
    if (Math.abs(delta) > 1) window.scrollBy({ top: delta, behavior: Math.abs(delta) <= SMOOTH_MAX ? behavior : instant });
  }
};
