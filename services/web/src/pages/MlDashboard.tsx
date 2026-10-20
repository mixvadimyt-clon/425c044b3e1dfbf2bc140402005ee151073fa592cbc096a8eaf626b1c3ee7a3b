import React from 'react';
import { Button, Card, Col, Input, Row, Select, Space, Table, Typography, theme } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ClockCircleOutlined, DatabaseOutlined, RobotOutlined, SearchOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useProjects } from '@/app/providers/useProjects';
import { formatDateTime } from '@/api/protocols';
import { useDatasetVersions, useModels } from '@/api/ml';
import { useDatasetItems } from '@/api/retrain';
import type { DatasetItem } from '@/api/retrain';
import { useMatrixParams } from '@/api/suspicions';
import { StatusPill } from '@/widgets/StatusPill';
import { TableEmpty } from '@/widgets/TableEmpty';
import { WelcomeCard } from '@/widgets/WelcomeGuide';
import { GOLD_LABEL, MODEL_APPROVAL_STATUS } from '@/shared/statuses';

const { Title, Text } = Typography;

/**
 * Дашборд ML-инженера: что ждёт куратора данных, последняя версия набора и модель, ссылки в рабочие разделы.
 * Сам разбор записей, версий и моделей на странице «Дообучение», здесь только сводка.
 */
export const MlDashboard: React.FC = () => {
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const { projects } = useProjects();
  const items = useDatasetItems(true);
  const waitingRef = React.useRef<HTMLDivElement>(null);
  const versions = useDatasetVersions();
  const models = useModels();
  const params = useMatrixParams(true);

  const waiting = React.useMemo(
    () => (items.data ?? []).filter(item => item.curation_status === 'DRAFT'),
    [items.data]
  );
  const projectNames = React.useMemo(() => new Map(projects.map(p => [p.id, p.name])), [projects]);
  const parameterNames = React.useMemo(
    () => new Map((params.data ?? []).map(p => [p.code, p.parameter_name])),
    [params.data]
  );
  const [query, setQuery] = React.useState('');
  const [labelFilter, setLabelFilter] = React.useState<DatasetItem['gold_label'] | 'ALL'>('ALL');
  const shown = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return waiting.filter((item) => {
      if (labelFilter !== 'ALL' && item.gold_label !== labelFilter) return false;
      if (!q) return true;
      const project = projectNames.get(item.object_group_id) ?? '';
      const code = item.param_code ?? '';
      return `${project} ${code} ${parameterNames.get(code) ?? ''}`.toLowerCase().includes(q);
    });
  }, [waiting, query, labelFilter, projectNames, parameterNames]);
  const lastVersion = versions.data?.[0];
  const lastModel = models.data?.[0];

  // Карточка без ссылки прокручивает страницу к таблице ниже
  const open = (to?: string) =>
    to ? navigate(to) : waitingRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const cardStyle: React.CSSProperties = {
    borderRadius: 12,
    background: token.colorBgContainer,
    border: `1px solid ${token.colorBorder}`,
  };

  const cards: Array<{
    title: string;
    value: React.ReactNode;
    note?: React.ReactNode;
    icon: React.ReactNode;
    to?: string;
  }> = [
    {
      title: 'Записи ждут куратора',
      value: items.isLoading ? '…' : waiting.length,
      note: 'Одобрить или исключить',
      icon: <ClockCircleOutlined style={{ fontSize: 32, color: token.colorWarning }} />,
    },
    {
      title: 'Последняя версия набора',
      value: lastVersion ? <span style={{ fontSize: 28 }}>{lastVersion.version}</span> : 'нет',
      note: lastVersion
        ? `${lastVersion.items_count} записей, выпущена ${formatDateTime(lastVersion.created_at)}`
        : versions.isLoading
          ? 'Загрузка…'
          : 'Версий пока нет',
      icon: <DatabaseOutlined style={{ fontSize: 32, color: token.colorPrimary }} />,
      to: '/ml?tab=versions',
    },
    {
      title: 'Последняя модель',
      value: lastModel ? <span style={{ fontSize: 28 }}>{lastModel.model_version}</span> : 'нет',
      note: lastModel ? (
        <StatusPill color={MODEL_APPROVAL_STATUS[lastModel.approval_status].color}>
          {MODEL_APPROVAL_STATUS[lastModel.approval_status].label}
        </StatusPill>
      ) : models.isLoading ? (
        'Загрузка…'
      ) : (
        'Моделей пока нет'
      ),
      icon: <RobotOutlined style={{ fontSize: 32, color: token.colorSuccess }} />,
      to: '/ml?tab=models',
    },
  ];

  const columns: ColumnsType<DatasetItem> = [
    {
      title: 'Проект',
      key: 'project',
      width: 240,
      render: (_: unknown, item: DatasetItem) => (
        <Text strong>{projectNames.get(item.object_group_id) ?? 'Проект'}</Text>
      ),
    },
    {
      title: 'Параметр',
      key: 'param',
      render: (_: unknown, item: DatasetItem) =>
        item.param_code
          ? `${item.param_code}${parameterNames.get(item.param_code) ? `, ${parameterNames.get(item.param_code)}` : ''}`
          : 'нет',
    },
    {
      title: 'Метка',
      dataIndex: 'gold_label',
      key: 'label',
      width: 150,
      render: (value: DatasetItem['gold_label']) => (
        <StatusPill color={GOLD_LABEL[value].color}>{GOLD_LABEL[value].label}</StatusPill>
      ),
    },
    {
      title: 'Создана',
      dataIndex: 'created_at',
      key: 'created',
      width: 160,
      render: (value?: string) => (value ? formatDateTime(value) : 'нет'),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          padding: '16px 24px',
          background: token.colorBgContainer,
          borderBottom: `1px solid ${token.colorBorder}`,
        }}
      >
        <Title level={2} style={{ margin: 0 }}>
          Дашборд ML-инженера
        </Title>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        <WelcomeCard />
        <Row gutter={[24, 24]} style={{ marginBottom: 24 }}>
          {cards.map(item => (
            <Col xs={24} sm={12} md={8} key={item.title}>
              <Card
                hoverable
                role="button"
                tabIndex={0}
                aria-label={
                  item.to ? `${item.title}. Перейти` : `${item.title}. Показать таблицу ниже`
                }
                style={{ ...cardStyle, height: '100%' }}
                onClick={() => open(item.to)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    open(item.to);
                  }
                }}
              >
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {item.icon}
                  <div style={{ fontSize: 40, fontWeight: 600, lineHeight: 1.2 }}>{item.value}</div>
                  <Text type="secondary" style={{ fontSize: 14 }}>
                    {item.title}
                  </Text>
                  {item.note && <Text style={{ fontSize: 13 }}>{item.note}</Text>}
                </Space>
              </Card>
            </Col>
          ))}
        </Row>

        <div ref={waitingRef}>
          <Card
            title={
              <Text strong style={{ fontSize: 17 }}>
                Записи, ждущие куратора
              </Text>
            }
            extra={
              <Space size={12} wrap>
                <Input
                  allowClear
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  prefix={<SearchOutlined />}
                  placeholder="Поиск: проект, параметр"
                  style={{ width: 240, maxWidth: '100%' }}
                />
                <Select
                  value={labelFilter}
                  onChange={setLabelFilter}
                  style={{ width: 160 }}
                  options={[{ value: 'ALL', label: 'Все метки' }, ...Object.entries(GOLD_LABEL).map(([value, meta]) => ({ value, label: meta.label }))]}
                />
                <Button onClick={() => navigate('/ml?tab=items')}>Все записи набора</Button>
              </Space>
            }
            style={cardStyle}
            styles={{ body: { padding: 12 } }}
          >
            <Table
              columns={columns}
              dataSource={shown}
              rowKey="id"
              pagination={{
                defaultPageSize: 5,
                hideOnSinglePage: true,
                showSizeChanger: true,
                pageSizeOptions: ['5', '10', '20', '50'],
              }}
              loading={items.isLoading}
              size="small"
              locale={{
                emptyText: (
                  <TableEmpty>
                    {items.isError
                      ? 'Не удалось загрузить записи набора'
                      : query.trim() || labelFilter !== 'ALL'
                        ? 'Ничего не найдено'
                        : 'Записей, ждущих куратора, нет'}
                  </TableEmpty>
                ),
              }}
            />
          </Card>
        </div>
      </div>
    </div>
  );
};
