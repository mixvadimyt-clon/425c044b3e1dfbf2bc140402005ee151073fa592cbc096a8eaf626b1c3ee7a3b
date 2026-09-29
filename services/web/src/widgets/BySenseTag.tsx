import React from 'react';
import { Tooltip } from 'antd';

export const BY_SENSE_HINT = 'Значение найдено Sentence-BERT по близости подписи к названию параметра, проверьте';

/** Метка «найдено по смыслу» у значения, которое правила не нашли и подобрал Sentence-BERT. */
export const BySenseTag: React.FC<{ show?: boolean }> = ({ show }) =>
  show ? (
    <Tooltip title={BY_SENSE_HINT}>
      <span className="by-sense-tag" data-testid="by-sense-tag">
        найдено по смыслу
      </span>
    </Tooltip>
  ) : null;
