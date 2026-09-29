import React from 'react';
import { Alert, App, Button, Card, Form, Input, Modal, Select, Space, Table, Tooltip, Typography, theme } from 'antd';
import { CheckCircleFilled, CloseCircleFilled, SearchOutlined } from '@ant-design/icons';
import { formatDateTime } from '@/api/protocols';
import { QueryErrorAlert } from '@/widgets/QueryErrorAlert';
import { failedChecksOf, useDecideModel, useModels } from '@/api/ml';
import type { ModelAction, ModelVersion } from '@/api/ml';
import { StatusPill } from '@/widgets/StatusPill';
import { InfoHint } from '@/widgets/InfoHint';
import { withoutLongDash } from '@/shared/text';
import { MODEL_APPROVAL_STATUS } from '@/shared/statuses';

const { Text } = Typography;

const ACTION_TEXT: Record<ModelAction, { title: string; ok: string; done: string; hint: string; danger?: boolean }> = {
  APPROVE: { title: 'Одобрить модель', ok: 'Одобрить', done: 'Модель одобрена и стала текущей', hint: 'Модель станет текущей, прежняя останется в истории. Приёмочные проверки пересчитываются в момент решения.' },
  REJECT: { title: 'Отклонить модель', ok: 'Отклонить', done: 'Модель отклонена', hint: 'Модель не будет использоваться.', danger: true },
  ROLLBACK: { title: 'Откатить модель', ok: 'Откатить', done: 'Модель откачена', hint: 'Текущей снова станет предыдущая одобренная модель. Если её нет, система работает без модели, только по правилам.', danger: true },
};

const percent = (value?: number): string => (value == null ? 'нет' : `${(value * 100).toFixed(1).replace('.', ',')} %`);

/** Реестр моделей и журнал дообучения: метрики §14, приёмочные проверки, решения (REQ-ML-04, REQ-ML-05). */
export const ModelsTab: React.FC<{ canAct: boolean }> = ({ canAct }) => {
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const models = useModels();
  const decide = useDecideModel();
  const [form] = Form.useForm<{ comment: string }>();
  const [target, setTarget] = React.useState<{ model: ModelVersion; action: ModelAction } | null>(null);
  const [error, setError] = React.useState<{ text: string; failed: string[] } | null>(null);
  const [query, setQuery] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<ModelVersion['approval_status'] | 'ALL'>('ALL');
  const shown = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return (models.data ?? []).filter(
      (m) => (statusFilter === 'ALL' || m.approval_status === statusFilter) && (!q || m.model_version.toLowerCase().includes(q) || (m.comment ?? '').toLowerCase().includes(q)),
    );
  }, [models.data, query, statusFilter]);

  const open = (model: ModelVersion, action: ModelAction) => {
    setError(null);
    form.resetFields();
    setTarget({ model, action });
  };

  const submit = async () => {
    if (!target) return;
    const { comment } = await form.validateFields();
    setError(null);
    try {
      await decide.mutateAsync({ version: target.model.model_version, action: target.action, comment: comment.trim() });
      message.success(ACTION_TEXT[target.action].done);
      setTarget(null);
    } catch (e) {
      setError({ text: e instanceof Error ? e.message : 'Не удалось сохранить решение', failed: failedChecksOf(e) });
    }
  };

  const columns = [
    {
      title: 'Модель',
      key: 'model',
      width: 210,
      render: (_: unknown, row: ModelVersion) => (
        <Space size={6} wrap>
          <Text strong>{row.model_version}</Text>
          {row.is_current && <StatusPill tone="success">Используется</StatusPill>}
        </Space>
      ),
    },
    {
      title: 'Статус',
      dataIndex: 'approval_status',
      key: 'approval_status',
      width: 150,
      render: (value: ModelVersion['approval_status']) => <StatusPill color={MODEL_APPROVAL_STATUS[value].color}>{MODEL_APPROVAL_STATUS[value].label}</StatusPill>,
    },
    { title: 'Набор', dataIndex: 'dataset_version', key: 'dataset_version', width: 130, render: (value: string) => <Text style={{ fontSize: 13 }}>{value}</Text> },
    {
      title: 'Метрики',
      key: 'metrics',
      width: 300,
      className: 'col-wrap',
      render: (_: unknown, row: ModelVersion) => (
        <div style={{ fontSize: 13 }}>
          <div>Точность: {percent(row.metrics?.precision)}</div>
          <div>Полнота: {percent(row.metrics?.recall)}</div>
          <div>F1: {percent(row.metrics?.f1)}</div>
          <div>Ложные срабатывания: {percent(row.metrics?.false_positive_rate)}</div>
        </div>
      ),
    },
    {
      title: 'Приёмка',
      key: 'thresholds',
      width: 140,
      render: (_: unknown, row: ModelVersion) =>
        row.thresholds_passed == null ? <Text type="secondary">нет</Text> : <StatusPill tone={row.thresholds_passed ? 'success' : 'error'}>{row.thresholds_passed ? 'Пройдена' : 'Не пройдена'}</StatusPill>,
    },
    { title: 'Зарегистрирована', dataIndex: 'created_at', key: 'created_at', width: 150, render: (value: string) => <Text style={{ fontSize: 13 }}>{formatDateTime(value)}</Text> },
    ...(canAct
      ? [
          {
            title: '',
            key: 'actions',
            width: 190,
            render: (_: unknown, row: ModelVersion) => (
              <Space size={6}>
                {row.approval_status === 'PENDING' && (
                  <>
                    <Tooltip title={row.thresholds_passed === false ? 'Проверки приёмки не пройдены: сервер откажет, пока они не выполнены' : undefined}>
                      <Button size="small" type="primary" onClick={() => open(row, 'APPROVE')}>
                        Одобрить
                      </Button>
                    </Tooltip>
                    <Button className="negative-action" size="small" onClick={() => open(row, 'REJECT')}>
                      Отклонить
                    </Button>
                  </>
                )}
                {row.is_current && (
                  <Button size="small" danger onClick={() => open(row, 'ROLLBACK')}>
                    Откатить
                  </Button>
                )}
              </Space>
            ),
          },
        ]
      : []),
  ];

  return (
    <Card style={{ borderRadius: 12, background: token.colorBgContainer, border: `1px solid ${token.colorBorder}` }} extra={
      <Space size={12} wrap>
        <Input allowClear value={query} onChange={(e) => setQuery(e.target.value)} prefix={<SearchOutlined />} placeholder="Поиск: версия, комментарий" style={{ width: 260, maxWidth: '100%' }} />
        <Select
          value={statusFilter}
          onChange={setStatusFilter}
          style={{ width: 170 }}
          options={[{ value: 'ALL', label: 'Все статусы' }, ...Object.entries(MODEL_APPROVAL_STATUS).map(([value, meta]) => ({ value, label: meta.label }))]}
        />
      </Space>
    } title={
      <>
        <Text strong style={{ fontSize: 15 }}>Модели</Text>
        <InfoHint label="Пояснение: модели">
          Новые сверху. Модель начинает работать только после решения ML-инженера. «Приёмка» — автоматическая проверка: метрики модели не ниже установленных порогов качества и не хуже, чем у текущей модели.
        </InfoHint>
      </>
    }>
      {models.isError ? (
        <QueryErrorAlert title="Не удалось загрузить модели" error={models.error} onRetry={() => void models.refetch()} />
      ) : (
        <Table
          rowKey="model_version"
          size="middle"
          columns={columns}
          dataSource={shown}
          loading={models.isLoading}
          scroll={{ x: 1100 }}
          pagination={{ showSizeChanger: true, pageSizeOptions: ['10', '20', '50'], hideOnSinglePage: true }}
          locale={{ emptyText: query.trim() || statusFilter !== 'ALL' ? 'Ничего не найдено' : 'Моделей ещё не регистрировали: обучение записывает их командой inspector-ml train' }}
          expandable={{
            expandedRowRender: (row) => (
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                {(row.threshold_checks ?? []).length === 0 && <Text type="secondary">Проверок приёмки нет</Text>}
                {(row.threshold_checks ?? []).map((check, i) => (
                  <Text key={i} style={{ fontSize: 13, color: check.passed ? '#065F46' : '#991B1B' }}>
                    {check.passed ? <CheckCircleFilled /> : <CloseCircleFilled />} {withoutLongDash(check.message)}
                  </Text>
                ))}
                {row.comment && (
                  <Text type="secondary" style={{ fontSize: 13 }}>
                    Комментарий решения: {row.comment}
                  </Text>
                )}
                <div style={{ fontSize: 12, color: token.colorTextSecondary, overflowWrap: 'anywhere' }}>
                  {row.matrix_version && <div>Матрица: {row.matrix_version}</div>}
                  {row.code_version && <div>Код обучения: {row.code_version}</div>}
                  {row.artifact_hash && <div>Файл модели: {row.artifact_hash}</div>}
                </div>
              </Space>
            ),
          }}
        />
      )}

      <Modal
        open={target !== null}
        title={target ? `${ACTION_TEXT[target.action].title} ${target.model.model_version}` : ''}
        okText={target ? ACTION_TEXT[target.action].ok : 'Сохранить'}
        okButtonProps={{ danger: target ? ACTION_TEXT[target.action].danger : false }}
        cancelText="Отмена"
        confirmLoading={decide.isPending}
        onCancel={() => setTarget(null)}
        onOk={() => void submit()}
        destroyOnHidden
      >
        {target && <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>{ACTION_TEXT[target.action].hint}</Text>}
        <Form form={form} layout="vertical">
          <Form.Item name="comment" label="Комментарий (обязателен, попадёт в журнал дообучения)" rules={[{ required: true, whitespace: true, message: 'Напишите комментарий' }]}>
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
        {error && (
          <Alert
            type="error"
            showIcon
            message={error.text}
            description={
              error.failed.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {error.failed.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              ) : undefined
            }
          />
        )}
      </Modal>
    </Card>
  );
};
