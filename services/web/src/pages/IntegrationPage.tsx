import React from 'react';
import { Alert, App, Button, Card, Input, Segmented, Skeleton, Space, Table, Typography, theme } from 'antd';
import { CloudDownloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/app/providers/useAuth';
import { useProjects } from '@/app/providers/useProjects';
import { pollIntervalText, useApplyPackage, useIntegrationPackages, usePullPackages } from '@/api/integration';
import { useIntegrationStatus } from '@/api/system';
import { QueryErrorAlert } from '@/widgets/QueryErrorAlert';
import type { IntegrationPackage, IntegrationPackageStatus } from '@/api/integration';
import { formatDateTime } from '@/api/protocols';
import { StatusPill } from '@/widgets/StatusPill';
import { withoutLongDash } from '@/shared/text';
import { INTEGRATION_PACKAGE_STATUS } from '@/shared/statuses';

const { Title, Text } = Typography;

type Filter = 'ALL' | IntegrationPackageStatus;

const retryText = (delays: number[] | undefined): string => {
  if (!delays || delays.length === 0) return 'без повторов';
  return `через ${delays.map((s) => (s % 60 === 0 ? `${s / 60} мин` : `${s} с`)).join(', ')}`;
};

/** Обмен с внешней ИС (ИАИС «РиН»): состояние, забор пакетов документов, пакеты и создание проверки из отложенного. */
export const IntegrationPage: React.FC = () => {
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { projects, reload } = useProjects();
  const statusQuery = useIntegrationStatus(true);
  const packagesQuery = useIntegrationPackages();
  const pull = usePullPackages();
  const apply = useApplyPackage();
  const [filter, setFilter] = React.useState<Filter>('ALL');
  const [applyingId, setApplyingId] = React.useState<string | null>(null);

  // Хук шапки отдаёт null, если сервер не ответил или роли отказано: для страницы это ошибка
  const status = statusQuery.data ?? undefined;
  const system = status?.external_system ?? 'внешней ИС';
  const projectName = React.useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const cardStyle: React.CSSProperties = { borderRadius: 12, background: token.colorBgContainer, border: `1px solid ${token.colorBorder}` };

  const [query, setQuery] = React.useState('');
  const packages = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return (packagesQuery.data ?? [])
      .filter((p) => filter === 'ALL' || p.status === filter)
      .filter((p) => !q || [p.title, p.package_id, p.external_object_id, p.message].join(' ').toLowerCase().includes(q));
  }, [packagesQuery.data, filter, query]);
  const counts = React.useMemo(() => {
    const all = packagesQuery.data ?? [];
    return { ALL: all.length, DEFERRED: all.filter((p) => p.status === 'DEFERRED').length, FAILED: all.filter((p) => p.status === 'FAILED').length, APPLIED: all.filter((p) => p.status === 'APPLIED').length };
  }, [packagesQuery.data]);

  const handlePull = async () => {
    try {
      const pulled = await pull.mutateAsync();
      void reload();
      message.success(pulled.length > 0 ? `Новых пакетов: ${pulled.length}` : 'Новых пакетов нет');
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось забрать документы');
    }
  };

  const handleApply = async (pkg: IntegrationPackage) => {
    setApplyingId(pkg.id);
    try {
      await apply.mutateAsync(pkg.id);
      void reload();
      message.success('Проверка создана, анализ запущен');
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось создать проверку');
    } finally {
      setApplyingId(null);
    }
  };

  // У администратора верификация занята разбором дообучения, поэтому он открывает протокол
  const openCheck = (pkg: IntegrationPackage) => {
    if (!pkg.object_id) return;
    navigate(`${user?.role === 'ADMIN' ? '/protocol' : '/verification'}?object=${pkg.object_id}`);
  };

  const columns = [
    {
      title: 'Получен',
      dataIndex: 'received_at',
      key: 'received_at',
      width: 150,
      render: (value: string) => <Text style={{ fontSize: 13 }}>{formatDateTime(value)}</Text>,
    },
    {
      title: 'Пакет',
      key: 'package',
      width: 260,
      className: 'col-wrap',
      render: (_: unknown, pkg: IntegrationPackage) => (
        <div>
          <Text strong style={{ overflowWrap: 'anywhere' }}>{pkg.title || pkg.package_id}</Text>
          <Text type="secondary" style={{ display: 'block', fontSize: 12, overflowWrap: 'anywhere' }}>
            {pkg.object_id ? (projectName.get(pkg.object_id) ?? 'Объект') : 'Объект не определён'}
          </Text>
          <Text type="secondary" style={{ display: 'block', fontSize: 12, overflowWrap: 'anywhere' }}>
            Объект в {system}: {pkg.external_object_id}
          </Text>
        </div>
      ),
    },
    {
      title: 'Файлы',
      key: 'files',
      width: 130,
      render: (_: unknown, pkg: IntegrationPackage) => (
        <div style={{ fontSize: 13 }}>
          <div>{pkg.accepted_count != null ? `${pkg.accepted_count} из ${pkg.files_count}` : pkg.files_count}</div>
          {pkg.has_registry && <div>С реестром</div>}
        </div>
      ),
    },
    {
      title: 'Статус',
      key: 'status',
      width: 200,
      render: (_: unknown, pkg: IntegrationPackage) => <StatusPill color={INTEGRATION_PACKAGE_STATUS[pkg.status].color}>{INTEGRATION_PACKAGE_STATUS[pkg.status].label}</StatusPill>,
    },
    {
      title: 'Сообщение',
      key: 'message',
      width: 300,
      className: 'col-wrap',
      render: (_: unknown, pkg: IntegrationPackage) => {
        const text = pkg.error || pkg.message;
        return text ? <Text type={pkg.error ? 'danger' : 'secondary'} style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{withoutLongDash(text)}</Text> : <Text type="secondary">нет</Text>;
      },
    },
    {
      title: '',
      key: 'actions',
      width: 170,
      render: (_: unknown, pkg: IntegrationPackage) => {
        if (pkg.status === 'APPLIED') {
          return pkg.object_id ? <Button size="small" onClick={() => openCheck(pkg)}>Открыть проверку</Button> : null;
        }
        return (
          <Button size="small" type="primary" loading={applyingId === pkg.id} onClick={() => void handleApply(pkg)}>
            Создать проверку
          </Button>
        );
      },
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 24px', background: token.colorBgContainer, borderBottom: `1px solid ${token.colorBorder}` }}>
        <Title level={2} style={{ margin: 0 }}>
          Интеграция
        </Title>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {statusQuery.isLoading && (
            <Card style={cardStyle}>
              <Skeleton active paragraph={{ rows: 3 }} />
            </Card>
          )}

          {statusQuery.data === null && <QueryErrorAlert title="Не удалось получить состояние обмена" onRetry={() => void statusQuery.refetch()} />}

          {status && !status.enabled && (
            <Alert type="warning" showIcon message="Обмен с внешней ИС не настроен" description="Адрес внешней ИС не задан (RIN_URL), поэтому документы не забираются и результаты не отправляются." />
          )}

          {status && (
            <Card
              style={cardStyle}
              title={<Text strong style={{ fontSize: 15 }}>Обмен с {system}</Text>}
              extra={
                <Button type="primary" icon={<CloudDownloadOutlined />} loading={pull.isPending} disabled={!status.enabled} onClick={() => void handlePull()}>
                  Забрать документы
                </Button>
              }
            >
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px 24px' }}>
                <Field label="Адрес" value={status.base_url || 'не задан'} />
                <Field label="Автозабор документов" value={pollIntervalText(status.poll_interval_s)} />
                <Field label="Отправка результатов" value={status.auto_push ? 'сразу после финализации' : 'вручную'} />
                <Field label="Повторы при сбое" value={retryText(status.retry_delays_s)} />
                <Field label="Последний забор" value={status.last_pull_at ? formatDateTime(status.last_pull_at) : 'ещё не было'} />
                <div>
                  <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>Очередь отправки результатов</Text>
                  <Space size={6} wrap style={{ marginTop: 4 }}>
                    <StatusPill tone="warning">Ждут: {status.outbox.pending}</StatusPill>
                    <StatusPill tone="success">Передано: {status.outbox.synced}</StatusPill>
                    <StatusPill tone="error">Не передано: {status.outbox.failed}</StatusPill>
                  </Space>
                </div>
              </div>
              {status.last_pull_error && <Alert style={{ marginTop: 16 }} type="warning" showIcon message="Последний забор не удался" description={withoutLongDash(status.last_pull_error)} />}
            </Card>
          )}

          <Card
            style={cardStyle}
            title={<Text strong style={{ fontSize: 15 }}>Пакеты документов</Text>}
          >
            <div style={{ marginBottom: 16 }}>

              <Space size={12} wrap>
                <Input
                  allowClear
                  prefix={<SearchOutlined />}
                  placeholder="Поиск: пакет, проект, сообщение"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  style={{ width: 260, maxWidth: '100%' }}
                />
              <Segmented
                value={filter}
                onChange={(value) => setFilter(value as Filter)}
                options={[
                  { value: 'ALL', label: `Все (${counts.ALL})` },
                  { value: 'DEFERRED', label: `Ждут решения (${counts.DEFERRED})` },
                  { value: 'FAILED', label: `Не приняты (${counts.FAILED})` },
                  { value: 'APPLIED', label: `Запущены (${counts.APPLIED})` },
                ]}
              />
              </Space>
            </div>
            {packagesQuery.isError ? (
              <QueryErrorAlert title="Не удалось получить пакеты" error={packagesQuery.error} onRetry={() => void packagesQuery.refetch()} />
            ) : (
              <Table
                rowKey="id"
                size="middle"
                columns={columns}
                dataSource={packages}
                loading={packagesQuery.isLoading}
                pagination={{ defaultPageSize: 10, hideOnSinglePage: true, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'] }}
                scroll={{ x: 1100 }}
                locale={{ emptyText: query.trim() ? 'По запросу ничего не найдено' : filter === 'ALL' ? `Пакетов из ${system} ещё не было` : 'В этом разделе пакетов нет' }}
              />
            )}
          </Card>
        </Space>
      </div>
    </div>
  );
};

const Field: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>{label}</Text>
    <Text style={{ overflowWrap: 'anywhere' }}>{value}</Text>
  </div>
);
