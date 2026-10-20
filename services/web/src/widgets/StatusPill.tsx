import React from 'react';
import { Tag } from 'antd';

// Плашки статусов в стиле дашборда («Загружено» / «Нет»): без рамки, скругление 6, жирный шрифт 12 px.
const PALETTE = {
  success: { background: '#D1FAE5', color: '#065F46' },
  error: { background: '#FEE2E2', color: '#991B1B' },
  warning: { background: '#FEF3C7', color: '#92400E' },
  info: { background: '#D5F0ED', color: '#0B5F57' },
  default: { background: '#F1F5F9', color: '#475569' },
} as const;

export type PillTone = keyof typeof PALETTE;

/** Приводит цвета из словарей `shared/statuses.ts` (цвета Ant Design) к тонам плашек. */
const toneFromColor = (color?: string): PillTone => {
  switch (color) {
    case 'success':
      return 'success';
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    case 'processing':
      return 'info';
    default:
      return 'default';
  }
};

interface StatusPillProps {
  tone?: PillTone;
  /** Цвет из словарей статусов: success, error, warning, processing, default. */
  color?: string;
  children: React.ReactNode;
}

export const StatusPill: React.FC<StatusPillProps> = ({ tone, color, children }) => {
  const palette = PALETTE[tone ?? toneFromColor(color)];
  return (
    <Tag
      bordered={false}
      style={{
        borderRadius: 6,
        fontSize: 12,
        padding: '2px 8px',
        whiteSpace: 'nowrap',
        fontWeight: 600,
        margin: 0,
        ...palette,
      }}
    >
      {children}
    </Tag>
  );
};
