/** Масштаб (в процентах) и сдвиг страницы: общее состояние для синхронных панелей. */
export interface ZoomView {
  zoom: number;
  pan: { x: number; y: number };
}

export const DEFAULT_ZOOM_VIEW: ZoomView = { zoom: 100, pan: { x: 0, y: 0 } };

/** Границы масштаба: большие схемы приближаются до 1600 %, чтобы разглядеть мелкие значения. */
export const MIN_ZOOM = 50;
export const MAX_ZOOM = 1600;

/** Шаг масштаба растёт вместе с ним, иначе до 1600 % пришлось бы нажимать десятки раз: на 400 % и больше он в четыре раза крупнее, на 200 % и больше вдвое. */
export const zoomStep = (zoom: number, base: number): number => (zoom >= 400 ? base * 4 : zoom >= 200 ? base * 2 : base);

/**
 * Ограничивает сдвиг, как в обычных просмотрщиках: страница не выходит за границы панели.
 * Увеличенная страница двигается, пока её край не дойдёт до края панели, уменьшенная остаётся целиком внутри.
 * Сдвиг лежит внутри `scale()`, поэтому смещение на экране равно pan × масштаб.
 */
export const clampPan = (pan: { x: number; y: number }, zoomPercent: number, width: number, height: number): { x: number; y: number } => {
  const z = Math.max(zoomPercent, 1) / 100;
  const limit = (size: number) => (Math.abs(1 - z) * size) / (2 * z);
  const cap = (value: number, max: number) => Math.min(max, Math.max(-max, value));
  return { x: cap(pan.x, limit(width)), y: cap(pan.y, limit(height)) };
};
