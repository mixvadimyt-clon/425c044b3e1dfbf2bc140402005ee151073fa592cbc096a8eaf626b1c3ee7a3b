import React from 'react';
import { Typography } from 'antd';

interface Props {
  children: React.ReactNode;
  /** Что здесь появится и что сделать: пустой экран должен подсказывать следующий шаг. */
  hint?: React.ReactNode;
  /** Одно действие, которое наполнит таблицу (кнопка). */
  action?: React.ReactNode;
}

/** Пустая таблица: текст слева, как и всё остальное в таблице (по умолчанию antd ставит его по центру). */
export const TableEmpty: React.FC<Props> = ({ children, hint, action }) => (
  <div style={{ textAlign: 'left', padding: '12px 8px', display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
    <Typography.Text type="secondary">{children}</Typography.Text>
    {hint && (
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>
        {hint}
      </Typography.Text>
    )}
    {action}
  </div>
);
