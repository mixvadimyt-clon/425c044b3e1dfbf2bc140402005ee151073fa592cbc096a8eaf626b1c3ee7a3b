import type { components } from '@/api/schema';
import { DOC_STAGE_LABEL } from './statuses';

type ApiStageComparison = components['schemas']['StageComparison'];

/** Сравнение одной стадии с эталоном ПД для карточки находки. */
export interface StageComparisonRow {
  stage: string;
  /** Как записано в документе, иначе нормализованное значение. */
  value: string;
  delta?: string;
  triggered: boolean;
  verdict?: string;
}

/**
 * Строки таблицы «по каждой стадии» (`Finding.stage_comparisons`, контракт 0.17.0). Таблица нужна, когда сравнивались
 * и РД, и ИД: с одной стадией всё уже видно в блоке «Ожидается и фактически». У протоколов до 0.17.0 массив пуст.
 */
export const toStageComparisons = (items: ApiStageComparison[] | undefined): StageComparisonRow[] => {
  if (!items || items.length < 2) return [];
  return items.map((item) => ({
    stage: DOC_STAGE_LABEL[item.stage] ?? item.stage,
    value: item.raw_value ?? item.value ?? 'нет',
    delta: item.delta ?? undefined,
    triggered: item.triggered,
    verdict: item.verdict ?? undefined,
  }));
};
