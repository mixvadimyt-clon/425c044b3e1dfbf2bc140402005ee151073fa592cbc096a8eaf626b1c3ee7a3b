import React from 'react';
import type { SuspicionFilter } from '@/api/suspicions';

export type CandidateFilter = 'all' | 'pending' | 'confirmed' | 'rejected' | 'clarified';

const CANDIDATE_TABS: Array<{ key: CandidateFilter; label: string }> = [
  { key: 'all', label: 'Все' },
  { key: 'pending', label: 'Ожидают' },
  { key: 'confirmed', label: 'Подтверждено' },
  { key: 'rejected', label: 'Отклонено' },
  { key: 'clarified', label: 'Уточнено' },
];

const HYPOTHESIS_TABS: Array<{ key: SuspicionFilter; label: string }> = [
  { key: 'all', label: 'Все' },
  { key: 'PENDING', label: 'Ожидают' },
  { key: 'CLARIFICATION_REQUIRED', label: 'Уточнено' },
  { key: 'DISMISSED', label: 'Отклонено' },
  { key: 'PROMOTED', label: 'Кандидаты' },
];

interface SectionProps<K extends string> {
  title: string;
  open: boolean;
  onToggle: () => void;
  tabs: Array<{ key: K; label: string }>;
  counts: Record<K, number>;
  value: K;
  onChange: (key: K) => void;
}

/** Раздел фильтра: заголовок сворачивает группу в списке, под ним — фильтры по статусу этой группы. */
function Section<K extends string>({ title, open, onToggle, tabs, counts, value, onChange }: SectionProps<K>) {
  return (
    <div className="lf-section">
      <button className="lf-head" onClick={onToggle} aria-expanded={open} title={open ? `Скрыть «${title}» из списка` : `Показать «${title}» в списке`}>
        <span className="lf-chevron">{open ? '▾' : '▸'}</span>
        {title}
        <span className="lf-count">{counts[tabs[0].key]}</span>
      </button>
      {open && (
        <div className="vw-findings-tabs">
          {tabs.map((t) => (
            <button key={t.key} className={`vw-tab ${value === t.key ? 'active' : ''}`} onClick={() => onChange(t.key)}>
              {t.label} ({counts[t.key]})
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface Props {
  candidates: {
    open: boolean;
    onToggle: () => void;
    counts: Record<CandidateFilter, number>;
    value: CandidateFilter;
    onChange: (key: CandidateFilter) => void;
  };
  hypotheses: {
    open: boolean;
    onToggle: () => void;
    counts: Record<SuspicionFilter, number>;
    value: SuspicionFilter;
    onChange: (key: SuspicionFilter) => void;
  };
  query: string;
  onQuery: (value: string) => void;
  extra?: React.ReactNode;
}

/** Фильтр единого списка: раздел «Кандидаты» и раздел «Гипотезы» со своими фильтрами, ниже общий поиск. */
export const ListFilters: React.FC<Props> = ({ candidates, hypotheses, query, onQuery, extra }) => (
  <div className="vw-findings-filters">
    <Section title="Кандидаты" tabs={CANDIDATE_TABS} {...candidates} />
    {hypotheses.counts.all > 0 && <Section title="Гипотезы" tabs={HYPOTHESIS_TABS} {...hypotheses} />}
    <input type="text" className="vw-search" placeholder="Поиск по коду, названию или описанию" value={query} onChange={(e) => onQuery(e.target.value)} />
    {extra}
  </div>
);
