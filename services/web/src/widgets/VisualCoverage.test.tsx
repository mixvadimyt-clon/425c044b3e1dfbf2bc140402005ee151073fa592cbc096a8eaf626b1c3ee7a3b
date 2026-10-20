import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VisualCoverage } from '@/widgets/VisualCoverage';
import type { Coverage } from '@/api/visualCoverage';

const files = [
  { id: 'f1', original_name: 'ov3.pdf', document_code: 'ОВ-3' },
  { id: 'f2', original_name: 'ov1.pdf', document_code: 'ОВ-1' },
];

const limited: Coverage = {
  sheetsTotal: 14,
  sheetsChecked: 9,
  pairsChecked: 48,
  pairsPossible: 60,
  limited: true,
  limits: { max_sheets_per_stage: 12, max_pair_checks: 60, budget_s: null },
  skipped: [
    { file_id: 'f1', page: 7, stage: 'PD', reason: 'LIMIT' },
    { file_id: 'f2', page: 2, stage: 'RD', reason: 'MOSAIC' },
  ],
  skippedTotal: 5,
  textHeavy: 3,
};

describe('VisualCoverage', () => {
  it('нет отчёта: ничего не показываем', () => {
    const { container } = render(<VisualCoverage coverage={null} onOpenSheet={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('ограниченный прогон: полоса, пометка, лимиты и счётчик пропусков', () => {
    render(<VisualCoverage coverage={limited} files={files} onOpenSheet={() => {}} />);
    expect(screen.getByText('Проверено 9 из 14 листов, 48 пар из 60')).toBeInTheDocument();
    expect(screen.getByText('ограниченный прогон')).toBeInTheDocument();
    expect(screen.getByText('Действовали лимиты: до 12 листов на стадию, до 60 пар')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Пропущено 5/ })).toBeInTheDocument();
    expect(screen.queryByText('не вошёл в лимит листов')).not.toBeInTheDocument();
  });

  it('список пропущенных раскрывается, лист подписан шифром, причина по-русски, клик открывает лист', () => {
    const onOpen = vi.fn();
    render(<VisualCoverage coverage={limited} files={files} onOpenSheet={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: /Пропущено 5/ }));
    expect(screen.getByText('ОВ-3, стр. 7')).toBeInTheDocument();
    expect(screen.getByText('не вошёл в лимит листов')).toBeInTheDocument();
    expect(screen.getByText('лист-мозаика (векторный чертёж)')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'открыть лист' })[1]);
    expect(onOpen).toHaveBeenCalledWith(limited.skipped[1]);
  });

  it('в списке не все пропущенные и есть страницы с большим текстом: об этом сказано', () => {
    render(<VisualCoverage coverage={limited} files={files} onOpenSheet={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /Пропущено 5/ }));
    expect(screen.getByText(/и ещё 3 листа, в список они не вошли/)).toBeInTheDocument();
    expect(screen.getByText(/Без проверки остались 3 страницы с большим текстом/)).toBeInTheDocument();
  });

  it('без пропусков: короткая строка, без списка и без пометки', () => {
    const full: Coverage = { ...limited, sheetsChecked: 14, pairsChecked: 42, pairsPossible: 42, limited: false, limits: { max_sheets_per_stage: null, max_pair_checks: null, budget_s: null }, skipped: [], skippedTotal: 0, textHeavy: 0 };
    render(<VisualCoverage coverage={full} onOpenSheet={() => {}} />);
    expect(screen.getByText('Все листы-чертежи проверены (14 листов, 42 пары)')).toBeInTheDocument();
    expect(screen.queryByText('ограниченный прогон')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('только мозаики пропущены, лимит не действовал: список есть, пометки «ограниченный прогон» нет', () => {
    const mosaics: Coverage = { ...limited, limited: false, skippedTotal: 2 };
    render(<VisualCoverage coverage={mosaics} files={files} onOpenSheet={() => {}} />);
    expect(screen.queryByText('ограниченный прогон')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Пропущено 2/ })).toBeInTheDocument();
  });

  it('листов-чертежей в комплекте нет: об этом сказано', () => {
    const none: Coverage = { ...limited, sheetsTotal: 0, sheetsChecked: 0, pairsChecked: 0, pairsPossible: 0, limited: false, skipped: [], skippedTotal: 0, textHeavy: 0 };
    render(<VisualCoverage coverage={none} onOpenSheet={() => {}} />);
    expect(screen.getByText(/Листы-чертежи в комплекте не найдены/)).toBeInTheDocument();
  });

  it('полный экран: одна строка с кнопкой «Пропущено N», список раскрывается и листы открываются', () => {
    const onOpenSheet = vi.fn();
    render(<VisualCoverage coverage={limited} files={files} onOpenSheet={onOpenSheet} compact />);
    expect(screen.getByText('Проверено 9 из 14 листов, 48 пар из 60')).toBeInTheDocument();
    // пока закрыто: ни лимитов, ни списка
    expect(screen.queryByText(/Действовали лимиты:/)).not.toBeInTheDocument();
    expect(screen.queryByText('не вошёл в лимит листов')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Пропущено 5/ }));
    expect(screen.getByText('Действовали лимиты: до 12 листов на стадию, до 60 пар')).toBeInTheDocument();
    expect(screen.getByText('не вошёл в лимит листов')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'открыть лист' })[0]);
    expect(onOpenSheet).toHaveBeenCalledTimes(1);
    // повторное нажатие сворачивает
    fireEvent.click(screen.getByRole('button', { name: /Пропущено 5/ }));
    expect(screen.queryByText('не вошёл в лимит листов')).not.toBeInTheDocument();
  });
});
