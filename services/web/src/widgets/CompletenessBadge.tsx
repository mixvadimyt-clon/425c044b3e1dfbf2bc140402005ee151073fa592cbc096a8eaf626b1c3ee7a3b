import React from 'react';
import { useProcess } from '@/api/processes';
import { StatusPill } from './StatusPill';
import { COMPLETENESS_STATUS } from '@/shared/statuses';

interface Props {
  processId: string | null | undefined;
}

/** Индикатор комплекта проекта: «Полный», «Не хватает документов», «Не читается», «Требует уточнения». */
export const CompletenessBadge: React.FC<Props> = ({ processId }) => {
  const { data } = useProcess(processId);
  const status = data?.completeness?.status;
  if (!status) return null;
  const meta = COMPLETENESS_STATUS[status];
  return (
    <StatusPill color={meta.color}>
      <span className="cb-prefix">Комплект: </span>
      {meta.label}
    </StatusPill>
  );
};
