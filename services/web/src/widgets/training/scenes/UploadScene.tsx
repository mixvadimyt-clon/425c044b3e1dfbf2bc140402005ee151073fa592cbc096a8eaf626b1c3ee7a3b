import React from 'react';
import { Button, Card, Input, Progress, Select, Space, Table, Typography, Upload, theme } from 'antd';
import { DeleteOutlined, FolderOpenOutlined, InboxOutlined } from '@ant-design/icons';
import { highlight } from '@/shared/guide';
import { COMPLETENESS_STATUS, PROCESS_STATUS } from '@/shared/statuses';
import { TRAINING_PROJECT, TRAINING_PROJECT_ROW } from '@/shared/training';
import { StatusPill } from '@/widgets/StatusPill';
import { TableEmpty } from '@/widgets/TableEmpty';
import { PageTitle, SceneFrame } from '../guideUi';
import type { SceneProps } from '../guideUi';

const { Text } = Typography;
const { Dragger } = Upload;

const FILES = [
  { name: '2026-СК2-П-ПЗ.pdf', pages: 2, stage: 'ПД' },
  { name: '2026-СК2-П-КР.pdf', pages: 2, stage: 'ПД' },
  { name: '2026-СК2-РД-АР.pdf', pages: 1, stage: 'РД' },
  { name: '2026-СК2-РД-КЖ.pdf', pages: 1, stage: 'РД' },
  { name: 'АОСР №14 от 14.05.2026.pdf', pages: 1, stage: 'ИД' },
  { name: 'АОСР №27 от 18.06.2026.pdf', pages: 1, stage: 'ИД' },
].map((f, i) => ({ ...f, key: i }));

const fieldLabel = (text: string, gap = 8) => (
  <Text strong style={{ display: 'block', marginBottom: gap, fontSize: 15 }}>
    {text}
  </Text>
);

type Phase = 'empty' | 'new' | 'staged' | 'sent';

/**
 * Загрузка в оформлении настоящей страницы: выбор проекта, реквизиты, область загрузки, реестр, список документов
 * и состояние проверки. Файлы никуда не уходят: список заполняется учебным комплектом.
 */
export const UploadScene: React.FC<SceneProps> = ({ step, act, coach, registerEnter }) => {
  const { token } = theme.useToken();
  const hl = (target: string) => highlight(step, target);
  const [phase, setPhase] = React.useState<Phase>('empty');
  const [percent, setPercent] = React.useState(0);

  // Enter делает то, что урок просит сейчас
  React.useEffect(() => {
    registerEnter(() => {
      if (step?.id === 'project' && act('new-project')) setPhase('new');
      else if (step?.id === 'drop' && act('drop')) setPhase('staged');
      else if (step?.id === 'send' && act('send')) setPhase('sent');
    });
    return () => registerEnter(null);
  });

  // Разбор «идёт» несколько секунд, как в настоящей проверке
  React.useEffect(() => {
    if (phase !== 'sent') return;
    const timer = window.setInterval(() => setPercent((p) => Math.min(100, p + 10)), 200);
    return () => window.clearInterval(timer);
  }, [phase]);

  const staged = phase === 'staged';
  const sent = phase === 'sent';
  const parsed = sent && percent >= 100;
  const processStatus = PROCESS_STATUS[parsed ? 'READY' : 'PARSING'];
  const project = TRAINING_PROJECT_ROW;

  const detailFields: Array<[string, string]> = [
    ['Название проекта', TRAINING_PROJECT],
    ['Адрес', project.address],
    ['Застройщик', project.developer],
    ['Подрядчик', project.contractor],
    ['№ разрешения на строительство', project.permit],
  ];

  const columns = [
    {
      title: <Text strong style={{ fontSize: 15 }}>Файл</Text>,
      dataIndex: 'name',
      key: 'name',
    },
    { title: <Text strong style={{ fontSize: 15 }}>Страниц</Text>, dataIndex: 'pages', key: 'pages', width: 104, render: (v: number) => (sent ? v : <Text type="secondary">нет</Text>) },
    { title: <Text strong style={{ fontSize: 15 }}>Стадия</Text>, dataIndex: 'stage', key: 'stage', width: 190, render: (v: string) => (sent ? <Text style={{ fontSize: 14 }}>{v}</Text> : <Text type="secondary">определит система</Text>) },
    {
      title: <Text strong style={{ fontSize: 15 }}>Статус</Text>,
      key: 'status',
      width: 170,
      render: () =>
        sent ? (
          <StatusPill color={parsed ? 'success' : 'processing'}>{parsed ? 'Обработан' : 'Обработка'}</StatusPill>
        ) : (
          <Button type="text" size="small" className="negative-action" icon={<DeleteOutlined />} onClick={() => act('other')}>
            Убрать
          </Button>
        ),
    },
  ];

  return (
    <>
      {coach}
      <SceneFrame height={780}>
        <PageTitle>Загрузка документов</PageTitle>
        <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
          <div style={{ maxWidth: 900, margin: '0 auto' }}>
            <Card style={{ borderRadius: 12, background: token.colorBgContainer, border: `1px solid ${token.colorBorder}` }}>
              <Space direction="vertical" size={24} style={{ width: '100%' }}>
                <div className={hl('project')} data-tt="project" style={{ padding: 2 }}>
                  {fieldLabel('Проект')}
                  <Select
                    placeholder="Выберите проект или создайте новый"
                    value={phase === 'empty' ? undefined : 'new'}
                    onChange={(value) => {
                      if (value === 'new' && act('new-project')) setPhase('new');
                    }}
                    showSearch
                    optionFilterProp="label"
                    notFoundContent="Проектов с таким названием нет"
                    options={[{ value: 'new', label: '+ Добавить новый проект' }]}
                    style={{ width: '100%' }}
                    size="large"
                  />
                </div>

                {phase !== 'empty' && (
                  <>
                    <Space direction="vertical" size={24} style={{ width: '100%', padding: 2 }} className={hl('details')} data-tt="details">
                      {detailFields.map(([label, value]) => (
                        <div key={label}>
                          {fieldLabel(label)}
                          <Input value={value} readOnly size="large" />
                        </div>
                      ))}
                    </Space>

                    {sent && (
                      <div className={hl('status')} data-tt="status" style={{ padding: 2 }}>
                        {fieldLabel('Состояние проверки')}
                        <Space direction="vertical" size={8} style={{ width: '100%' }}>
                          <Space size={12} wrap>
                            <StatusPill color={processStatus.color}>{processStatus.label}</StatusPill>
                            <StatusPill color={COMPLETENESS_STATUS.COMPLETE.color}>Комплект: полный</StatusPill>
                            <Text type="secondary">Разобрано файлов: {Math.round((percent / 100) * FILES.length)} из {FILES.length}</Text>
                          </Space>
                          {!parsed && <Progress percent={percent} status="active" strokeColor={token.colorPrimary} />}
                        </Space>
                      </div>
                    )}

                    <div>
                      {fieldLabel('Загрузка документов', 16)}
                      <Space direction="vertical" size={16} style={{ width: '100%' }}>
                        <div
                          className={hl('drop')}
                          data-tt="drop"
                          style={{ padding: 2 }}
                          onClick={(e) => {
                            e.preventDefault();
                            if (phase === 'new' && act('drop')) setPhase('staged');
                            else if (phase !== 'new') act('other');
                          }}
                        >
                          <Dragger openFileDialogOnClick={false} showUploadList={false} beforeUpload={() => false} style={{ background: token.colorBgContainer }}>
                            <p className="ant-upload-drag-icon">
                              <InboxOutlined style={{ color: token.colorPrimary, fontSize: 48 }} />
                            </p>
                            <Text strong style={{ fontSize: 16, display: 'block', marginBottom: 8 }}>
                              Нажмите или перетащите файлы
                            </Text>
                            <Text type="secondary" style={{ fontSize: 14 }}>
                              PDF, DOCX, XML: до 50 МБ на файл и 200 МБ на пакет. Можно выбрать несколько файлов, папку или архив ZIP (до 200 МБ): система раскроет его сама.
                            </Text>
                          </Dragger>
                        </div>
                        <Button icon={<FolderOpenOutlined />} onClick={() => act('other')}>
                          Выбрать папку
                        </Button>
                        <div className={hl('registry')} data-tt="registry" style={{ padding: 2 }}>
                          {fieldLabel('Реестр файлов комплекта (CSV, XLSX или JSON)', 8)}
                          <Button onClick={() => act('other')}>Выбрать реестр</Button>
                          <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 13 }}>
                            Без реестра комплект будет принят со статусом «Требует уточнения».
                          </Text>
                        </div>
                      </Space>
                    </div>

                    <div className={hl('files')} data-tt="files" style={{ padding: 2 }}>
                      {fieldLabel('Документы проверки', 12)}
                      <Table
                        dataSource={staged || sent ? FILES : []}
                        columns={columns}
                        pagination={false}
                        size="middle"
                        tableLayout="fixed"
                        scroll={{ x: 740 }}
                        style={{ marginBottom: 16 }}
                        locale={{ emptyText: <TableEmpty hint="Перетащите файлы, папку или архив в область загрузки выше: стадию документа система определит сама.">Нет загруженных документов</TableEmpty> }}
                      />
                      <Space direction="vertical" size={12} style={{ width: '100%' }}>
                        <Button
                          type="primary"
                          size="large"
                          block
                          className={hl('send')}
                          data-tt="send"
                          disabled={!staged && !sent}
                          onClick={() => {
                            if (staged && act('send')) setPhase('sent');
                          }}
                        >
                          {sent ? 'Дозагрузить и обновить проверку' : 'Добавить проект и отправить на проверку'}
                        </Button>
                        {parsed && (
                          <Button size="large" block onClick={() => act('other')}>
                            Перейти к верификации
                          </Button>
                        )}
                      </Space>
                    </div>
                  </>
                )}
              </Space>
            </Card>
          </div>
        </div>
      </SceneFrame>
    </>
  );
};
