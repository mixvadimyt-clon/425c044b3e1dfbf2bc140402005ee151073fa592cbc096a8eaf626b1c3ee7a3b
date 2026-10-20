import { Tag } from 'antd';
import type { TagProps } from 'antd';
import {
  FINDING_STATUS,
  PROCESS_STATUS,
  COMPLETENESS_STATUS,
  APPROVAL_STATUS,
} from '@/shared/statuses';

type FindingStatusKey = keyof typeof FINDING_STATUS;
type ProcessStatusKey = keyof typeof PROCESS_STATUS;
type CompletenessStatusKey = keyof typeof COMPLETENESS_STATUS;
type ApprovalStatusKey = keyof typeof APPROVAL_STATUS;

interface StatusTagProps {
  status: string;
  type?: 'finding' | 'process' | 'completeness' | 'approval';
}

export const StatusTag: React.FC<StatusTagProps> = ({ status, type = 'finding' }) => {
  const getStatusConfig = (): { label: string; color: string } | undefined => {
    switch (type) {
      case 'finding':
        return FINDING_STATUS[status as FindingStatusKey];
      case 'process':
        return PROCESS_STATUS[status as ProcessStatusKey];
      case 'completeness':
        return COMPLETENESS_STATUS[status as CompletenessStatusKey];
      case 'approval':
        return APPROVAL_STATUS[status as ApprovalStatusKey];
      default:
        return undefined;
    }
  };

  const config = getStatusConfig();

  if (!config) {
    return <Tag>{status}</Tag>;
  }

  return <Tag color={config.color as TagProps['color']}>{config.label}</Tag>;
};
