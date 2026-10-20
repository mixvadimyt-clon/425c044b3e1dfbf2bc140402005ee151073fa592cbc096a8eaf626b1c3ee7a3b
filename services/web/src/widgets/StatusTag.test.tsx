import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { StatusTag } from '@/widgets/StatusTag';

describe('StatusTag', () => {
  it('renders finding status', () => {
    render(<StatusTag status="CANDIDATE" type="finding" />);
    expect(screen.getByText('Кандидат')).toBeInTheDocument();
  });

  it('renders process status', () => {
    render(<StatusTag status="READY" type="process" />);
    expect(screen.getByText('Готов к верификации')).toBeInTheDocument();
  });

  it('renders unknown status', () => {
    render(<StatusTag status="UNKNOWN_STATUS" />);
    expect(screen.getByText('UNKNOWN_STATUS')).toBeInTheDocument();
  });
});
