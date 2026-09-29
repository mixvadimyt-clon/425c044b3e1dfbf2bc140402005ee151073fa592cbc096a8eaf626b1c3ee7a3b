import { describe, expect, it } from 'vitest';
import { REGION_COLOR, STAGE_COLOR, boxOf, homographyToCss, pairTitle, pickPair, regionColor, regionShareText, regionSide, toRegions } from './pagePairs';
import type { PagePair } from './pagePairs';
import { buildPromoteBody, defaultRole } from './suspicions';
import type { Fragment } from './suspicions';

const ref = (stage: string, code: string) => ({ file_id: `f-${stage}`, page: 1, stage, document_code: code, sheet: '1' });

const pair = (over: Record<string, unknown> = {}): PagePair =>
  ({
    id: 'p1',
    left: ref('PD', 'KR-AR'),
    right: ref('RD', 'KZh01'),
    match_score: 0.912,
    homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    compliance_percent: 84,
    diff_regions: [
      { left_bbox: [0.58, 0.62, 0.78, 0.66], right_bbox: [0.57, 0.6, 0.77, 0.64], label: 'Класс бетона', finding_id: 'F1', suspicion_id: null },
      { left_bbox: [0.3, 0.2, 0.45, 0.32], right_bbox: [0.31, 0.21, 0.46, 0.33], suspicion_id: 'S1' },
      { left_bbox: [0, 0, 0.1, 0.1], right_bbox: [0, 0, 0.1, 0.1] },
    ],
    finding_ids: ['F1'],
    ...over,
  }) as unknown as PagePair;

describe('сравнение листов', () => {
  it('рамка api [x0, y0, x1, y1] в долях → проценты страницы', () => {
    const b = boxOf([0.1, 0.2, 0.4, 0.25]);
    expect(b.x).toBeCloseTo(10);
    expect(b.y).toBeCloseTo(20);
    expect(b.w).toBeCloseTo(30);
    expect(b.h).toBeCloseTo(5);
  });

  it('области: связаны с несоответствием, с гипотезой или просто различие', () => {
    const regions = toRegions(pair());
    expect(regions.map((r) => r.kind)).toEqual(['finding', 'suspicion', 'other']);
    expect(regions[0]).toMatchObject({ findingId: 'F1', label: 'Класс бетона' });
    expect(regions[1]).toMatchObject({ suspicionId: 'S1', label: 'Гипотеза' });
  });

  it('заголовок пары: стадии, шифры, лист и процент совпадения', () => {
    expect(pairTitle(pair())).toBe('ПД KR-AR, л. 1 ↔ РД KZh01, л. 1, 91 %');
  });

  it('какую пару открыть: с текущим несоответствием, затем с гипотезой, иначе первую', () => {
    const a = pair({ id: 'a', finding_ids: [], diff_regions: [] });
    const b = pair({ id: 'b' });
    expect(pickPair([a, b], 'F1')?.id).toBe('b');
    expect(pickPair([a, b], undefined, 'S1')?.id).toBe('b');
    expect(pickPair([a, b])?.id).toBe('a');
    expect(pickPair([])).toBeUndefined();
  });

  it('совмещение: единичная матрица не двигает страницу, без матрицы — без преобразования', () => {
    expect(homographyToCss([1, 0, 0, 0, 1, 0, 0, 0, 1], 800, 600)).toBe('matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)');
    expect(homographyToCss(null, 800, 600)).toBe('none');
    expect(homographyToCss([1, 0], 800, 600)).toBe('none');
  });

  it('совмещение: сдвиг на 10 % по x и 5 % по y даёт сдвиг в пикселях рамки', () => {
    const css = homographyToCss([1, 0, 0.1, 0, 1, 0.05, 0, 0, 1], 800, 600);
    // столбцы: последний столбец матрицы — сдвиг (80 px, 30 px)
    expect(css).toBe('matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,80,30,0,1)');
  });

  it('роль фрагмента гипотезы: у ранней стадии эталон, у остальных фактическое', () => {
    expect(defaultRole('PD', ['PD', 'RD'])).toBe('EXPECTED');
    expect(defaultRole('RD', ['PD', 'RD'])).toBe('ACTUAL');
    expect(defaultRole('RD', ['RD', 'ID'])).toBe('EXPECTED');
    expect(defaultRole('RD', ['RD'])).toBe('ACTUAL');
    expect(defaultRole('PD', ['PD'])).toBe('EXPECTED');
  });
});

describe('перевод гипотезы в кандидата', () => {
  const frag = (over: Record<string, unknown>) =>
    ({ id: 'old', role: 'CONTEXT', file_id: 'f-pd', sha256: 'aa', stage: 'PD', page: 1, bbox: [0.1, 0.1, 0.2, 0.2], polygon: null, extracted_value: '', normalized_value: '', ...over }) as unknown as Fragment;

  it('фрагменты уходят без чужого id и пустого polygon, пустое значение берётся по роли', () => {
    const body = buildPromoteBody({
      paramCode: 'M-055',
      expected: ' B30 ',
      actual: 'B25',
      comment: '',
      evidence: [frag({}), frag({ id: 'old2', stage: 'RD', file_id: 'f-rd', polygon: [[0, 0], [1, 0]] })],
      roles: { 0: 'EXPECTED', 1: 'ACTUAL' },
      removed: [],
      drafts: [],
      files: [],
    });
    expect(body.fragments).toHaveLength(2);
    expect(body.fragments[0]).not.toHaveProperty('id');
    expect(body.fragments[0]).not.toHaveProperty('polygon');
    expect(body.fragments[0]).toMatchObject({ role: 'EXPECTED', extracted_value: 'B30' });
    expect(body.fragments[1]).not.toHaveProperty('polygon');
    expect(body.fragments[1]).toMatchObject({ role: 'ACTUAL', extracted_value: 'B25' });
    expect(body).toMatchObject({ param_code: 'M-055', expected_value: 'B30', actual_value: 'B25' });
    expect(body).not.toHaveProperty('comment');
  });

  it('убранные фрагменты не уходят; нарисованная рамка получает sha256 файла и признак MANUAL', () => {
    const body = buildPromoteBody({
      paramCode: 'M-055',
      expected: '',
      actual: '',
      comment: 'Нашла сама',
      evidence: [frag({}), frag({ stage: 'RD' })],
      roles: {},
      removed: [0],
      drafts: [{ stage: 'РД', fileId: 'f-rd', page: 3, bbox: { x: 10, y: 20, w: 30, h: 5 }, role: 'ACTUAL', value: 'B25' }],
      files: [{ id: 'f-rd', sha256: 'bb', document_code: 'KZh01', revision: '0' }],
    });
    expect(body.fragments).toHaveLength(2);
    expect(body.fragments[1]).toMatchObject({ file_id: 'f-rd', sha256: 'bb', stage: 'RD', page: 3, source: 'MANUAL', extracted_value: 'B25', document_code: 'KZh01' });
    expect((body.fragments[1].bbox as number[])[2]).toBeCloseTo(0.4);
    expect(body.comment).toBe('Нашла сама');
  });
  it('цвет рамки: «только в ПД / РД / ИД» цветом стадии, остальное по виду области', () => {
    expect(regionColor({ kind: 'suspicion', label: 'только в ПД' })).toBe(STAGE_COLOR.PD);
    expect(regionColor({ kind: 'suspicion', label: 'только в РД' })).toBe(STAGE_COLOR.RD);
    expect(regionColor({ kind: 'suspicion', label: 'только в ИД' })).toBe(STAGE_COLOR.ID);
    expect(regionColor({ kind: 'suspicion', label: 'Гипотеза' })).toBe(REGION_COLOR.suspicion);
    expect(regionColor({ kind: 'finding', label: 'только в РД' })).toBe(REGION_COLOR.finding);
  });
  it('«только в ПД» относится к листу ПД, «только в РД» к листу РД, остальное к обоим', () => {
    const pair = { left: { stage: 'PD' }, right: { stage: 'RD' } } as PagePair;
    expect(regionSide({ label: 'только в ПД' }, pair)).toBe('left');
    expect(regionSide({ label: 'только в РД' }, pair)).toBe('right');
    expect(regionSide({ label: 'Гипотеза' }, pair)).toBeUndefined();
    expect(regionSide({ label: 'только в ИД' }, pair)).toBeUndefined();
  });
  it('доля листа: мелкие области с десятыми долями процента', () => {
    expect(regionShareText(0.0034)).toBe('занимает 0,3 % листа');
    expect(regionShareText(0.25)).toBe('занимает 25 % листа');
    expect(regionShareText(undefined)).toBe('');
  });
});
