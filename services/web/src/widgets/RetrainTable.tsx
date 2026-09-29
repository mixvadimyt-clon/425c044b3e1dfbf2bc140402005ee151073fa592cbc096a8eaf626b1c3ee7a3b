import React from 'react';
import { Button, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { InspectorCommentCell } from './InspectorCommentCell';
import { StatusPill } from './StatusPill';
import { TableEmpty } from './TableEmpty';
import type { PillTone } from './StatusPill';
import { formatDateTime } from '@/api/protocols';
import { REJECT_REASON } from '@/shared/statuses';
import { RETRAIN_STATUS_LABEL } from '@/shared/retrainQueue';
import type { RetrainItem, RetrainStatus } from '@/shared/retrainQueue';

const { Text } = Typography;

const OUTCOME_TONE: Record<RetrainStatus, PillTone> = { pending: 'warning', sent: 'success', skipped: 'default' };

const th = (title: string) => (
  <Text strong style={{ fontSize: 14 }}>
    {title}
  </Text>
);

interface Props {
  items: RetrainItem[];
  /** Итог разбора в отдельной колонке нужен там, где есть уже разобранные записи. */
  showOutcome?: boolean;
  loading?: boolean;
  emptyText: string;
  onOpen: (item: RetrainItem) => void;
}

/** Записи разбора для дообучения: проект, параметр, решение инспектора, причина, итог и переход в разбор. */
export const RetrainTable: React.FC<Props> = ({ items, showOutcome, loading, emptyText, onOpen }) => {
  const columns: ColumnsType<RetrainItem> = [
    {
      title: th('Проект'),
      dataIndex: 'projectName',
      key: 'project',
      width: 170,
      className: 'col-wrap',
      render: (text: string) => (
        <Text strong style={{ fontSize: 14 }}>
          {text}
        </Text>
      ),
    },
    {
      title: th('Параметр'),
      dataIndex: 'parameter',
      key: 'parameter',
      width: 240,
      className: 'col-wrap',
      render: (text: string) => <Text style={{ fontSize: 13 }}>{text}</Text>,
    },
    {
      title: th('Причина'),
      key: 'reason',
      width: 210,
      className: 'col-wrap',
      render: (_: unknown, item: RetrainItem) => <Text style={{ fontSize: 13 }}>{item.reasonCode ? REJECT_REASON[item.reasonCode].label : 'нет'}</Text>,
    },
    {
      title: th('Комментарий инспектора'),
      key: 'comment',
      width: 380,
      className: 'col-wrap',
      render: (_: unknown, item: RetrainItem) => <InspectorCommentCell findingId={item.findingId} known={item.inspectorComment} />,
    },
    {
      title: th('Записано'),
      key: 'time',
      width: 150,
      render: (_: unknown, item: RetrainItem) => <Text style={{ fontSize: 13 }}>{formatDateTime(item.timestamp) || item.timestamp}</Text>,
    },
    ...(showOutcome
      ? [
          {
            title: th('Итог'),
            key: 'outcome',
            width: 190,
            render: (_: unknown, item: RetrainItem) => (
              <div>
                <StatusPill tone={OUTCOME_TONE[item.status]}>{RETRAIN_STATUS_LABEL[item.status]}</StatusPill>
                {/* Отправленная запись либо уже вошла в выпущенную версию набора, либо ждёт следующего выпуска */}
                {item.status === 'sent' && (
                  <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 2 }}>
                    {item.datasetVersion ? `Вошла в версию ${item.datasetVersion}` : 'Ждёт выпуска версии'}
                  </Text>
                )}
              </div>
            ),
          },
        ]
      : []),
    {
      title: th('Действия'),
      key: 'actions',
      width: 130,
      render: (_: unknown, item: RetrainItem) => (
        <Button type={item.status === 'pending' ? 'primary' : 'default'} size="small" onClick={() => onOpen(item)} disabled={!item.findingId}>
          {item.status === 'pending' ? 'Решить' : 'Открыть'}
        </Button>
      ),
    },
  ];

  return (
    <Table
      columns={columns}
      dataSource={items}
      rowKey="id"
      pagination={{ defaultPageSize: 10, hideOnSinglePage: true, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'], position: ['bottomLeft'] }}
      loading={loading}
      size="small"
      tableLayout="fixed"
      scroll={{ x: showOutcome ? 1440 : 1250 }}
      locale={{ emptyText: <TableEmpty>{emptyText}</TableEmpty> }}
    />
  );
};
