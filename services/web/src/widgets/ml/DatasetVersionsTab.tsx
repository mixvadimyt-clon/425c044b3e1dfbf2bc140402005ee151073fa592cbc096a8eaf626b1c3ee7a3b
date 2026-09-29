import React from 'react';
import { InfoHint } from '@/widgets/InfoHint';
import { Alert, App, Button, Card, Form, Input, Modal, Space, Table, Typography, theme } from 'antd';
import { DownloadOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { formatDateTime } from '@/api/protocols';
import { QueryErrorAlert } from '@/widgets/QueryErrorAlert';
import { downloadDatasetVersion, suggestNextVersion, useDatasetVersions, useReleaseVersion } from '@/api/ml';
import type { DatasetVersion } from '@/api/ml';
import { DATASET_SPLIT_LABEL } from '@/shared/statuses';
import { withoutLongDash } from '@/shared/text';

const { Text } = Typography;

const splitName = (key: string): string => DATASET_SPLIT_LABEL[key as keyof typeof DATASET_SPLIT_LABEL] ?? key;

/** Версии GOLD-набора: выпуск, выгрузка JSONL, хеши частей (REQ-ML-02, REQ-ML-03). */
export const DatasetVersionsTab: React.FC<{ canAct: boolean }> = ({ canAct }) => {
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const versions = useDatasetVersions();
  const release = useReleaseVersion();
  const [form] = Form.useForm<{ version: string; comment?: string }>();
  const [open, setOpen] = React.useState(false);
  const [releaseError, setReleaseError] = React.useState<string | null>(null);
  const [released, setReleased] = React.useState<DatasetVersion | null>(null);
  const [downloading, setDownloading] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const shown = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return (versions.data ?? []).filter((v) => !q || v.version.toLowerCase().includes(q) || (v.comment ?? '').toLowerCase().includes(q));
  }, [versions.data, query]);

  const openModal = () => {
    setReleaseError(null);
    form.setFieldsValue({ version: suggestNextVersion(versions.data ?? [], new Date()), comment: '' });
    setOpen(true);
  };

  const submit = async () => {
    const values = await form.validateFields();
    setReleaseError(null);
    try {
      const result = await release.mutateAsync({ version: values.version.trim(), comment: values.comment?.trim() });
      setOpen(false);
      setReleased(result);
      message.success(`Версия ${result.version} выпущена`);
    } catch (error) {
      setReleaseError(error instanceof Error ? error.message : 'Не удалось выпустить версию');
    }
  };

  const handleDownload = async (version: string) => {
    setDownloading(version);
    try {
      await downloadDatasetVersion(version);
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось выгрузить версию');
    } finally {
      setDownloading(null);
    }
  };

  const columns = [
    { title: 'Версия', dataIndex: 'version', key: 'version', width: 150, render: (value: string) => <Text strong>{value}</Text> },
    {
      title: 'Всего записей',
      key: 'items',
      width: 230,
      render: (_: unknown, row: DatasetVersion) => (
        <Text style={{ fontSize: 13 }}>
          {row.items_count}
          {row.positives != null && row.negatives != null ? ` (нарушений ${row.positives}, без нарушения ${row.negatives})` : ''}
        </Text>
      ),
    },
    { title: 'Добавлено в этой версии', dataIndex: 'new_items', key: 'new_items', width: 200, className: 'ml-col-gap', render: (value?: number) => value ?? 'нет' },
    {
      title: 'Части',
      key: 'splits',
      width: 190,
      render: (_: unknown, row: DatasetVersion) =>
        row.split_counts && Object.keys(row.split_counts).length > 0 ? (
          <div style={{ fontSize: 13 }}>
            {Object.entries(row.split_counts).map(([key, count]) => (
              <div key={key} style={{ whiteSpace: 'nowrap' }}>
                {splitName(key)}: {count}
              </div>
            ))}
          </div>
        ) : (
          <Text type="secondary">нет</Text>
        ),
    },
    { title: 'Выпущена', dataIndex: 'created_at', key: 'created_at', width: 150, render: (value: string) => <Text style={{ fontSize: 13 }}>{formatDateTime(value)}</Text> },
    { title: 'Комментарий', dataIndex: 'comment', key: 'comment', className: 'col-wrap', render: (value?: string | null) => value || <Text type="secondary">нет</Text> },
    ...(canAct
      ? [
          {
            title: '',
            key: 'actions',
            width: 130,
            render: (_: unknown, row: DatasetVersion) => (
              <Button size="small" icon={<DownloadOutlined />} loading={downloading === row.version} onClick={() => void handleDownload(row.version)}>
                Скачать
              </Button>
            ),
          },
        ]
      : []),
  ];

  return (
    <Card
      style={{ borderRadius: 12, background: token.colorBgContainer, border: `1px solid ${token.colorBorder}` }}
      title={
        <>
          <Text strong style={{ fontSize: 15 }}>Версии набора</Text>
          <InfoHint label="Из чего формируется версия">
            В версию входят записи из таблицы «Решения приняты» на дашборде админа со статусом «Отправлено на дообучение». Записи «Не отправлено» в набор не попадают. Каждая версия накопительная: в неё входит всё, что выпущено раньше, плюс записи, добавленные впервые. «Всего записей» — весь состав версии, «Добавлено в этой версии» — прирост к предыдущей.
          </InfoHint>
        </>
      }
      extra={
        <Space size={12} wrap>
          <Input allowClear value={query} onChange={(e) => setQuery(e.target.value)} prefix={<SearchOutlined />} placeholder="Поиск: версия, комментарий" style={{ width: 260, maxWidth: '100%' }} />
          {canAct && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openModal}>
              Выпустить версию
            </Button>
          )}
        </Space>
      }
    >
      {released && (
        <Alert
          style={{ marginBottom: 12 }}
          type={released.excluded && released.excluded.length > 0 ? 'warning' : 'success'}
          showIcon
          closable
          onClose={() => setReleased(null)}
          message={`Версия ${released.version} выпущена: записей ${released.items_count}, новых ${released.new_items ?? 0}`}
          description={
            released.excluded && released.excluded.length > 0 ? (
              <div>
                <div>Не вошли одобренные записи без полного доказательства ({released.excluded.length}):</div>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {released.excluded.slice(0, 10).map((item) => (
                    <li key={item.item_id}>
                      {item.param_code ?? 'параметр не указан'}: {withoutLongDash(item.reason)}
                    </li>
                  ))}
                  {released.excluded.length > 10 && <li>и ещё {released.excluded.length - 10}</li>}
                </ul>
              </div>
            ) : undefined
          }
        />
      )}

      {versions.isError ? (
        <QueryErrorAlert title="Не удалось загрузить версии набора" error={versions.error} onRetry={() => void versions.refetch()} />
      ) : (
        <Table
          rowKey="version"
          size="middle"
          columns={columns}
          dataSource={shown}
          loading={versions.isLoading}
          scroll={{ x: 900 }}
          pagination={{ showSizeChanger: true, pageSizeOptions: ['10', '20', '50'], hideOnSinglePage: true }}
          locale={{ emptyText: query.trim() ? 'Ничего не найдено' : 'Версий набора ещё не выпускали' }}
          expandable={{
            rowExpandable: (row) => Boolean(row.split_hashes && Object.keys(row.split_hashes).length > 0),
            expandedRowRender: (row) => (
              <Space direction="vertical" size={4}>
                <Text type="secondary" style={{ fontSize: 12 }}>SHA-256 строк каждой части в выгрузке</Text>
                {Object.entries(row.split_hashes ?? {}).map(([key, hash]) => (
                  <Text key={key} style={{ fontSize: 12 }}>
                    {splitName(key)}: <Text code style={{ overflowWrap: 'anywhere' }}>{hash}</Text>
                  </Text>
                ))}
              </Space>
            ),
          }}
        />
      )}

      <Modal
        open={open}
        title="Выпустить версию набора"
        okText="Выпустить"
        cancelText="Отмена"
        confirmLoading={release.isPending}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        destroyOnHidden
      >
        <Text type="secondary" style={{ display: 'block', marginBottom: 12, fontSize: 13 }}>
          В версию войдут все одобренные записи, которых ещё нет в выпущенных версиях, вместе со всем, что выпущено раньше. Если новых одобренных записей нет, версию выпустить нельзя.
        </Text>
        <Form form={form} layout="vertical">
          <Form.Item
            name="version"
            label="Имя версии"
            extra="По образцу ds-2026.09.1: год, месяц и номер за месяц."
            rules={[{ required: true, whitespace: true, message: 'Укажите имя версии' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="comment" label="Комментарий (необязательно)">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
        {releaseError && <Alert type="error" showIcon message={releaseError} />}
      </Modal>
    </Card>
  );
};
