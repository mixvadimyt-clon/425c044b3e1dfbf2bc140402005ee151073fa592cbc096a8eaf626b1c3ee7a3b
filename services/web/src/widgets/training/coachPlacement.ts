/** Подсказка урока рядом с тем, о чём она говорит: куда поставить карточку, чтобы она не закрывала подсвеченное. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type CoachSide = 'right' | 'left' | 'bottom' | 'top' | 'between';

/** Стрелка на краю карточки: с какого края торчит и на каком расстоянии от угла. */
export interface CoachArrow {
  edge: 'left' | 'right' | 'top' | 'bottom';
  offset: number;
}

export interface CoachPlacement {
  left: number;
  top: number;
  width: number;
  /** С какой стороны от подсвеченного стоит карточка. */
  side: CoachSide;
  arrows: CoachArrow[];
}

export type CoachSizes = Record<'top' | 'bottom' | 'left' | 'right', { width: number; height: number }>;

/** Зазор между карточкой и подсвеченным: кончик стрелки (около 8 px) почти касается подсвеченной области. */
export const GAP = 14;
const MARGIN = 12;
const ARROW_EDGE = 22;
/** Узкая карточка не бывает уже этого: иначе текст превращается в длинный столбик. */
const MIN_BETWEEN = 300;
const MIN_SIDE = 300;
/** Ширина карточки за вычетом ширины текста (поля и номер шага): по ней пересчитывается высота при сужении. */
const TEXT_INSET = 44;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
const width = (b: Box) => b.right - b.left;
const height = (b: Box) => b.bottom - b.top;
const centerX = (b: Box) => (b.left + b.right) / 2;
const centerY = (b: Box) => (b.top + b.bottom) / 2;

export const unionOf = (boxes: Box[]): Box => ({
  left: Math.min(...boxes.map((b) => b.left)),
  top: Math.min(...boxes.map((b) => b.top)),
  right: Math.max(...boxes.map((b) => b.right)),
  bottom: Math.max(...boxes.map((b) => b.bottom)),
});

const overlap = (a: Box, b: Box): number => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

/** Расстояние между рамками (0, если пересекаются). */
const distance = (a: Box, b: Box): number => {
  const dx = Math.max(0, a.left - b.right, b.left - a.right);
  const dy = Math.max(0, a.top - b.bottom, b.top - a.bottom);
  return Math.hypot(dx, dy);
};

/** Ближайшее к карточке подсвеченное: на него смотрит стрелка. */
export const nearestBox = (card: Box, lit: Box[]): Box => lit.reduce((best, b) => (distance(card, b) < distance(card, best) ? b : best));

/** Стрелка с края карточки на ближайшее подсвеченное. */
export const arrowFor = (card: Box, lit: Box[], edge: CoachArrow['edge']): CoachArrow => {
  const target = nearestBox(card, lit);
  const offset = edge === 'left' || edge === 'right' ? clamp(centerY(target) - card.top, ARROW_EDGE, height(card) - ARROW_EDGE) : clamp(centerX(target) - card.left, ARROW_EDGE, width(card) - ARROW_EDGE);
  return { edge, offset };
};

const EDGE_OF_SIDE: Record<'top' | 'bottom' | 'left' | 'right', CoachArrow['edge']> = { bottom: 'top', top: 'bottom', right: 'left', left: 'right' };

/**
 * Ставит карточку подсказки рядом с подсвеченным и не закрывает ни одну подсвеченную рамку.
 * - Подсвеченное одной группой (занимает не больше половины высоты окна, например полоса прогресса с кнопками, или не
 *   шире 45 % ширины, например колонка слева): карточка по центру группы, стрелка на центр группы.
 * - Подсвеченное разнесено (две панели по краям): сначала пробуем встать между двумя разнесёнными, со стрелкой на каждую;
 *   потом рядом с каждой рамкой по отдельности, главная первой.
 * - Элементы шапки (верхняя часть окна, невысокие: лампочка, колокольчик): карточка снизу, над ними места нет.
 * - Узкая цель (меньше 45 % ширины окна: кнопка, колонка слева, даже высокая): карточка сбоку, узкая; если сбоку тесно, то над
 *   целью, потом под ней. Широкая цель (таблица, ряд карточек): над ней, если подпись не закроет шапку страницы, иначе под ней; широкая.
 * Если места нет нигде, возвращает null: тогда подсказка стоит широкой полосой вверху.
 */
export const placeCoach = (lit: Box[], sizes: CoachSizes, viewport: { width: number; height: number }, prefer?: CoachSide, topSafe = 0): CoachPlacement | null => {
  if (lit.length === 0) return null;
  const fits = (rect: Box): boolean => rect.left >= 0 && rect.top >= 0 && rect.right <= viewport.width && rect.bottom <= viewport.height && lit.every((box) => overlap(rect, box) === 0);

  const around = (anchor: Box): CoachPlacement | null => {
    const header = anchor.top < viewport.height * 0.12 && height(anchor) < viewport.height * 0.12;
    const narrowShape = width(anchor) < viewport.width * 0.45;
    // Над широкой целью подпись только если она не закроет шапку и заголовок страницы (`topSafe`): иначе под целью
    const topFits = anchor.top - GAP - sizes.top.height >= topSafe;
    // Только для страниц с шапкой (`topSafe` задан, например протокол): невысокая цель (кнопка, поле, плитка) подписывается над
    // или под собой по центру, а не сбоку, потому что на большом экране боковая подпись уходит к краю страницы. Высокая узкая
    // цель (колонка, список, панель) и учебные экраны верификации подписываются сбоку, как раньше.
    const compact = topSafe > 0 && height(anchor) < viewport.height * 0.25;
    const sides: Array<'top' | 'bottom' | 'left' | 'right'> = header
      ? ['bottom', 'right', 'left', 'top']
      : narrowShape && !compact
        ? ['right', 'left', 'top', 'bottom']
        : topFits
          ? ['top', 'bottom', 'right', 'left']
          : ['bottom', 'top', 'right', 'left'];
    // Прежняя сторона, если она всё ещё подходит, остаётся: иначе при небольших ошибках оценки высоты подсказка мигала бы между сторонами
    const ordered = prefer && sides.includes(prefer as 'top' | 'bottom' | 'left' | 'right') ? [prefer as 'top' | 'bottom' | 'left' | 'right', ...sides.filter((s) => s !== prefer)] : sides;
    for (const side of ordered) {
      let size = sizes[side];
      // Сбоку карточка сужается до свободного места (не уже MIN_SIDE): текст становится выше, но подпись не уходит на цель
      if (side === 'right' || side === 'left') {
        const available = side === 'right' ? viewport.width - MARGIN - (anchor.right + GAP) : anchor.left - GAP - MARGIN;
        if (available < size.width) {
          if (available < MIN_SIDE) continue;
          size = { width: available, height: size.height * (Math.max(1, size.width - TEXT_INSET) / Math.max(1, available - TEXT_INSET)) };
        }
      }
      let left: number;
      let top: number;
      if (side === 'right') {
        left = anchor.right + GAP;
        top = centerY(anchor) - size.height / 2;
      } else if (side === 'left') {
        left = anchor.left - GAP - size.width;
        top = centerY(anchor) - size.height / 2;
      } else if (side === 'bottom') {
        left = centerX(anchor) - size.width / 2;
        top = anchor.bottom + GAP;
      } else {
        left = centerX(anchor) - size.width / 2;
        top = anchor.top - GAP - size.height;
      }
      left = clamp(left, MARGIN, viewport.width - size.width - MARGIN);
      top = clamp(top, MARGIN, viewport.height - size.height - MARGIN);
      const rect: Box = { left, top, right: left + size.width, bottom: top + size.height };
      if (fits(rect)) return { left, top, width: size.width, side, arrows: [arrowFor(rect, [anchor], EDGE_OF_SIDE[side])] };
    }
    return null;
  };

  const all = unionOf(lit);
  const clustered = height(all) <= viewport.height * 0.5 || width(all) <= viewport.width * 0.45;
  if (clustered) return around(all);

  // Две разнесённые области: карточка между ними, стрелка на каждую
  const byLeft = [...lit].sort((a, b) => a.left - b.left);
  const first = byLeft[0];
  const last = byLeft[byLeft.length - 1];
  const gap = last.left - first.right;
  if (lit.length >= 2 && gap >= MIN_BETWEEN + GAP * 2) {
    const size = sizes.left;
    const w = Math.min(size.width, gap - GAP * 2);
    const h = size.height * (size.width / w);
    const left = first.right + GAP + (gap - GAP * 2 - w) / 2;
    const top = clamp(centerY(all) - h / 2, MARGIN, viewport.height - h - MARGIN);
    const rect: Box = { left, top, right: left + w, bottom: top + h };
    if (fits(rect)) return { left, top, width: w, side: 'between', arrows: [arrowFor(rect, [first], 'left'), arrowFor(rect, [last], 'right')] };
  }

  for (const anchor of lit) {
    const placed = around(anchor);
    if (placed) return placed;
  }
  return null;
};
