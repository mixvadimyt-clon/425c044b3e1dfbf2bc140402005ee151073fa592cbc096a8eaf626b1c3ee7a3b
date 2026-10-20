import { useQuery } from '@tanstack/react-query';
import { apiClient } from './client';
import type { components } from './schema';

export type PagePair = components['schemas']['PagePair'];
export type DiffRegion = components['schemas']['DiffRegion'];
export type PageRef = components['schemas']['PageRef'];

/** `GET /protocols/{id}/page-pairs`: страницы разных стадий, которые ML счёл одним листом (сортировка по совпадению). */
export const usePagePairs = (protocolId: string | null | undefined, enabled = true) =>
  useQuery({
    queryKey: ['page-pairs', protocolId],
    enabled: Boolean(protocolId) && enabled,
    staleTime: 0,
    queryFn: async () => {
      const { data, error } = await apiClient.GET('/api/v1/protocols/{protocol_id}/page-pairs', { params: { path: { protocol_id: protocolId! } } });
      if (error || !data) throw new Error('Не удалось загрузить пары листов');
      return data;
    },
  });

const STAGE_RU: Record<string, string> = { PD: 'ПД', RD: 'РД', ID: 'ИД' };

export const stageLabel = (stage: string): string => STAGE_RU[stage] ?? stage;

/** Цвета стадий те же, что в панелях верификации: ПД синий, РД коричневый, ИД фиолетовый. */
export const STAGE_COLOR: Record<string, string> = { PD: '#2450C7', RD: '#B4620B', ID: '#5B4FBE' };

/** Рамка в процентах страницы (x, y — левый верхний угол). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** BBox api `[x0, y0, x1, y1]` в долях → проценты страницы. */
export const boxOf = (bbox: number[]): Box => {
  const [x0, y0, x1, y1] = bbox;
  return { x: x0 * 100, y: y0 * 100, w: (x1 - x0) * 100, h: (y1 - y0) * 100 };
};

/** Красные области связаны с несоответствием, жёлтые — с гипотезой, остальные (различие без записи) — серые. */
export type RegionKind = 'finding' | 'suspicion' | 'other';

export interface CompareRegion {
  key: string;
  kind: RegionKind;
  label: string;
  /** Рамка на левой странице пары (эталон) и на правой. */
  left: Box;
  right: Box;
  score?: number;
  findingId?: string;
  suspicionId?: string;
}

export const toRegions = (pair: PagePair): CompareRegion[] =>
  pair.diff_regions.map((region, index) => ({
    key: `${pair.id}-${index}`,
    kind: region.finding_id ? 'finding' : region.suspicion_id ? 'suspicion' : 'other',
    label: region.label ?? (region.finding_id ? 'Кандидат' : region.suspicion_id ? 'Гипотеза' : 'Различие'),
    left: boxOf(region.left_bbox),
    right: boxOf(region.right_bbox),
    score: region.score,
    findingId: region.finding_id ?? undefined,
    suspicionId: region.suspicion_id ?? undefined,
  }));

export const REGION_COLOR: Record<RegionKind, string> = { finding: '#D92D20', suspicion: '#F79009', other: '#667085' };

/** Слово стадии из подписи «только в РД» (гипотезы визуального сравнения). */
const onlyInWord = (label: string): string | undefined => /^только в (ПД|РД|ИД)/i.exec(label)?.[1]?.toUpperCase();

/**
 * На каком листе пары различие существует: «только в ПД» есть на листе ПД и не имеет смысла на листе РД.
 * Для остальных областей (различие в обеих стадиях) вернёт undefined: рисуем на обоих листах.
 */
export const regionSide = (region: Pick<CompareRegion, 'label'>, pair: Pick<PagePair, 'left' | 'right'>): 'left' | 'right' | undefined => {
  const word = onlyInWord(region.label);
  if (!word) return undefined;
  const left = stageLabel(pair.left.stage) === word;
  const right = stageLabel(pair.right.stage) === word;
  return left === right ? undefined : left ? 'left' : 'right';
};

/** Сколько листа занимает различие: `score` из api это доля площади листа, у мелких областей меньше процента. */
export const regionShareText = (score: number | undefined): string => {
  if (score === undefined) return '';
  const percent = score * 100;
  return `занимает ${percent >= 10 ? Math.round(percent) : percent.toFixed(1).replace('.', ',')} % листа`;
};

const STAGE_BY_WORD: Record<string, string> = { 'ПД': 'PD', 'РД': 'RD', 'ИД': 'ID' };

/**
 * Цвет рамки. У областей «только в ПД / РД / ИД» (гипотезы визуального сравнения) цвет стадии, как в панелях верификации:
 * так видно, в каком документе есть то, чего нет в другом. Остальные области по виду: кандидат, гипотеза, различие.
 */
export const regionColor = (region: Pick<CompareRegion, 'kind' | 'label'>): string => {
  const stage = region.kind === 'suspicion' ? STAGE_BY_WORD[onlyInWord(region.label) ?? ''] : undefined;
  return (stage && STAGE_COLOR[stage]) || REGION_COLOR[region.kind];
};

/** «ПД KR-AR, л. 1 ↔ РД KZh01, л. 1 · 91 %» */
export const pairTitle = (pair: PagePair): string => {
  const side = (ref: PageRef) => `${stageLabel(ref.stage)} ${ref.document_code ?? ref.original_name ?? ''}, ${ref.sheet ? `л. ${ref.sheet}` : `стр. ${ref.page}`}`;
  return `${side(pair.left)} ↔ ${side(pair.right)}, ${Math.round(pair.match_score * 100)} %`;
};

/** Какую пару открыть сначала: с текущим несоответствием или гипотезой, иначе лучшая по совпадению (api отдаёт по убыванию). */
export const pickPair = (pairs: PagePair[], findingId?: string, suspicionId?: string): PagePair | undefined =>
  pairs.find((p) => findingId && p.finding_ids?.includes(findingId)) ??
  pairs.find((p) => suspicionId && p.diff_regions.some((r) => r.suspicion_id === suspicionId)) ??
  pairs[0];

const isHomography = (h: number[] | null | undefined): h is number[] => Array.isArray(h) && h.length === 9 && h.every((v) => Number.isFinite(v));

/**
 * CSS-преобразование, которое накладывает правую страницу на левую: `homography` переводит нормализованные координаты
 * правой страницы в нормализованные координаты левой; страница рисуется в рамке размером w × h пикселей левой.
 * Без совмещения (`null`) — страница как есть.
 */
export const homographyToCss = (h: number[] | null | undefined, w: number, hgt: number): string => {
  if (!isHomography(h) || w <= 0 || hgt <= 0) return 'none';
  // H_px = S · H · S⁻¹, S = diag(w, h, 1); matrix3d принимает по столбцам
  const m = (i: number, j: number) => {
    const s = [w, hgt, 1];
    return (s[i] * h[i * 3 + j]) / s[j];
  };
  const values = [m(0, 0), m(1, 0), 0, m(2, 0), m(0, 1), m(1, 1), 0, m(2, 1), 0, 0, 1, 0, m(0, 2), m(1, 2), 0, m(2, 2)];
  return `matrix3d(${values.map((v) => +v.toFixed(6)).join(',')})`;
};
