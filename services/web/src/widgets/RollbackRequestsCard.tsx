import React from 'react';
import { Button, Card, Table, Typography, theme } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useNavigate } from 'react-router-dom';
import { formatDateTime } from '@/api/protocols';
import { useUnfinalizeRequests } from '@/api/unfinalizeRequests';
import type { UnfinalizeRequest } from '@/api/unfinalizeRequests';
import { TableEmpty } from '@/widgets/TableEmpty';

const { Text } = Typography;

/**
 * Дашборд супервизора: открытые запросы инспекторов на откат финализации.
 * Сам откат (или отказ с причиной) делается в протоколе проекта, поэтому здесь только переход к нему.
 */
export const RollbackRequestsCard: React.FC = () => {
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const requests = useUnfinalizeRequests(true);

  const columns: ColumnsType<UnfinalizeRequest> = [
    { title: 'Проект', key: 'object', width: 200, render: (_: unknown, r: UnfinalizeRequest) => <Text strong>{r.object_name || 'Проект'}</Text> },
    { title: 'Инспектор', key: 'by', width: 160, render: (_: unknown, r: UnfinalizeRequest) => r.requested_by_name || 'нет' },
    { title: 'Причина', dataIndex: 'reason', key: 'reason', width: 340 },
    { title: 'Запрошено', key: 'time', width: 150, render: (_: unknown, r: UnfinalizeRequest) => formatDateTime(r.created_at) || r.created_at },
    {
      title: 'Действия',
      key: 'actions',
      width: 150,
      render: (_: unknown, r: UnfinalizeRequest) => (
        <Button size="small" onClick={() => navigate(`/protocol?object=${r.object_id}`)}>
          Открыть протокол
        </Button>
      ),
    },
  ];

  return (
    <Card
      id="dash-rollback"
      title={<Text strong style={{ fontSize: 17 }}>Запросы на откат финализации</Text>}
      style={{ borderRadius: 12, background: token.colorBgContainer, border: `1px solid ${token.colorBorder}`, marginBottom: 24 }}
      styles={{ body: { padding: 12 } }}
    >
      <Table
        columns={columns}
        dataSource={requests.data ?? []}
        rowKey="id"
        pagination={{ defaultPageSize: 10, hideOnSinglePage: true, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'], position: ['bottomLeft'] }}
        loading={requests.isLoading}
        size="small"
        tableLayout="fixed"
        scroll={{ x: 1000 }}
        locale={{ emptyText: <TableEmpty>{requests.isError ? 'Не удалось загрузить запросы' : 'Открытых запросов нет'}</TableEmpty> }}
      />
    </Card>
  );
};
