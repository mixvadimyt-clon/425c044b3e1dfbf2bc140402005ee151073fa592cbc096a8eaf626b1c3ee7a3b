import { describe, expect, it } from 'vitest';
import { coverageSummary, fullCoverageText, hasNoSheets, isFullCoverage, limitsText, pairOfSheet, pluralRu, sheetLabel, skipReasonText, toCoverage } from './visualCoverage';
import type { Coverage, VisualCoverageReport } from './visualCoverage';
import type { PagePair } from './pagePairs';

/** Как отвечает ML-заглушка (`ML_TRANSPORT=stub`), когда в комплекте два файла РД: второй не вошёл в лимит. */
const stubReport = (over: Partial<VisualCoverageReport> = {}): VisualCoverageReport => ({
  limited: true,
  limits: { max_sheets_per_stage: 1, max_pair_checks: 400, budget_s: 600 },
  duration_ms: 1200,
  stages: [
    { stage: 'PD', pages: 1, candidates: 1, taken: 1, text_heavy: 0, mosaic: 0 },
    { stage: 'RD', pages: 2, candidates: 2, taken: 1, text_heavy: 0, mosaic: 0 },
  ],
  pairs_possible: 1,
  pairs_checked: 1,
  pairs_matched: 1,
  sheets: [
    { file_id: 'f-pd', page: 1, stage: 'PD', pairs_checked: 1, pairs_possible: 1, matched: true },
    { file_id: 'f-rd', page: 1, stage: 'RD', pairs_checked: 1, pairs_possible: 1, matched: true },
  ],
  skipped: [{ file_id: 'f-rd2', page: 1, stage: 'RD', reason: 'LIMIT' }],
  skipped_total: 1,
  ...over,
});

const coverage = (over: Partial<Coverage> = {}): Coverage => ({
  sheetsTotal: 14,
  sheetsChecked: 9,
  pairsChecked: 48,
  pairsPossible: 60,
  limited: true,
  limits: { max_sheets_per_stage: 12, max_pair_checks: 60, budget_s: 600 },
  skipped: [],
  skippedTotal: 0,
  textHeavy: 0,
  ...over,
});

const pair = (leftPage: number, rightPage: number): PagePair =>
  ({
    id: `p${leftPage}`,
    left: { file_id: 'f-pd', page: leftPage, stage: 'PD' },
    right: { file_id: 'f-rd', page: rightPage, stage: 'RD' },
    match_score: 0.9,
    diff_regions: [],
  }) as unknown as PagePair;

describe('pluralRu', () => {
  it('склоняет по числу', () => {
    expect(pluralRu(1, ['лист', 'листа', 'листов'])).toBe('лист');
    expect(pluralRu(3, ['лист', 'листа', 'листов'])).toBe('листа');
    expect(pluralRu(11, ['лист', 'листа', 'листов'])).toBe('листов');
    expect(pluralRu(14, ['лист', 'листа', 'листов'])).toBe('листов');
    expect(pluralRu(21, ['лист', 'листа', 'листов'])).toBe('лист');
  });
});

describe('отчёт api → итоги экрана', () => {
  it('ограниченный прогон заглушки: 3 листа, один пропущен, проверено 2', () => {
    const c = toCoverage(stubReport());
    expect(c).toMatchObject({ sheetsTotal: 3, sheetsChecked: 2, pairsChecked: 1, pairsPossible: 1, limited: true, skippedTotal: 1, textHeavy: 0 });
    expect(c.skipped).toHaveLength(1);
  });

  it('мозаика-чертёж входит и в кандидаты, и в счётчик мозаик, но листом считается один раз', () => {
    const taken = (stage: 'PD' | 'RD', n: number) => Array.from({ length: n }, (_, i) => ({ file_id: `${stage}-${i}`, page: 1, stage, pairs_checked: 1, matched: false }));
    const c = toCoverage(
      stubReport({
        limited: false,
        // ПД: 5 кандидатов (среди них мозаика-чертёж), мозаик 2 (вторая не чертёж и пропущена); РД: 3 кандидата
        stages: [
          { stage: 'PD', pages: 10, candidates: 5, taken: 5, text_heavy: 5, mosaic: 2 },
          { stage: 'RD', pages: 6, candidates: 3, taken: 3, text_heavy: 2, mosaic: 0 },
        ],
        sheets: [...taken('PD', 5), ...taken('RD', 3)],
        skipped: [{ file_id: 'm', page: 2, stage: 'PD', reason: 'MOSAIC' }],
        skipped_total: 1,
      }),
    );
    expect(c.sheetsTotal).toBe(9);
    expect(c.sheetsChecked).toBe(8);
    expect(c.textHeavy).toBe(7);
  });

  it('лист, у которого не успели проверить ни одной пары, считается пропущенным, а не проверенным', () => {
    const c = toCoverage(
      stubReport({
        sheets: [
          { file_id: 'a', page: 1, stage: 'PD', pairs_checked: 3, pairs_possible: 3, matched: true },
          { file_id: 'b', page: 1, stage: 'RD', pairs_checked: 0, pairs_possible: 2, matched: false },
        ],
        skipped: [{ file_id: 'b', page: 1, stage: 'RD', reason: 'PAIRS_LIMIT' }],
        skipped_total: 1,
      }),
    );
    expect(c.sheetsChecked).toBe(1);
    expect(c.sheetsTotal).toBe(2);
  });

  it('ничего не проверено: 0 из N', () => {
    const c = toCoverage(stubReport({ sheets: [], skipped_total: 3 }));
    expect(c.sheetsChecked).toBe(0);
    expect(c.sheetsTotal).toBe(3);
  });

  it('полный прогон без пропусков', () => {
    const c = toCoverage(stubReport({ limited: false, skipped: [], skipped_total: 0, stages: [{ stage: 'PD', pages: 1, candidates: 1, taken: 1, text_heavy: 0, mosaic: 0 }, { stage: 'RD', pages: 1, candidates: 1, taken: 1, text_heavy: 0, mosaic: 0 }] }));
    expect(isFullCoverage(c)).toBe(true);
    expect(c.sheetsChecked).toBe(2);
  });
});

describe('текст покрытия', () => {
  it('строка «проверено N из M листов, K пар из L»', () => {
    expect(coverageSummary(coverage())).toBe('проверено 9 из 14 листов, 48 пар из 60');
    expect(coverageSummary(coverage({ sheetsChecked: 2, sheetsTotal: 3, pairsChecked: 1, pairsPossible: 2 }))).toBe('проверено 2 из 3 листов, 1 пара из 2');
    expect(coverageSummary(coverage({ sheetsChecked: 20, sheetsTotal: 21 }))).toBe('проверено 20 из 21 листа, 48 пар из 60');
  });

  it('действовавшие лимиты по-русски, без ограничений пусто', () => {
    expect(limitsText({ max_sheets_per_stage: 12, max_pair_checks: 60, budget_s: 600 })).toBe('до 12 листов на стадию, до 60 пар, до 600 с');
    expect(limitsText({ max_sheets_per_stage: 1, max_pair_checks: null, budget_s: null })).toBe('до 1 лист на стадию');
    expect(limitsText({ max_sheets_per_stage: null, max_pair_checks: null, budget_s: null })).toBe('');
    expect(limitsText(undefined)).toBe('');
  });

  it('все листы проверены: короткая строка с числами', () => {
    expect(fullCoverageText(coverage({ sheetsTotal: 14, pairsPossible: 42, limited: false }))).toBe('Все листы-чертежи проверены (14 листов, 42 пары)');
  });

  it('причины пропуска по-русски, неизвестная причина не ломает список', () => {
    expect(skipReasonText('LIMIT')).toBe('не вошёл в лимит листов');
    expect(skipReasonText('PAIRS_LIMIT')).toBe('не хватило лимита пар');
    expect(skipReasonText('TIMEOUT')).toBe('кончилось время');
    expect(skipReasonText('MOSAIC')).toBe('лист-мозаика (векторный чертёж)');
    expect(skipReasonText('NO_DRAWING_REGION')).toBe('растр слишком мал');
    expect(skipReasonText('TEXT_HEAVY')).toBe('много текста (спецификация, таблица)');
    expect(skipReasonText('СТРАННАЯ')).toBe('причина не указана');
  });

  it('подпись листа: шифр документа, иначе имя файла, иначе «документ»', () => {
    const files = [
      { id: 'a', original_name: 'ov.pdf', document_code: 'ОВ-1' },
      { id: 'b', original_name: 'plan.pdf', document_code: null },
    ];
    expect(sheetLabel({ file_id: 'a', page: 7 }, files)).toBe('ОВ-1, стр. 7');
    expect(sheetLabel({ file_id: 'b', page: 2 }, files)).toBe('plan.pdf, стр. 2');
    expect(sheetLabel({ file_id: 'x', page: 1 }, files)).toBe('документ, стр. 1');
  });
});

describe('состояние отчёта', () => {
  it('отчёт есть, листов-чертежей нет', () => {
    expect(hasNoSheets(coverage({ sheetsTotal: 0, sheetsChecked: 0, pairsPossible: 0 }))).toBe(true);
    expect(hasNoSheets(coverage())).toBe(false);
  });

  it('полное покрытие: без лимитов и без пропусков', () => {
    expect(isFullCoverage(coverage({ limited: false, skippedTotal: 0 }))).toBe(true);
    expect(isFullCoverage(coverage({ limited: true, skippedTotal: 0 }))).toBe(false);
    expect(isFullCoverage(coverage({ limited: false, skippedTotal: 2 }))).toBe(false);
  });
});

describe('открыть пропущенный лист', () => {
  it('находит пару, в которую входит лист (слева или справа), иначе ничего', () => {
    const pairs = [pair(1, 3), pair(2, 4)];
    expect(pairOfSheet(pairs, { file_id: 'f-pd', page: 2 })?.id).toBe('p2');
    expect(pairOfSheet(pairs, { file_id: 'f-rd', page: 3 })?.id).toBe('p1');
    expect(pairOfSheet(pairs, { file_id: 'f-pd', page: 9 })).toBeUndefined();
  });
});
