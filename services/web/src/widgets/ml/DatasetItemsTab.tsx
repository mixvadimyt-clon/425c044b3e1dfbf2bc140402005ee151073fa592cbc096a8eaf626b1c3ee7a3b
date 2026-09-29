import React from 'react';
import { App, Button, Card, Input, Segmented, Space, Table, Typography, theme } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { SearchOutlined } from '@ant-design/icons';
import { useProjects } from '@/app/providers/useProjects';
import { formatDateTime } from '@/api/protocols';
import { QueryErrorAlert } from '@/widgets/QueryErrorAlert';
import { useCurateItem } from '@/api/ml';
import type { CurationStatus, DatasetItem } from '@/api/ml';
import { useDatasetItems } from '@/api/retrain';
import { useMatrixParams } from '@/api/suspicions';
import { InspectorCommentCell } from '@/widgets/InspectorCommentCell';
import { StatusPill } from '@/widgets/StatusPill';
import { InfoHint } from '@/widgets/InfoHint';
import { CURATION_STATUS, DATASET_SPLIT_LABEL, GOLD_LABEL, REJECT_REASON } from '@/shared/statuses';
import { lowerFirst } from '@/shared/text';

const { Text } = Typography;

type Filter = 'ALL' | CurationStatus;

const reasonLabel = (value?: string | null): string | undefined => (value && value in REJECT_REASON ? REJECT_REASON[value as keyof typeof REJECT_REASON].label : undefined);

/**
 * Записи GOLD-набора: куратор одобряет или исключает, выпущенные в версию записи не меняются (REQ-ML-01…03).
 * Список читаем целиком (до 200 записей, как на дашборде администратора): так в строке видны проект и название параметра,
 * а поиск и вкладки работают по всем записям, а не по одной странице.
 */
export const DatasetItemsTab: React.FC<{ canAct: boolean }> = ({ canAct }) => {
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const { projects } = useProjects();
  const params = useMatrixParams(true);
  const [filter, setFilter] = React.useState<Filter>('DRAFT');
  const [query, setQuery] = React.useState('');
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(10);
  const all = useDatasetItems(true);
  const curate = useCurateItem();
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const projectNames = React.useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const parameterNames = React.useMemo(() => new Map((params.data ?? []).map((p) => [p.code, p.parameter_name])), [params.data]);
  const parameterText = React.useCallback(
    (item: DatasetItem): string => {
      if (!item.param_code) return 'нет';
      const name = parameterNames.get(item.param_code);
      return name ? `${item.param_code}, ${name}` : item.param_code;
    },
    [parameterNames]
  );

  const counts = React.useMemo(() => {
    const list = all.data ?? [];
    return {
      ALL: list.length,
      DRAFT: list.filter((i) => i.curation_status === 'DRAFT').length,
      APPROVED: list.filter((i) => i.curation_status === 'APPROVED').length,
      EXCLUDED: list.filter((i) => i.curation_status === 'EXCLUDED').length,
    };
  }, [all.data]);

  const shown = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return (all.data ?? [])
      .filter((item) => filter === 'ALL' || item.curation_status === filter)
      .filter(
        (item) =>
          !q ||
          [projectNames.get(item.object_group_id) ?? '', parameterText(item), reasonLabel(item.reason_code) ?? '', GOLD_LABEL[item.gold_label].label]
            .join(' ')
            .toLowerCase()
            .includes(q)
      );
  }, [all.data, filter, query, projectNames, parameterText]);

  const handleCurate = async (item: DatasetItem, status: 'APPROVED' | 'EXCLUDED') => {
    setBusyId(item.id);
    try {
      await curate.mutateAsync({ id: item.id, status });
      message.success(status === 'APPROVED' ? 'Запись одобрена' : 'Запись исключена из набора');
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось изменить запись');
    } finally {
      setBusyId(null);
    }
  };

  const columns: ColumnsType<DatasetItem> = [
    {
      title: 'Проект',
      key: 'project',
      width: 200,
      className: 'col-wrap',
      render: (_: unknown, item: DatasetItem) => <Text strong>{projectNames.get(item.object_group_id) ?? 'Проект'}</Text>,
    },
    {
      title: 'Параметр',
      key: 'param',
      width: 220,
      className: 'col-wrap',
      render: (_: unknown, item: DatasetItem) => <Text>{parameterText(item)}</Text>,
    },
    {
      title: 'Метка',
      dataIndex: 'gold_label',
      key: 'gold_label',
      width: 150,
      render: (value: DatasetItem['gold_label']) => <StatusPill color={GOLD_LABEL[value].color}>{GOLD_LABEL[value].label}</StatusPill>,
    },
    {
      title: 'Причина',
      dataIndex: 'reason_code',
      key: 'reason_code',
      width: 170,
      className: 'col-wrap',
      render: (value?: string | null) => reasonLabel(value) ?? <Text type="secondary">нет</Text>,
    },
    {
      title: 'Комментарий инспектора',
      key: 'comment',
      width: 300,
      className: 'col-wrap',
      render: (_: unknown, item: DatasetItem) => <InspectorCommentCell findingId={item.finding_id} />,
    },
    {
      title: 'Статус',
      dataIndex: 'curation_status',
      key: 'curation_status',
      width: 150,
      render: (value: CurationStatus) => <StatusPill color={CURATION_STATUS[value].color}>{CURATION_STATUS[value].label}</StatusPill>,
    },
    {
      title: 'Версия набора',
      key: 'version',
      width: 180,
      render: (_: unknown, item: DatasetItem) =>
        item.dataset_version ? (
          <div style={{ fontSize: 13 }}>
            <div>{item.dataset_version}</div>
            {item.split && <div>Часть: {lowerFirst(DATASET_SPLIT_LABEL[item.split as keyof typeof DATASET_SPLIT_LABEL] ?? item.split)}</div>}
          </div>
        ) : (
          <Text type="secondary">не выпущена</Text>
        ),
    },
    {
      title: 'Создана',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 150,
      render: (value?: string) => (value ? <Text style={{ fontSize: 13 }}>{formatDateTime(value)}</Text> : <Text type="secondary">нет</Text>),
    },
    ...(canAct
      ? [
          {
            title: '',
            key: 'actions',
            width: 200,
            render: (_: unknown, item: DatasetItem) => {
              if (item.dataset_version) return <Text type="secondary" style={{ fontSize: 12 }}>выпущена, не меняется</Text>;
              return (
                <Space size={6}>
                  {item.curation_status !== 'APPROVED' && (
                    <Button size="small" type="primary" loading={busyId === item.id} onClick={() => void handleCurate(item, 'APPROVED')}>
                      Одобрить
                    </Button>
                  )}
                  {item.curation_status !== 'EXCLUDED' && (
                    <Button size="small" loading={busyId === item.id} onClick={() => void handleCurate(item, 'EXCLUDED')}>
                      Исключить
                    </Button>
                  )}
                </Space>
              );
            },
          },
        ]
      : []),
  ];

  return (
    <Card
      style={{ borderRadius: 12, background: token.colorBgContainer, border: `1px solid ${token.colorBorder}` }}
      title={
        <>
          <Text strong style={{ fontSize: 15 }}>Записи GOLD-набора</Text>
          <InfoHint label="Пояснение: записи набора">
            Куратор данных, то есть ML-инженер, проверяет записи, пришедшие от инспекторов, и одобряет или исключает их из набора. Запись появляется из решения инспектора: отклонённый кандидат даёт запись «Нарушения нет», подтверждённое нарушение даёт запись «Нарушение». «Одобрить» здесь то же, что «Отправить на дообучение» в разборе администратора (Дашборд, «Записи для дообучения»): там запись видно вместе с доказательствами на панелях, здесь весь список сразу. В версию набора попадают только одобренные записи с полным доказательством: у ожидаемого и фактического источника есть файл, страница и область.
          </InfoHint>
        </>
      }
      extra={
        <Space size={12} wrap>
          <Input
            allowClear
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            prefix={<SearchOutlined />}
            placeholder="Поиск: проект, параметр, причина"
            style={{ width: 280, maxWidth: '100%' }}
          />
          <Segmented
            value={filter}
            onChange={(value) => {
              setFilter(value as Filter);
              setPage(1);
            }}
            options={[
              { value: 'DRAFT', label: `Ждут куратора (${counts.DRAFT})` },
              { value: 'APPROVED', label: `Одобрены (${counts.APPROVED})` },
              { value: 'EXCLUDED', label: `Исключены (${counts.EXCLUDED})` },
              { value: 'ALL', label: `Все (${counts.ALL})` },
            ]}
          />
        </Space>
      }
    >
      {all.isError ? (
        <QueryErrorAlert title="Не удалось загрузить записи набора" error={all.error} onRetry={() => void all.refetch()} />
      ) : (
        <Table
          rowKey="id"
          size="middle"
          columns={columns}
          dataSource={shown}
          loading={all.isLoading}
          scroll={{ x: 1500 }}
          pagination={{ current: page, pageSize, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'], onChange: (p, size) => { setPage(p); setPageSize(size); }, hideOnSinglePage: true }}
          locale={{ emptyText: query.trim() ? 'По запросу ничего не найдено' : filter === 'DRAFT' ? 'Записей на проверке куратора нет' : 'Записей нет' }}
        />
      )}
    </Card>
  );
};
