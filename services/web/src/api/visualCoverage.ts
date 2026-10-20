import { useQuery } from '@tanstack/react-query';
import { apiClient } from './client';
import type { components } from './schema';
import type { PagePair, PageRef } from './pagePairs';

/** Отчёт ML о покрытии графического поиска (`GET /protocols/{id}/visual-coverage`, контракт 0.25.0). */
export type VisualCoverageReport = components['schemas']['VisualCoverage'];
export type SkippedSheet = VisualCoverageReport['skipped'][number];
export type SkipReason = SkippedSheet['reason'];

/** Что нужно от файла комплекта, чтобы подписать лист названием документа. */
export interface FileLabel {
  id: string;
  original_name?: string;
  document_code?: string | null;
}

/** То, что показывает блок: итоги в листах и парах, лимиты, пропущенные листы. */
export interface Coverage {
  /** Листов-чертежей всего: проверенные плюс пропущенные. */
  sheetsTotal: number;
  /** Из них реально сравнили хотя бы с одним листом другой стадии. */
  sheetsChecked: number;
  pairsChecked: number;
  pairsPossible: number;
  limited: boolean;
  limits: VisualCoverageReport['limits'];
  skipped: SkippedSheet[];
  /** Всего пропущенных: в `skipped` не больше 500, остальные только в счётчике. */
  skippedTotal: number;
  /** Страниц с большим текстом (записки, акты, спецификации): отсеяны до графического поиска, не проверялись. */
  textHeavy: number;
}

/**
 * Отчёт api → итоги для экрана. Проверенные листы: те из `sheets`, с которыми сравнили хотя бы одну пару (лист, у которого
 * ни одной пары не успели проверить по лимиту, ML кладёт и в `sheets`, и в `skipped` с причиной `PAIRS_LIMIT`, его считаем
 * пропущенным). Листов всего = проверенные плюс `skipped_total`. Счётчики стадий (`candidates`, `mosaic`) не берём:
 * векторные мозаики входят и в кандидаты, и в мозаики, их сумма считала бы эти листы дважды.
 */
export const toCoverage = (report: VisualCoverageReport): Coverage => {
  const sheetsChecked = report.sheets.filter((sheet) => sheet.pairs_checked > 0).length;
  return {
    sheetsTotal: sheetsChecked + report.skipped_total,
    sheetsChecked,
    pairsChecked: report.pairs_checked,
    pairsPossible: report.pairs_possible,
    limited: report.limited,
    limits: report.limits,
    skipped: report.skipped,
    skippedTotal: report.skipped_total,
    textHeavy: report.stages.reduce((sum, stage) => sum + (stage.text_heavy ?? 0), 0),
  };
};

/** Причины пропуска по-русски: что пошло не так с листом. */
export const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  LIMIT: 'не вошёл в лимит листов',
  PAIRS_LIMIT: 'не хватило лимита пар',
  TIMEOUT: 'кончилось время',
  MOSAIC: 'лист-мозаика (векторный чертёж)',
  NO_DRAWING_REGION: 'растр слишком мал',
  TEXT_HEAVY: 'много текста (спецификация, таблица)',
};

export const skipReasonText = (reason: string): string => SKIP_REASON_TEXT[reason as SkipReason] ?? 'причина не указана';

/** Склонение по числу: `pluralRu(2, ['лист', 'листа', 'листов'])` → «листа». */
export const pluralRu = (n: number, forms: [string, string, string]): string => {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last === 1) return forms[0];
  if (last >= 2 && last <= 4) return forms[1];
  return forms[2];
};

/** После «из»: «из 3 листов», «из 21 листа». */
const ofSheets = (n: number): string => (n % 10 === 1 && n % 100 !== 11 ? 'листа' : 'листов');

const SHEETS: [string, string, string] = ['лист', 'листа', 'листов'];
const PAIRS: [string, string, string] = ['пара', 'пары', 'пар'];

/** «проверено 10 из 14 листов, 48 пар из 60» */
export const coverageSummary = (c: Coverage): string =>
  `проверено ${c.sheetsChecked} из ${c.sheetsTotal} ${ofSheets(c.sheetsTotal)}, ${c.pairsChecked} ${pluralRu(c.pairsChecked, PAIRS)} из ${c.pairsPossible}`;

/** Короткая строка, когда пропусков нет: «Все листы-чертежи проверены (14 листов, 42 пары)». */
export const fullCoverageText = (c: Coverage): string =>
  `Все листы-чертежи проверены (${c.sheetsTotal} ${pluralRu(c.sheetsTotal, SHEETS)}, ${c.pairsPossible} ${pluralRu(c.pairsPossible, PAIRS)})`;

/** Лимиты, при которых шёл ограниченный прогон: «до 12 листов на стадию, до 60 пар, до 600 с». Пусто, если ограничений нет. */
export const limitsText = (limits: Coverage['limits'] | undefined): string => {
  const parts: string[] = [];
  if (limits?.max_sheets_per_stage != null) parts.push(`до ${limits.max_sheets_per_stage} ${pluralRu(limits.max_sheets_per_stage, SHEETS)} на стадию`);
  if (limits?.max_pair_checks != null) parts.push(`до ${limits.max_pair_checks} ${pluralRu(limits.max_pair_checks, PAIRS)}`);
  if (limits?.budget_s != null) parts.push(`до ${Math.round(limits.budget_s)} с`);
  return parts.join(', ');
};

/** Подпись листа: шифр или имя файла и страница, например «ОВ-1, стр. 7». */
export const sheetLabel = (sheet: Pick<SkippedSheet, 'file_id' | 'page'>, files: readonly FileLabel[] = []): string => {
  const file = files.find((f) => f.id === sheet.file_id);
  return `${file?.document_code ?? file?.original_name ?? 'документ'}, стр. ${sheet.page}`;
};

const sameSheet = (a: Pick<PageRef, 'file_id' | 'page'>, b: Pick<SkippedSheet, 'file_id' | 'page'>) => a.file_id === b.file_id && a.page === b.page;

/** Пара, в которую входит пропущенный лист (если ML всё же сопоставил его), иначе undefined. */
export const pairOfSheet = (pairs: PagePair[], sheet: Pick<SkippedSheet, 'file_id' | 'page'>): PagePair | undefined =>
  pairs.find((pair) => sameSheet(pair.left, sheet) || sameSheet(pair.right, sheet));

/** Все листы проверены: ничего не пропущено и лимиты не остановили прогон. */
export const isFullCoverage = (c: Coverage): boolean => !c.limited && c.skippedTotal === 0;

/** Страницы-чертежи в комплекте не нашлись: отчёт есть, листов в нём нет. */
export const hasNoSheets = (c: Coverage): boolean => c.sheetsTotal === 0 && c.skippedTotal === 0;

/**
 * Отчёт покрытия по протоколу. 404 — отчёта нет (ML старше 0.9.0 событий, графический поиск выключен, в комплекте нет ПД):
 * блок не показываем, это не ошибка.
 */
export const useVisualCoverage = (protocolId: string | null | undefined) =>
  useQuery<Coverage | null>({
    queryKey: ['visual-coverage', protocolId],
    enabled: Boolean(protocolId),
    staleTime: 0,
    retry: 0,
    queryFn: async () => {
      const { data, response } = await apiClient.GET('/api/v1/protocols/{protocol_id}/visual-coverage', { params: { path: { protocol_id: protocolId! } } });
      if (response.status === 404) return null;
      if (!data) throw new Error('Не удалось загрузить покрытие графического поиска');
      return toCoverage(data);
    },
  });
