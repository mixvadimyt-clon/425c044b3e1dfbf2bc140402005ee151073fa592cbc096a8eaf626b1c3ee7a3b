import React from 'react';
import { App, Card, Row, Col, Table, Button, Typography, Space, theme, Input, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  FolderOutlined,
  ClockCircleOutlined,
  CheckCircleOutlined,
  PlusOutlined,
  FileSearchOutlined,
  SearchOutlined,
  FileTextOutlined,
  EditOutlined,
  CheckOutlined,
  CloseOutlined,
  DeleteOutlined,
  LockOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useProjects } from '@/app/providers/useProjects';
import { useAuth } from '@/app/providers/useAuth';
import { AdminDashboard } from './AdminDashboard';
import { MlDashboard } from './MlDashboard';
import { RollbackRequestsCard } from '@/widgets/RollbackRequestsCard';
import { useUnfinalizeRequests } from '@/api/unfinalizeRequests';
import { WelcomeCard } from '@/widgets/WelcomeGuide';
import { StatusPill } from '@/widgets/StatusPill';
import { TrafficLight } from '@/widgets/TrafficLight';
import { CheckCell, ComplianceCell } from '@/widgets/ProjectCheck';
import { updatedAtMs } from '@/shared/projects';
import type { Project } from '@/shared/projects';
import { DeleteNotSupportedError } from '@/api/projects';
import { TableEmpty } from '@/widgets/TableEmpty';
import { CHECK_GROUPS, checkGroupOf, nextAction } from '@/shared/nextAction';
import type { NextActionTarget } from '@/shared/nextAction';

const { Title, Text } = Typography;

interface ProjectStats {
  total: number;
  inReview: number;
  finalized: number;
}

const th = (title: string) => (
  <Text strong style={{ fontSize: 14 }}>
    {title}
  </Text>
);

/** Дашборд со списком проектов: у инспектора и супервизора. Супервизору сверху добавлены запросы инспекторов на откат финализации. */
const InspectorDashboard: React.FC<{ supervisor?: boolean }> = ({ supervisor = false }) => {
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editingName, setEditingName] = React.useState('');
  const [reviewQuery, setReviewQuery] = React.useState('');
  const [finalizedQuery, setFinalizedQuery] = React.useState('');

  const { projects, updateProject, removeProject, isLoading, source } = useProjects();
  const { modal, message } = App.useApp();

  const projectsInReview = projects.filter((p) => !p.finalized);
  const finalizedProjects = projects.filter((p) => p.finalized);

  // Поиск по названию, адресу, застройщику, подрядчику и № разрешения
  const filterProjects = (list: Project[], query: string) => {
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((p) => [p.name, p.address, p.developer, p.contractor, p.permit].join(' ').toLowerCase().includes(q));
  };
  const reviewShown = filterProjects(projectsInReview, reviewQuery);
  const finalizedShown = filterProjects(finalizedProjects, finalizedQuery);

  const searchInput = (value: string, onChange: (v: string) => void) => (
    <Input
      allowClear
      value={value}
      onChange={(e) => onChange(e.target.value)}
      prefix={<SearchOutlined />}
      placeholder="Поиск: проект, адрес, застройщик, подрядчик, разрешение"
      title="Ищет по названию проекта, адресу, застройщику, подрядчику и номеру разрешения"
      style={{ width: 380, maxWidth: '100%' }}
    />
  );

  const stats: ProjectStats = {
    total: projects.length,
    inReview: projectsInReview.length,
    finalized: finalizedProjects.length,
  };

  const handleEditStart = (project: Project) => {
    setEditingId(project.id);
    setEditingName(project.name);
  };

  const handleEditSave = (projectId: string) => {
    updateProject(projectId, { name: editingName });
    setEditingId(null);
    setEditingName('');
  };

  const handleEditCancel = () => {
    setEditingId(null);
    setEditingName('');
  };

  const handleVerification = (projectId: string) => navigate(`/verification?object=${projectId}`);
  const handleProtocol = (projectId: string) => navigate(`/protocol?object=${projectId}`);
  const handleUpload = (projectId: string) => navigate(`/upload?object=${projectId}&focus=upload`);
  const handleAddProject = () => navigate('/upload?new=true');
  const goNext = (project: Project) => {
    const target: NextActionTarget = nextAction(project).target;
    if (target === 'upload') handleUpload(project.id);
    else if (target === 'verification') handleVerification(project.id);
    else handleProtocol(project.id);
  };

  const handleDelete = (project: Project) => {
    modal.confirm({
      title: 'Удалить проект?',
      content: project.finalized
        ? `Проект «${project.name}» финализирован: его протокол и документы будут удалены без возможности восстановления.`
        : `Проект «${project.name}» и его документы будут удалены без возможности восстановления.`,
      okText: 'Удалить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: async () => {
        try {
          await removeProject(project.id);
          message.success('Проект удалён');
        } catch (error) {
          if (error instanceof DeleteNotSupportedError) message.warning(error.message);
          else message.error(error instanceof Error ? error.message : 'Не удалось удалить проект');
        }
      },
    });
  };

  // Сортировка каждой таблицы храним сами: подсказка у заголовка называет следующий шаг словами столбца
  type SortOrder = 'ascend' | 'descend' | null;
  const [sorts, setSorts] = React.useState<Record<'review' | 'finalized', { key?: string; order: SortOrder }>>({
    review: { key: 'updatedAt', order: 'descend' },
    finalized: { key: 'updatedAt', order: 'descend' },
  });
  const sortProps = (table: 'review' | 'finalized', key: string, texts: { asc: string; desc: string }) => {
    const current = sorts[table].key === key ? sorts[table].order : null;
    const next = current === null ? texts.asc : current === 'ascend' ? texts.desc : 'Сбросить сортировку';
    return { sortOrder: current, showSorterTooltip: { title: next } };
  };

  const handleSort = (table: 'review' | 'finalized', sorter: { columnKey?: React.Key; order?: SortOrder } | Array<{ columnKey?: React.Key; order?: SortOrder }>) => {
    const one = Array.isArray(sorter) ? sorter[0] : sorter;
    setSorts((prev) => ({ ...prev, [table]: { key: one?.order ? String(one.columnKey) : undefined, order: one?.order ?? null } }));
  };

  // Колонки одинаковые для обеих таблиц, отличаются только действия
  const buildColumns = (finalized: boolean): ColumnsType<Project> => {
    const table = finalized ? 'finalized' : 'review';
    return [
    {
      title: th('Проект'),
      dataIndex: 'name',
      key: 'name',
      sorter: (a: Project, b: Project) => a.name.localeCompare(b.name, 'ru'),
      ...sortProps(table, 'name', { asc: 'По алфавиту: от А до Я', desc: 'По алфавиту: от Я до А' }),
      width: 240,
      className: 'col-wrap',
      render: (text: string, record: Project) => {
        if (!finalized && editingId === record.id) {
          return (
            <Space.Compact style={{ width: '100%' }}>
              <Input
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                onPressEnter={() => handleEditSave(record.id)}
                autoFocus
                style={{ fontSize: 14 }}
              />
              <Tooltip title="Сохранить">
                <Button type="primary" icon={<CheckOutlined />} onClick={() => handleEditSave(record.id)} size="small" />
              </Tooltip>
              <Tooltip title="Отменить">
                <Button className="negative-action" icon={<CloseOutlined />} aria-label="Отменить" onClick={handleEditCancel} size="small" />
              </Tooltip>
            </Space.Compact>
          );
        }
        return (
          <Text strong style={{ fontSize: 14 }}>
            <TrafficLight indicator={record.indicator} />
            {text}
            {!finalized && (
              <Tooltip title="Редактировать">
                <Button
                  type="text"
                  size="small"
                  aria-label="Редактировать название"
                  icon={<EditOutlined />}
                  onClick={() => handleEditStart(record)}
                  style={{ padding: '0 4px', marginLeft: 4 }}
                />
              </Tooltip>
            )}
          </Text>
        );
      },
    },
    {
      title: th('Проверка'),
      key: 'check',
      width: 210,
      // Фильтр только у проектов на проверке: у финализированных проверка всегда одна и та же
      ...(finalized ? {} : { filters: CHECK_GROUPS, onFilter: (value: React.Key | boolean, record: Project) => checkGroupOf(record) === value }),
      render: (_: unknown, record: Project) => <CheckCell project={record} />,
    },
    {
      title: th('Соответствие'),
      key: 'compliance',
      width: 160,
      sorter: (a: Project, b: Project) => (a.counts?.compliancePercent ?? -1) - (b.counts?.compliancePercent ?? -1),
      ...sortProps(table, 'compliance', { asc: 'Сначала с меньшим соответствием', desc: 'Сначала с большим соответствием' }),
      render: (_: unknown, record: Project) => <ComplianceCell project={record} />,
    },
    ...(['ПД', 'РД', 'ИД'] as const).map((stage) => ({
      title: th(stage),
      key: stage,
      width: 96,
      render: (_: unknown, record: Project) => {
        const doc = record.docs.find((d) => d.stage === stage);
        if (doc?.partial) return <StatusPill tone="warning">Частично</StatusPill>;
        return <StatusPill tone={doc?.loaded ? 'success' : 'error'}>{doc?.loaded ? 'Загружено' : 'Нет'}</StatusPill>;
      },
    })),
    {
      title: th('Обновлено'),
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 140,
      // Свежие сверху по умолчанию: порядок понятен без пояснений
      sorter: (a: Project, b: Project) => updatedAtMs(a.updatedAt) - updatedAtMs(b.updatedAt),
      ...sortProps(table, 'updatedAt', { asc: 'Сначала старые', desc: 'Сначала новые' }),
      render: (text: string) => {
        const [date, time] = text.split(' ');
        return (
          <>
            <Text style={{ fontSize: 13, display: 'block' }}>{date}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {time}
            </Text>
          </>
        );
      },
    },
    {
      title: th('Действия'),
      key: 'actions',
      width: 220,
      render: (_: unknown, record: Project) => {
        const next = nextAction(record);
        const others: Array<{ target: NextActionTarget; label: string; icon: React.ReactNode; show: boolean }> = [
          { target: 'upload', label: 'Дозагрузка', icon: <PlusOutlined />, show: !finalized },
          { target: 'verification', label: 'Верификация', icon: <FileSearchOutlined />, show: !finalized },
          { target: 'protocol', label: 'Протокол', icon: <FileTextOutlined />, show: true },
        ];
        return (
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            <Button block type="primary" size="small" onClick={() => goNext(record)} style={{ height: 'auto', minHeight: 24, whiteSpace: 'normal', lineHeight: 1.3, padding: '3px 8px' }}>
              {next.label}
            </Button>
            {others
              .filter((o) => o.show && o.target !== next.target)
              .map((o) => (
                <Button
                  key={o.target}
                  block
                  size="small"
                  icon={o.icon}
                  onClick={() => (o.target === 'upload' ? handleUpload(record.id) : o.target === 'verification' ? handleVerification(record.id) : handleProtocol(record.id))}
                >
                  {o.label}
                </Button>
              ))}
          </Space>
        );
      },
    },
    {
      title: '',
      key: 'delete',
      width: 52,
      render: (_: unknown, record: Project) => (
        <Tooltip title="Удалить проект">
          <Button type="text" danger size="small" icon={<DeleteOutlined />} aria-label="Удалить проект" onClick={() => handleDelete(record)} />
        </Tooltip>
      ),
    },
    ];
  };

  // Реквизиты нужны редко: раскрываются по строке, а не занимают четыре колонки таблицы
  const projectDetails = (record: Project) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
      {[
        ['Адрес', record.address],
        ['Застройщик', record.developer],
        ['Подрядчик', record.contractor],
        ['Разрешение', record.permit],
      ].map(([label, value]) => (
        <div key={label}>
          <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
            {label}
          </Text>
          <Text style={{ fontSize: 13 }}>{value || 'нет'}</Text>
        </div>
      ))}
    </div>
  );

  const cardStyle: React.CSSProperties = {
    borderRadius: 12,
    background: token.colorBgContainer,
    border: `1px solid ${token.colorBorder}`,
  };

  const rollbackRequests = useUnfinalizeRequests(supervisor && source === 'api');
  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const statCards = [
    { title: 'Всего проектов', value: stats.total, target: undefined as string | undefined, icon: <FolderOutlined style={{ fontSize: 32, color: token.colorPrimary }} /> },
    { title: 'На проверке', value: stats.inReview, target: 'dash-review', icon: <ClockCircleOutlined style={{ fontSize: 32, color: token.colorWarning }} /> },
    { title: 'Финализировано', value: stats.finalized, target: 'dash-finalized', icon: <CheckCircleOutlined style={{ fontSize: 32, color: token.colorSuccess }} /> },
    ...(supervisor && source === 'api'
      ? [{ title: 'Запросы на откат', value: rollbackRequests.isLoading ? '…' : (rollbackRequests.data ?? []).length, target: 'dash-rollback', icon: <LockOutlined style={{ fontSize: 32, color: token.colorPrimary }} /> }]
      : []),
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ padding: '16px 24px', background: token.colorBgContainer, borderBottom: `1px solid ${token.colorBorder}` }}>
        <Title level={2} style={{ margin: 0 }}>
          {supervisor ? 'Дашборд супервизора' : 'Дашборд инспектора'}
        </Title>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        <WelcomeCard />
        <Row gutter={[24, 24]} style={{ marginBottom: 24 }}>
          {statCards.map((item) => (
            <Col xs={24} sm={12} md={supervisor && source === 'api' ? 6 : 8} key={item.title}>
              <Card
                {...(item.target
                  ? {
                      hoverable: true,
                      role: 'button',
                      tabIndex: 0,
                      'aria-label': `${item.title}: ${item.value}. Перейти к списку`,
                      onClick: () => scrollTo(item.target!),
                      onKeyDown: (e: React.KeyboardEvent) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          scrollTo(item.target!);
                        }
                      },
                    }
                  : {})}
                style={cardStyle}
              >
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {item.icon}
                  <div style={{ fontSize: 48, fontWeight: 600, lineHeight: 1.2 }}>{item.value}</div>
                  <Text type="secondary" style={{ fontSize: 14 }}>
                    {item.title}
                  </Text>
                </Space>
              </Card>
            </Col>
          ))}
        </Row>

        {supervisor && source === 'api' && <RollbackRequestsCard />}

        <Card
          id="dash-review"
          title={
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <Text strong style={{ fontSize: 17 }}>
                Проекты на проверке
              </Text>
              <Space size={12} wrap>
                {searchInput(reviewQuery, setReviewQuery)}
                <Button type="primary" icon={<PlusOutlined />} onClick={handleAddProject}>
                  Добавить проект
                </Button>
              </Space>
            </div>
          }
          style={{ ...cardStyle, marginBottom: 24 }}
          styles={{ body: { padding: 12 } }}
        >
          <Table
            columns={buildColumns(false)}
            onChange={(_p, _f, sorter) => handleSort('review', sorter)}
            dataSource={reviewShown}
            rowKey="id"
            pagination={{ defaultPageSize: 10, hideOnSinglePage: true, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'] }}
            loading={isLoading}
            size="small"
            tableLayout="fixed"
            scroll={{ x: 1200 }}
            expandable={{ expandedRowRender: projectDetails, rowExpandable: () => true }}
            locale={{
              emptyText: reviewQuery.trim() ? (
                <TableEmpty>По запросу ничего не найдено</TableEmpty>
              ) : (
                <TableEmpty
                  hint="Загрузите комплект документов: разбор и сравнение запустятся сами."
                  action={
                    <Button type="primary" icon={<PlusOutlined />} onClick={handleAddProject}>
                      Добавить проект
                    </Button>
                  }
                >
                  Нет проектов на проверке
                </TableEmpty>
              ),
            }}
          />
        </Card>

        <Card
          id="dash-finalized"
          title={
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <Text strong style={{ fontSize: 17 }}>
                Финализированные проекты
              </Text>
              {searchInput(finalizedQuery, setFinalizedQuery)}
            </div>
          }
          style={cardStyle}
          styles={{ body: { padding: 12 } }}
        >
          <Table
            columns={buildColumns(true)}
            onChange={(_p, _f, sorter) => handleSort('finalized', sorter)}
            dataSource={finalizedShown}
            rowKey="id"
            pagination={{ defaultPageSize: 10, hideOnSinglePage: true, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'] }}
            loading={isLoading}
            size="small"
            tableLayout="fixed"
            scroll={{ x: 1200 }}
            expandable={{ expandedRowRender: projectDetails, rowExpandable: () => true }}
            locale={{
              emptyText: (
                <TableEmpty hint={finalizedQuery.trim() ? undefined : 'Проект попадает сюда после того, как проверка завершена в протоколе.'}>
                  {finalizedQuery.trim() ? 'По запросу ничего не найдено' : 'Нет финализированных проектов'}
                </TableEmpty>
              ),
            }}
          />
        </Card>
      </div>
    </div>
  );
};

/** Администратору при работе с api — свой дашборд (разбор для дообучения), остальным ролям — список проектов. */
export const DashboardPage: React.FC = () => {
  const { user } = useAuth();
  const { source } = useProjects();
  if (source === 'api' && user?.role === 'ADMIN') return <AdminDashboard />;
  if (source === 'api' && user?.role === 'ML_ENGINEER') return <MlDashboard />;
  return <InspectorDashboard supervisor={user?.role === 'SUPERVISOR'} />;
};
