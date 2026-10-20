import type React from 'react';
import type { TrainerStage, TrainerVerdict } from '@/shared/trainer';
import type { TrainerHypothesisStatus } from '@/shared/trainer';

export const STAGES: TrainerStage[] = ['ПД', 'РД', 'ИД'];
export const STAGE_COLORS: Record<TrainerStage, string> = { ПД: '#2450C7', РД: '#B4620B', ИД: '#5B4FBE' };
// Рамки значений, как в настоящих панелях: ожидаемое (проектное) синим, фактическое оранжевым
export const MARK_COLORS: Record<TrainerStage, string> = { ПД: '#2450C7', РД: '#B4620B', ИД: '#B4620B' };
export const VERDICT_BADGE: Record<TrainerVerdict, { cls: string; label: string }> = {
  pending: { cls: 'badge-amber', label: 'ОЖИДАЕТ' },
  confirmed: { cls: 'badge-green', label: 'ПОДТВЕРЖДЕНО' },
  rejected: { cls: 'badge-red', label: 'ОТКЛОНЕНО' },
  clarification: { cls: 'badge-slate', label: 'УТОЧНЕНО' },
};

// Те же кнопки, что в шапке настоящей верификации
const BUTTON_BASE: React.CSSProperties = {
  boxSizing: 'border-box',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: 32,
  borderRadius: 8,
  padding: '0 14px',
  fontSize: 13,
  fontWeight: 600,
  lineHeight: 1,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};
export const WHITE_BUTTON: React.CSSProperties = { ...BUTTON_BASE, backgroundColor: '#FFFFFF', color: '#101828', border: '1px solid #CBD3DE' };
export const TEAL_BUTTON: React.CSSProperties = { ...BUTTON_BASE, backgroundColor: '#12988C', color: '#FFFFFF', border: 'none' };

/** Горячие клавиши настоящей верификации (окно по кнопке «?»). */
export const HOTKEYS: Array<[string, string]> = [
  ['1', 'Подтвердить нарушение (у гипотезы: сделать кандидатом)'],
  ['2', 'Отклонить: у кандидата затем 1-8 причина, у гипотезы комментарий'],
  ['3', 'Уточнить (то же у гипотезы)'],
  ['← →', 'Предыдущий и следующий кандидат'],
  ['N', 'К следующему кандидату без решения'],
  ['PgUp PgDn', 'Страница назад и вперёд во всех панелях сразу (если в документе больше одной страницы)'],
  ['E', 'Править доказательства'],
  ['S', 'Разделить на части (у составного несоответствия)'],
  ['Enter', 'Отправить решение с комментарием (отклонение, уточнение) или создать кандидата из гипотезы; Shift + Enter новая строка'],
  ['F', 'Во весь экран и обратно'],
  ['Esc', 'Выйти из полноэкранного режима, закрыть правку доказательств, список причин, форму комментария (у кандидата и у гипотезы) или сбросить массовый выбор'],
  ['Shift + /', 'Эта подсказка'],
];

/** Текущие дата и время в виде «16.10.26 12:00»: так записываются решения и версии в истории. */
export const nowText = (): string => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)} ${p(d.getHours())}:${p(d.getMinutes())}`;
};


export const HYPOTHESIS_BADGE: Record<TrainerHypothesisStatus, { cls: string; label: string }> = {
  PENDING: { cls: 'badge-amber', label: 'ОЖИДАЕТ' },
  CLARIFICATION_REQUIRED: { cls: 'badge-slate', label: 'УТОЧНЕНО' },
  DISMISSED: { cls: 'badge-red', label: 'ОТКЛОНЕНО' },
  PROMOTED: { cls: 'badge-green', label: 'КАНДИДАТ' },
};
