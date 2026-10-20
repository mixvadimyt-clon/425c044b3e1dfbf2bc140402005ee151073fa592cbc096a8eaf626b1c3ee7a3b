import React from 'react';
import { Popover, Typography } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';

/**
 * Пояснение, которое нужно не всегда: значок рядом с заголовком, текст по наведению или нажатию.
 * Постоянный абзац под заголовком читают один раз, а место он занимает всегда.
 */
export const InfoHint: React.FC<{ children: React.ReactNode; label?: string }> = ({ children, label = 'Пояснение' }) => (
  <Popover content={<Typography.Text style={{ display: 'block', maxWidth: 360 }}>{children}</Typography.Text>} placement="bottomLeft">
    <span role="button" tabIndex={0} aria-label={label} style={{ marginLeft: 8, cursor: 'help', color: 'inherit', opacity: 0.55, display: 'inline-flex' }}>
      <InfoCircleOutlined />
    </span>
  </Popover>
);
