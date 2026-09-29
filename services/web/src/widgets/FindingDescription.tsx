import React from 'react';
import type { Finding } from '@/shared/verification';

/**
 * Описание находки в карточке верификации. Когда видна таблица «Сравнение по стадиям», значения и вывод уже в ней:
 * вместо повторяющегося текста показываем правило срабатывания из матрицы, а полное обоснование убираем под «Подробнее»
 * (в выгрузках таблицы нет, поэтому сам текст обоснования остаётся полным).
 */
export const FindingDescription: React.FC<{ finding: Finding }> = ({ finding }) => {
  const folded = (finding.stageComparisons?.length ?? 0) > 0 && Boolean(finding.triggerLogic);
  if (!folded) {
    return (
      <div className="ev-block">
        <div className="ev-lbl">Описание</div>
        <div style={{ fontSize: '12.5px', lineHeight: 1.6 }}>{finding.description}</div>
      </div>
    );
  }
  return (
    <div className="ev-block">
      <div className="ev-lbl">Правило срабатывания</div>
      <div style={{ fontSize: '12.5px', lineHeight: 1.6 }}>{finding.triggerLogic}</div>
      {finding.rationale && (
        <details style={{ marginTop: 6, fontSize: '12.5px', lineHeight: 1.6 }}>
          <summary style={{ cursor: 'pointer', color: '#64748B' }}>Подробнее</summary>
          <div style={{ marginTop: 4 }}>{finding.rationale}</div>
        </details>
      )}
    </div>
  );
};
