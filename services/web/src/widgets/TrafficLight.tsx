import React from 'react';
import { Tooltip } from 'antd';
import { OBJECT_INDICATOR } from '@/shared/statuses';
import { lowerFirst } from '@/shared/text';

const COLORS = { RED: '#DC2626', YELLOW: '#D97706', GREEN: '#16A34A' } as const;

interface Props {
  indicator?: keyof typeof OBJECT_INDICATOR;
}

/** Светофор объекта: красный — есть подтверждённые нарушения, жёлтый — есть необработанное, зелёный — иначе. */
export const TrafficLight: React.FC<Props> = ({ indicator }) => {
  if (!indicator) return null;
  return (
    <Tooltip title={OBJECT_INDICATOR[indicator].label}>
      <span
        aria-label={`Светофор: ${lowerFirst(OBJECT_INDICATOR[indicator].label)}`}
        style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: COLORS[indicator], marginRight: 8, flex: '0 0 auto' }}
      />
    </Tooltip>
  );
};
