/** Плавающие панели полного экрана: сдвиг от исходного места (левая панель привязана слева, правая справа). */
export interface PanelOffset {
  x: number;
  y: number;
}

/** Сколько панели обязательно остаётся на экране: заголовок и полоса шириной в 60 пикселей, чтобы её можно было схватить. */
const VISIBLE = 60;
const MARGIN_X = 20;
const MARGIN_Y = 84;

/**
 * Не даёт вынести панель за экран: по горизонтали остаётся видимой полоса в 60 пикселей, по вертикали заголовок.
 * Левая панель стоит на `20 + x` от левого края, правая на `20 - x` от правого.
 */
export const clampPanelOffset = (panel: 'findings' | 'evidence', offset: PanelOffset, width: number, viewport: { width: number; height: number }): PanelOffset => {
  const y = Math.min(viewport.height - 48 - MARGIN_Y, Math.max(-MARGIN_Y, offset.y));
  if (panel === 'findings') {
    return { x: Math.min(viewport.width - VISIBLE - MARGIN_X, Math.max(VISIBLE - MARGIN_X - width, offset.x)), y };
  }
  return { x: Math.min(width - VISIBLE + MARGIN_X, Math.max(VISIBLE - viewport.width + MARGIN_X, offset.x)), y };
};
