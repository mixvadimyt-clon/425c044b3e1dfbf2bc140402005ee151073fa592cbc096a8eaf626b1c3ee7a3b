import React from 'react';
import { Alert, Button, Card, Input, Segmented, Space, Table, Typography, theme } from 'antd';
import { CloudDownloadOutlined, SearchOutlined } from '@ant-design/icons';
import { highlight } from '@/shared/guide';
import { INTEGRATION_PACKAGE_STATUS } from '@/shared/statuses';
import { TRAINING_PROJECT } from '@/shared/training';
import { StatusPill } from '@/widgets/StatusPill';
import { PageTitle, SceneFrame } from '../guideUi';
import type { SceneProps } from '../guideUi';

const { Text } = Typography;
const SYSTEM = 'ИАИС «РиН»';

const Field: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
      {label}
    </Text>
    <Text style={{ overflowWrap: 'anywhere' }}>{value}</Text>
  </div>
);

type PackageState = 'none' | 'deferred' | 'applied';

/**
 * Интеграция в оформлении настоящей страницы: состояние обмена с внешней системой и таблица пакетов документов.
 * Пакет приходит после «Забрать документы», проверка создаётся кнопкой в его строке. Всё на учебных данных.
 */
export const IntegrationScene: React.FC<SceneProps> = ({ step, act, coach, registerEnter }) => {
  const { token } = theme.useToken();
  const hl = (target: string) => highlight(step, target);
  const [state, setState] = React.useState<PackageState>('none');
  const [filter, setFilter] = React.useState('ALL');

  // Enter делает то, что урок просит сейчас
  React.useEffect(() => {
    registerEnter(() => {
      if (step?.id === 'pull') {
        if (act('pull') && state === 'none') setState('deferred');
      } else if (step?.id === 'create' && act('create')) setState('applied');
    });
    return () => registerEnter(null);
  });
  const cardStyle: React.CSSProperties = { borderRadius: 12, background: token.colorBgContainer, border: `1px solid ${token.colorBorder}` };

  const received = state !== 'none';
  const applied = state === 'applied';
  const counts = { ALL: received ? 1 : 0, DEFERRED: state === 'deferred' ? 1 : 0, FAILED: 0, APPLIED: applied ? 1 : 0 };
  const status = INTEGRATION_PACKAGE_STATUS[applied ? 'APPLIED' : 'DEFERRED'];

  const columns = [
    { title: 'Получен', key: 'received', width: 150, render: () => <Text style={{ fontSize: 13 }}>16.10.2026 12:05</Text> },
    {
      title: 'Пакет',
      key: 'package',
      width: 260,
      render: () => (
        <div>
          <Text strong>Пакет №1: {TRAINING_PROJECT}</Text>
          <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
            {applied ? TRAINING_PROJECT : 'Объект не определён'}
          </Text>
          <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
            Объект в {SYSTEM}: RIN-OBJ-0001
          </Text>
        </div>
      ),
    },
    { title: 'Файлы', key: 'files', width: 130, render: () => <div style={{ fontSize: 13 }}><div>{applied ? '6 из 6' : '6'}</div><div>С реестром</div></div> },
    { title: 'Статус', key: 'status', width: 200, render: () => <StatusPill color={status.color}>{status.label}</StatusPill> },
    { title: 'Сообщение', key: 'message', width: 240, render: () => <Text type="secondary" style={{ fontSize: 13 }}>{applied ? 'Проверка создана, анализ запущен' : 'нет'}</Text> },
    {
      title: '',
      key: 'actions',
      width: 170,
      render: () =>
        applied ? (
          <Button size="small" className={hl('opened')} data-tt="opened" onClick={() => act('other')}>
            Открыть проверку
          </Button>
        ) : (
          <Button
            size="small"
            type="primary"
            className={hl('create')}
            data-tt="create"
            onClick={() => {
              if (act('create')) setState('applied');
            }}
          >
            Создать проверку
          </Button>
        ),
    },
  ];

  return (
    <>
      {coach}
      <SceneFrame height={720}>
        <PageTitle>Интеграция</PageTitle>
        <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Card
              className={hl('exchange')}
              data-tt="exchange"
              style={cardStyle}
              title={<Text strong style={{ fontSize: 15 }}>Обмен с {SYSTEM}</Text>}
              extra={
                <Button
                  type="primary"
                  icon={<CloudDownloadOutlined />}
                  className={hl('pull')}
                  data-tt="pull"
                  onClick={() => {
                    if (act('pull') && state === 'none') setState('deferred');
                  }}
                >
                  Забрать документы
                </Button>
              }
            >
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px 24px' }}>
                <Field label="Адрес" value="http://rin-mock:4020" />
                <Field label="Автозабор документов" value="раз в 5 минут" />
                <Field label="Отправка результатов" value="сразу после финализации" />
                <Field label="Повторы при сбое" value="через 1 мин, 5 мин, 15 мин" />
                <Field label="Последний забор" value={received ? '16.10.2026 12:05' : 'ещё не было'} />
                <div>
                  <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                    Очередь отправки результатов
                  </Text>
                  <Space size={6} wrap style={{ marginTop: 4 }}>
                    <StatusPill tone="warning">Ждут: 0</StatusPill>
                    <StatusPill tone="success">Передано: 0</StatusPill>
                    <StatusPill tone="error">Не передано: 0</StatusPill>
                  </Space>
                </div>
              </div>
            </Card>

            <Card style={cardStyle} title={<Text strong style={{ fontSize: 15 }}>Пакеты документов</Text>}>
              <div className={hl('filters')} data-tt="filters" style={{ marginBottom: 16, padding: 2 }}>
                <Space size={12} wrap>
                  <Input allowClear prefix={<SearchOutlined />} placeholder="Поиск: пакет, проект, сообщение" style={{ width: 260, maxWidth: '100%' }} />
                  <Segmented
                    value={filter}
                    onChange={(value) => setFilter(String(value))}
                    options={[
                      { value: 'ALL', label: `Все (${counts.ALL})` },
                      { value: 'DEFERRED', label: `Ждут решения (${counts.DEFERRED})` },
                      { value: 'FAILED', label: `Не приняты (${counts.FAILED})` },
                      { value: 'APPLIED', label: `Запущены (${counts.APPLIED})` },
                    ]}
                  />
                </Space>
              </div>
              <Table
                rowKey="id"
                size="middle"
                columns={columns}
                dataSource={received && (filter === 'ALL' || (filter === 'DEFERRED' && !applied) || (filter === 'APPLIED' && applied)) ? [{ id: 1 }] : []}
                pagination={false}
                scroll={{ x: 1100 }}
                locale={{ emptyText: received ? 'В этом разделе пакетов нет' : `Пакетов из ${SYSTEM} ещё не было` }}
              />
            </Card>

            {applied && <Alert type="info" showIcon message="Проверка создана: проект появится на дашборде, а разбор документов пойдёт автоматически." />}
          </Space>
        </div>
      </SceneFrame>
    </>
  );
};
