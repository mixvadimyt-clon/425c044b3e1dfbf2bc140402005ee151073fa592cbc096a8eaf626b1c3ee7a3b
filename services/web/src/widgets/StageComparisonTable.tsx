import React from 'react';
import { StatusPill } from './StatusPill';
import type { StageComparisonRow } from '@/shared/stageComparisons';

/**
 * Сравнение по стадиям: у каждой стадии своя строка (стадия, значение, плашка), ниже отклонение и вывод.
 * Не таблица: карточка находки узкая, четыре колонки в ней обрезают плашки.
 */
export const StageComparisonTable: React.FC<{ rows: StageComparisonRow[] }> = ({ rows }) => (
  <div>
    {rows.map((row, index) => (
      <div key={row.stage} style={{ padding: '8px 0', borderTop: index === 0 ? undefined : '1px solid #E2E8F0', fontSize: 13 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <b style={{ minWidth: 26 }}>{row.stage}</b>
          <span>{row.value}</span>
          <StatusPill tone={row.triggered ? 'error' : 'success'}>{row.triggered ? 'Нарушение' : 'В допуске'}</StatusPill>
        </div>
        {row.delta && <div style={{ marginTop: 2, color: '#475569' }}>Разница: {row.delta}</div>}
        {row.verdict && <div style={{ marginTop: 2, color: '#475569' }}>{row.verdict}</div>}
      </div>
    ))}
  </div>
);
