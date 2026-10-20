/** Геометрия подсвеченных элементов: видимая часть с учётом обрезки предками и окна вокруг неё. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const clipsContent = (el: Element): boolean => {
  const s = getComputedStyle(el);
  return [s.overflowX, s.overflowY].some((v) => v !== 'visible');
};

export const toRect = (r: DOMRect): Rect => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });

/** Видимая часть элемента: пересечение с предками, которые обрезают содержимое, и с рамкой затемнения. */
export const visibleRect = (el: Element, frame: Rect): Rect | null => {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  const rect = toRect(r);
  const clip = (b: Rect) => {
    rect.left = Math.max(rect.left, b.left);
    rect.top = Math.max(rect.top, b.top);
    rect.right = Math.min(rect.right, b.right);
    rect.bottom = Math.min(rect.bottom, b.bottom);
  };
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    if (clipsContent(p)) clip(toRect(p.getBoundingClientRect()));
    // Закреплённая панель не обрезается предками, поэтому дальше вверх не идём
    if (getComputedStyle(p).position === 'fixed') break;
  }
  clip(frame);
  return rect.right > rect.left && rect.bottom > rect.top ? rect : null;
};

/** Окно вокруг видимой части: отступ только там, где край элемента на виду, чтобы не светить за обрезкой. */
export const holeOf = (el: Element, frame: Rect, pad: number): Rect | null => {
  const vis = visibleRect(el, frame);
  if (!vis) return null;
  const full = el.getBoundingClientRect();
  return {
    left: vis.left - (vis.left > full.left + 0.5 || pad === 0 ? 0 : pad),
    top: vis.top - (vis.top > full.top + 0.5 || pad === 0 ? 0 : pad),
    right: vis.right + (vis.right < full.right - 0.5 || pad === 0 ? 0 : pad),
    bottom: vis.bottom + (vis.bottom < full.bottom - 0.5 || pad === 0 ? 0 : pad),
  };
};

/** Видимая часть элемента в окне браузера (без обрезанного предками): по ней подсказка урока выбирает место. */
export const visibleBoxOf = (el: Element): Rect | null => visibleRect(el, { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight });
