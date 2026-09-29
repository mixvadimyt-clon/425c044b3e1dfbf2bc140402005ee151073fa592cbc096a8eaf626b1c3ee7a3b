import React from 'react';
import { Alert, App, Button, Card, Col, Input, Modal, Row, Segmented, Space, Table, Typography, theme } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { CheckCircleOutlined, ClockCircleOutlined, LockOutlined, MinusCircleOutlined, SearchOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useProjects } from '@/app/providers/useProjects';
import { formatDateTime, unfinalizeProcess } from '@/api/protocols';
import { rejectUnfinalizeRequest, useUnfinalizeRequests } from '@/api/unfinalizeRequests';
import type { UnfinalizeRequest } from '@/api/unfinalizeRequests';
import { useInspectorComments, useRetrainItems } from '@/api/retrain';
import { RetrainTable } from '@/widgets/RetrainTable';
import { TableEmpty } from '@/widgets/TableEmpty';
import { InfoHint } from '@/widgets/InfoHint';
import { WelcomeCard } from '@/widgets/WelcomeGuide';
import { REJECT_REASON } from '@/shared/statuses';
import type { Project } from '@/shared/projects';
import type { RetrainItem } from '@/shared/retrainQueue';

const { Title, Text } = Typography;
const { TextArea } = Input;

type DoneFilter = 'all' | 'sent' | 'skipped';

const th = (title: string) => (
  <Text strong style={{ fontSize: 14 }}>
    {title}
  </Text>
);

const matches = (item: RetrainItem, query: string): boolean => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [item.projectName, item.parameter, item.reasonCode ? REJECT_REASON[item.reasonCode].label : '', item.inspectorComment].join(' ').toLowerCase().includes(q);
};

/**
 * Дашборд администратора: что нужно сделать и что уже сделано.
 * Разбор для дообучения: решения инспекторов об отклонении кандидатов, по которым нужно решить, отправлять ли их на дообучение модели.
 * Финализированные проекты: их можно откатить (нужна причина, она попадает в журнал аудита); откаты записаны ниже.
 */
export const AdminDashboard: React.FC = () => {
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const { projects } = useProjects();
  const retrain = useRetrainItems(true);

  const [todoQuery, setTodoQuery] = React.useState('');
  const [doneQuery, setDoneQuery] = React.useState('');
  const [doneFilter, setDoneFilter] = React.useState<DoneFilter>('all');
  const [requestsQuery, setRequestsQuery] = React.useState('');
  const [rollbackProject, setRollbackProject] = React.useState<Project | null>(null);
  const [rollbackReason, setRollbackReason] = React.useState('');
  const [rollingBack, setRollingBack] = React.useState(false);
  const requests = useUnfinalizeRequests(true);
  const [rejecting, setRejecting] = React.useState<UnfinalizeRequest | null>(null);
  const [rejectReason, setRejectReason] = React.useState('');
  const [rejectBusy, setRejectBusy] = React.useState(false);

  // В разбор попадают и отклонённые кандидаты, и подтверждённые нарушения — оба вида дают запись GOLD-набора,
  // которую администратор одобряет или исключает (REQ-ML-02)
  // Комментарии читаем массово только для поиска по ним; в таблицах каждая строка сама просит свой (по одному запросу на показанную запись)
  const searching = Boolean(todoQuery.trim() || doneQuery.trim());
  const comments = useInspectorComments(retrain.items.map((item) => item.findingId).filter(Boolean), searching);
  const items = retrain.items.map((item) => ({ ...item, inspectorComment: comments.get(item.findingId) ?? '' }));
  const todo = items.filter((item) => item.status === 'pending');
  const done = items.filter((item) => item.status !== 'pending');
  const sent = done.filter((item) => item.status === 'sent');
  const skipped = done.filter((item) => item.status === 'skipped');
  const doneShown = done.filter((item) => (doneFilter === 'all' || item.status === (doneFilter === 'sent' ? 'sent' : 'skipped')) && matches(item, doneQuery));


  const openRetrain = (item: RetrainItem) => navigate(`/verification?object=${item.projectId}&mode=retrain&finding=${item.findingId}`);

  const closeRollback = () => {
    setRollbackProject(null);
    setRollbackReason('');
  };
  const confirmRollback = async () => {
    if (!rollbackProject?.processId || !rollbackReason.trim()) return;
    setRollingBack(true);
    try {
      await unfinalizeProcess(rollbackProject.processId, rollbackReason.trim());
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось откатить финализацию');
      setRollingBack(false);
      return;
    }
    setRollingBack(false);
    message.success(`Финализация проекта «${rollbackProject.name}» откатена, причина записана в журнал аудита`);
    closeRollback();
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
    void queryClient.invalidateQueries({ queryKey: ['process-status'] });
    void queryClient.invalidateQueries({ queryKey: ['audit'] });
    void queryClient.invalidateQueries({ queryKey: ['unfinalize-requests'] });
  };

  const closeReject = () => {
    setRejecting(null);
    setRejectReason('');
  };
  const confirmReject = async () => {
    if (!rejecting || !rejectReason.trim()) return;
    setRejectBusy(true);
    try {
      await rejectUnfinalizeRequest(rejecting.id, rejectReason.trim());
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось отклонить запрос');
      setRejectBusy(false);
      return;
    }
    setRejectBusy(false);
    message.success('Запрос отклонён, причина сохранена');
    closeReject();
    void queryClient.invalidateQueries({ queryKey: ['unfinalize-requests'] });
  };

  const cardStyle: React.CSSProperties = { borderRadius: 12, background: token.colorBgContainer, border: `1px solid ${token.colorBorder}` };
  const requestsShown = (requests.data ?? []).filter((r) => {
    const q = requestsQuery.trim().toLowerCase();
    return !q || [r.object_name, r.requested_by_name, r.reason].join(' ').toLowerCase().includes(q);
  });
  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const openCard = (item: { target: string; doneFilter?: DoneFilter }) => {
    if (item.doneFilter) setDoneFilter(item.doneFilter);
    scrollTo(item.target);
  };
  const statCards: Array<{ title: string; value: number; icon: React.ReactNode; target: string; doneFilter?: DoneFilter }> = [
    { title: 'Запросы на откат', value: requests.data?.length ?? 0, target: 'adm-requests', icon: <LockOutlined style={{ fontSize: 32, color: token.colorPrimary }} /> },
    { title: 'Ждут решения', value: todo.length, target: 'adm-todo', icon: <ClockCircleOutlined style={{ fontSize: 32, color: token.colorWarning }} /> },
    { title: 'Отправлено на дообучение', value: sent.length, target: 'adm-done', doneFilter: 'sent', icon: <CheckCircleOutlined style={{ fontSize: 32, color: token.colorSuccess }} /> },
    { title: 'Не отправлено', value: skipped.length, target: 'adm-done', doneFilter: 'skipped', icon: <MinusCircleOutlined style={{ fontSize: 32, color: token.colorTextSecondary }} /> },
  ];

  const searchInput = (value: string, onChange: (v: string) => void, placeholder = 'Поиск: проект, параметр, причина, комментарий') => (
    <Input
      allowClear
      value={value}
      onChange={(e) => onChange(e.target.value)}
      prefix={<SearchOutlined />}
      placeholder={placeholder}
      style={{ width: 300, maxWidth: '100%' }}
    />
  );

  const cardTitle = (title: string, hint: string, extra?: React.ReactNode) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <div>
        <Text strong style={{ fontSize: 17 }}>
          {title}
        </Text>
        <InfoHint label={`Пояснение: ${title}`}>{hint}</InfoHint>
      </div>
      {extra}
    </div>
  );

  const requestColumns: ColumnsType<UnfinalizeRequest> = [
    { title: th('Проект'), key: 'object', width: 190, className: 'col-wrap', render: (_: unknown, r: UnfinalizeRequest) => <Text strong style={{ fontSize: 14 }}>{r.object_name || 'Проект'}</Text> },
    { title: th('Инспектор'), key: 'by', width: 160, className: 'col-wrap', render: (_: unknown, r: UnfinalizeRequest) => <Text style={{ fontSize: 13 }}>{r.requested_by_name || 'нет'}</Text> },
    { title: th('Причина'), dataIndex: 'reason', key: 'reason', width: 340, className: 'col-wrap', render: (text: string) => <Text style={{ fontSize: 13 }}>{text}</Text> },
    { title: th('Запрошено'), key: 'time', width: 150, render: (_: unknown, r: UnfinalizeRequest) => <Text style={{ fontSize: 13 }}>{formatDateTime(r.created_at) || r.created_at}</Text> },
    {
      title: th('Действия'),
      key: 'actions',
      width: 290,
      render: (_: unknown, r: UnfinalizeRequest) => {
        const project = projects.find((p) => p.id === r.object_id);
        return (
          <Space size={8}>
            <Button size="small" onClick={() => navigate(`/protocol?object=${r.object_id}`)}>
              Протокол
            </Button>
            <Button size="small" danger onClick={() => project && setRollbackProject(project)} disabled={!project?.processId}>
              Откатить
            </Button>
            <Button className="negative-action" size="small" onClick={() => setRejecting(r)}>
              Отклонить
            </Button>
          </Space>
        );
      },
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 24px', background: token.colorBgContainer, borderBottom: `1px solid ${token.colorBorder}` }}>
        <Title level={2} style={{ margin: 0 }}>
          Дашборд администратора
        </Title>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        <WelcomeCard />
        {retrain.isError && <Alert type="error" showIcon style={{ marginBottom: 24 }} message="Не удалось загрузить записи для дообучения. Проверьте связь с сервером." />}

        {(requests.data?.length ?? 0) > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 24 }}
            message={`Инспекторы ждут вашего решения: запросов на откат ${requests.data?.length}`}
            description="Пока запрос открыт, проект остаётся финализированным. Он показан первым блоком ниже."
          />
        )}

        <Row gutter={[24, 24]} style={{ marginBottom: 24 }}>
          {statCards.map((item) => (
            <Col xs={24} sm={12} xl={6} key={item.title}>
              <Card
                hoverable
                role="button"
                tabIndex={0}
                aria-label={`${item.title}: ${item.value}. Перейти к списку`}
                style={cardStyle}
                onClick={() => openCard(item)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openCard(item);
                  }
                }}
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

        <Card
          id="adm-requests"
          title={cardTitle('Запросы на откат финализации', 'Инспектор просит вернуть проект на проверку: откатите финализацию или откажите с причиной', searchInput(requestsQuery, setRequestsQuery, 'Поиск по запросам'))}
          style={{ ...cardStyle, marginBottom: 24 }}
          styles={{ body: { padding: 12 } }}
        >
          <Table
            columns={requestColumns}
            dataSource={requestsShown}
            rowKey="id"
            pagination={{ defaultPageSize: 10, hideOnSinglePage: true, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'], position: ['bottomLeft'] }}
            loading={requests.isLoading}
            size="small"
            tableLayout="fixed"
            scroll={{ x: 1130 }}
            locale={{ emptyText: <TableEmpty>{requests.isError ? 'Не удалось загрузить запросы' : requestsQuery.trim() ? 'По запросу ничего не найдено' : 'Открытых запросов нет'}</TableEmpty> }}
          />
        </Card>

        <Card
          id="adm-todo"
          title={cardTitle('Записи для дообучения', 'Отклонённые кандидаты и подтверждённые нарушения: решите, отправлять ли запись на дообучение модели', searchInput(todoQuery, setTodoQuery))}
          style={{ ...cardStyle, marginBottom: 24 }}
          styles={{ body: { padding: 12 } }}
        >
          <RetrainTable
            items={todo.filter((item) => matches(item, todoQuery))}
            loading={retrain.isLoading}
            emptyText={todoQuery.trim() ? 'По запросу ничего не найдено' : 'Все записи обработаны: ждущих решения нет'}
            onOpen={openRetrain}
          />
        </Card>

        <Card
          id="adm-done"
          title={cardTitle(
            'Решения приняты',
            'Записи, по которым решение уже принято',
            <Space size={12} wrap>
              <Segmented<DoneFilter>
                value={doneFilter}
                onChange={setDoneFilter}
                options={[
                  { value: 'all', label: `Все (${done.length})` },
                  { value: 'sent', label: `Отправлено (${sent.length})` },
                  { value: 'skipped', label: `Не отправлено (${skipped.length})` },
                ]}
              />
              {searchInput(doneQuery, setDoneQuery)}
            </Space>,
          )}
          style={cardStyle}
          styles={{ body: { padding: 12 } }}
        >
          <RetrainTable
            items={doneShown}
            showOutcome
            loading={retrain.isLoading}
            emptyText={doneQuery.trim() || doneFilter !== 'all' ? 'По запросу ничего не найдено' : 'Записей с принятым решением пока нет'}
            onOpen={openRetrain}
          />
        </Card>
      </div>

      <Modal
        title={`Откатить финализацию проекта «${rollbackProject?.name ?? ''}»`}
        open={Boolean(rollbackProject)}
        onOk={() => void confirmRollback()}
        onCancel={closeRollback}
        okText="Откатить"
        cancelText="Закрыть"
        confirmLoading={rollingBack}
        okButtonProps={{ danger: true, disabled: !rollbackReason.trim() }}
      >
        <Text type="secondary">Проект вернётся инспектору на проверку. Причина обязательна и попадёт в журнал аудита.</Text>
        <TextArea rows={4} value={rollbackReason} onChange={(e) => setRollbackReason(e.target.value)} placeholder="Почему нужно вернуть проверку в работу" style={{ marginTop: 12 }} />
      </Modal>

      <Modal
        title={`Отклонить запрос по проекту «${rejecting?.object_name ?? ''}»`}
        open={Boolean(rejecting)}
        onOk={() => void confirmReject()}
        onCancel={closeReject}
        okText="Отклонить"
        cancelText="Закрыть"
        confirmLoading={rejectBusy}
        okButtonProps={{ danger: true, disabled: !rejectReason.trim() }}
      >
        <Text type="secondary">Финализация останется в силе, причина отказа сохранится в запросе.</Text>
        <TextArea rows={4} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="Почему откат не нужен" style={{ marginTop: 12 }} />
      </Modal>
    </div>
  );
};
