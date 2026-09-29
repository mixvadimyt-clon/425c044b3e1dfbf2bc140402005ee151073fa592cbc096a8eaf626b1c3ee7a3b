import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from 'antd';
import { describe, expect, it, vi } from 'vitest';
import type { ApiSuspicion } from '@/api/suspicions';
import { PromoteForm, SuspicionDetail } from './SuspicionsPanel';

const suspicion = {
  suspicion_id: 's1',
  inspector_status: 'PENDING',
  discovery_method: 'FREE_SEARCH',
  review_priority: 'MEDIUM',
  confidence: 0.5,
  description: 'Гипотеза',
  evidence: [],
} as unknown as ApiSuspicion;

const setup = (canDecide = true) => {
  const onStartPromote = vi.fn();
  render(
    <App>
      <SuspicionDetail suspicion={suspicion} canDecide={canDecide} onStartPromote={onStartPromote} onCancelPromote={() => undefined} drafts={[]} onChangeDraft={() => undefined} onRemoveDraft={() => undefined} files={[]} onChanged={() => undefined} onOpenFinding={() => undefined} />
    </App>,
  );
  return { onStartPromote };
};

describe('SuspicionDetail: горячие клавиши', () => {
  it('1 делает гипотезу кандидатом', () => {
    const { onStartPromote } = setup();
    fireEvent.keyDown(window, { key: '1' });
    expect(onStartPromote).toHaveBeenCalledWith('s1');
  });

  it('2 открывает отклонение', () => {
    setup();
    fireEvent.keyDown(window, { key: '2' });
    expect(screen.getByText('Почему отклоняете *')).toBeTruthy();
  });

  it('3 открывает уточнение', () => {
    setup();
    fireEvent.keyDown(window, { key: '3' });
    expect(screen.getByText('Что нужно уточнить *')).toBeTruthy();
  });

  it('у роли без права решать клавиши не работают', () => {
    const { onStartPromote } = setup(false);
    fireEvent.keyDown(window, { key: '1' });
    expect(onStartPromote).not.toHaveBeenCalled();
  });
});

describe('форма «Сделать кандидатом»: клавиши', () => {
  it('Esc закрывает форму', () => {
    const onCancel = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <App>
          <PromoteForm suspicion={suspicion} drafts={[]} files={[]} saving={false} onChangeDraft={() => undefined} onRemoveDraft={() => undefined} onSubmit={() => undefined} onCancel={onCancel} />
        </App>
      </QueryClientProvider>,
    );
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });
});
