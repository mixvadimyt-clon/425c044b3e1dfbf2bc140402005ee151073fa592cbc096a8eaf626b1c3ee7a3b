import React from 'react';
import { Alert, Button, Card, Col, Dropdown, Progress, Row, Select, Space, Table, Tooltip, Typography, theme } from 'antd';
import {
  AppstoreAddOutlined,
  BulbOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  DownloadOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  FileWordOutlined,
} from '@ant-design/icons';
import '@/pages/ProtocolPage.css';
import { highlight } from '@/shared/guide';
import { COMPLETENESS_STATUS, PROCESS_STATUS, STAGE_UPLOAD_STATUS } from '@/shared/statuses';
import { TRAINING_PROJECT, TRAINING_PROJECT_ROW } from '@/shared/training';
import { InfoHint } from '@/widgets/InfoHint';
import { StatusPill } from '@/widgets/StatusPill';
import { PageTitle, SceneFrame } from '../guideUi';
import type { SceneProps } from '../guideUi';

const { Text } = Typography;
const TEAL = '#12988C';

interface Props extends SceneProps {
  /** `protocol` — инспектор завершает проверку; `rollback` — руководитель разбирает запрос на откат. */
  variant: 'protocol' | 'rollback';
}

const FILES = [
  { fileName: '2026-СК2-П-ПЗ.pdf', stage: 'ПД', cipher: '2026-СК2-П-ПЗ', revision: '0', pages: 2 },
  { fileName: '2026-СК2-П-КР.pdf', stage: 'ПД', cipher: '2026-СК2-П-КР', revision: '0', pages: 2 },
  { fileName: '2026-СК2-РД-АР.pdf', stage: 'РД', cipher: '2026-СК2-РД-АР', revision: '0', pages: 1 },
  { fileName: '2026-СК2-РД-КЖ.pdf', stage: 'РД', cipher: '2026-СК2-РД-КЖ', revision: '0', pages: 1 },
  { fileName: 'АОСР №14 от 14.05.2026.pdf', stage: 'ИД', cipher: 'АОСР-14', revision: '', pages: 1 },
  { fileName: 'АОСР №27 от 18.06.2026.pdf', stage: 'ИД', cipher: 'АОСР-27', revision: '', pages: 1 },
].map((f, i) => ({ ...f, key: i }));
const STAGE_COLORS: Record<string, string> = { ПД: '#2450C7', РД: '#B4620B', ИД: '#5B4FBE' };

const SECTIONS = [
  {
    key: 'completeness',
    title: '(1) Комплектность и сопоставимость',
    hint: 'Не нарушения: чего не хватает или что нельзя сопоставить. Вывод о нарушении по этим параметрам не делается.',
    empty: 'Записей нет',
    rows: [{ code: 'M-055', name: 'Класс прочности бетона, фундаментная плита', values: 'ПД: B30, РД: B25, ИД: B25', decision: 'Запрошено уточнение' }],
  },
  {
    key: 'candidates',
    title: '(2) Предварительные кандидаты',
    hint: 'Расхождения, найденные системой. Решение принимает инспектор в верификации.',
    empty: 'Необработанных кандидатов нет',
    rows: [] as Array<{ code: string; name: string; values: string; decision: string }>,
  },
  {
    key: 'confirmed',
    title: '(3) Подтверждённые нарушения',
    hint: 'Решение принял инспектор, у каждой записи полная карточка доказательства.',
    empty: 'Подтверждённых нарушений нет',
    rows: [{ code: 'M-002', name: 'Общая площадь здания', values: 'ПД: 12 480,6, РД: 11 905,3', decision: 'Нарушение подтверждено' }],
  },
  {
    key: 'negative',
    title: '(4) Проверенные отрицательные',
    hint: 'Кандидаты, отклонённые инспектором с причиной. Они пополняют набор для дообучения.',
    empty: 'Отклонённых кандидатов нет',
    rows: [{ code: 'M-055', name: 'Класс прочности бетона, плиты перекрытия', values: 'ПД: B25, РД: B30, ИД: B22,5', decision: 'Отклонено: неверная редакция' }],
  },
  {
    key: 'suspicions',
    title: '(5) Гипотезы свободного поиска',
    hint: 'Подозрения вне матрицы. Это не нарушения, пока инспектор не сделает их кандидатами.',
    empty: 'Гипотез нет',
    rows: [] as Array<{ code: string; name: string; values: string; decision: string }>,
  },
];


/**
 * Протокол в оформлении настоящей страницы: сведения о проверке, готовность, сводка, статус загрузки и реестр файлов.
 * Данные учебные. У руководителя вместо завершения проверки разбирается запрос инспектора на откат.
 */
export const ProtocolScene: React.FC<Props> = ({ step, act, coach, variant, registerEnter }) => {
  const { token } = theme.useToken();
  const hl = (target: string) => highlight(step, target);
  const [formatsOpen, setFormatsOpen] = React.useState(false);
  const [finalized, setFinalized] = React.useState(variant === 'rollback');
  const [note, setNote] = React.useState('');

  // Список форматов не остаётся открытым после шага со скачиванием
  React.useEffect(() => {
    if (step?.id !== 'download') setFormatsOpen(false);
  }, [step?.id]);

  // Enter делает то, что урок просит сейчас
  React.useEffect(() => {
    registerEnter(() => {
      if (step?.id === 'finish' && act('finish')) setFinalized(true);
    });
    return () => registerEnter(null);
  });
  const status = PROCESS_STATUS[finalized ? 'FINALIZED' : 'READY'];
  const project = TRAINING_PROJECT_ROW;

  const vars = { '--pr-teal': TEAL, '--pr-border': token.colorBorder, '--pr-muted': token.colorTextSecondary } as React.CSSProperties;
  const cardStyle: React.CSSProperties = { borderRadius: 12, background: token.colorBgContainer, border: `1px solid ${token.colorBorder}`, marginBottom: 24 };
  const th = (title: string) => (
    <Text strong style={{ fontSize: 14 }}>
      {title}
    </Text>
  );
  const fact = (label: string, value: React.ReactNode) => (
    <div>
      <b>{label}</b>
      {value}
    </div>
  );

  const exportMenu = [
    { key: 'pdf', icon: <FilePdfOutlined />, label: 'PDF' },
    { key: 'docx', icon: <FileWordOutlined />, label: 'DOCX' },
    { key: 'xml', icon: <FileTextOutlined />, label: 'XML' },
    { key: 'json', icon: <FileTextOutlined />, label: 'JSON' },
  ];

  const stats = [
    { title: 'Комплектность', value: 1, icon: <AppstoreAddOutlined style={{ fontSize: 28, color: token.colorWarning }} /> },
    { title: 'Кандидаты', value: 0, icon: <ClockCircleOutlined style={{ fontSize: 28, color: TEAL }} /> },
    { title: 'Подтверждено', value: 1, icon: <CloseCircleOutlined style={{ fontSize: 28, color: token.colorError }} /> },
    { title: 'Отрицательные', value: 1, icon: <CheckCircleOutlined style={{ fontSize: 28, color: token.colorSuccess }} /> },
    { title: 'Гипотезы', value: 0, icon: <BulbOutlined style={{ fontSize: 28, color: token.colorTextSecondary }} /> },
  ];

  return (
    <>
      {coach}
      <SceneFrame height={780}>
        <div className="pr-root" style={vars}>
          <PageTitle>Протокол проекта «{TRAINING_PROJECT}»</PageTitle>
          <div className="pr-body">
            {variant === 'rollback' && (
              <Card
                className={hl('where')}
                data-tt="where"
                style={cardStyle}
                title={<Text strong style={{ fontSize: 17 }}>Запросы на откат финализации (блок на дашборде)</Text>}
              >
                <Table
                  size="small"
                  pagination={false}
                  scroll={{ x: 560 }}
                  rowKey="project"
                  dataSource={[{ project: TRAINING_PROJECT, inspector: 'Иванов Иван (инспектор)', reason: 'Ошибся в решении по плитам перекрытия' }]}
                  columns={[
                    { title: th('Проект'), dataIndex: 'project', key: 'project' },
                    { title: th('Инспектор'), dataIndex: 'inspector', key: 'inspector' },
                    { title: th('Причина'), dataIndex: 'reason', key: 'reason' },
                    {
                      title: '',
                      key: 'open',
                      render: () => (
                        <Button size="small" onClick={() => act('other')}>
                          Протокол
                        </Button>
                      ),
                    },
                  ]}
                />
              </Card>
            )}
            <Card
              style={cardStyle}
              title={
                <div className={`pr-title-row ${hl('head')}`} data-tt="head">
                  <Text strong style={{ fontSize: 17 }}>
                    Протокол проверки № training, версия 1
                  </Text>
                  <div className="pr-actions">
                    <Select value="v1" style={{ minWidth: 250 }} options={[{ value: 'v1', label: 'Версия 1 (16.10.2026 12:00, текущая)' }]} />
                    {variant === 'protocol' && <Button type="primary" onClick={() => act('other')}>Верификация</Button>}
                    <Dropdown
                      menu={{ items: exportMenu, onClick: () => setFormatsOpen(false) }}
                      placement="bottomRight"
                      open={formatsOpen}
                      onOpenChange={(open) => {
                        if (!open) setFormatsOpen(false);
                      }}
                    >
                      <Button
                        icon={<DownloadOutlined />}
                        className={hl('download')}
                        data-tt="download"
                        onClick={() => {
                          if (act('download')) setFormatsOpen(true);
                        }}
                      >
                        Скачать
                      </Button>
                    </Dropdown>
                    {variant === 'protocol' && !finalized && (
                      <Tooltip title="">
                        <span>
                          <Button
                            type="primary"
                            className={hl('finish')}
                            data-tt="finish"
                            onClick={() => {
                              if (act('finish')) setFinalized(true);
                            }}
                          >
                            Завершить проверку
                          </Button>
                        </span>
                      </Tooltip>
                    )}
                    {variant === 'protocol' && finalized && (
                      <Button
                        danger
                        className={hl('rollback')}
                        data-tt="rollback"
                        onClick={() => {
                          if (act('rollback')) setNote('Запрос на откат отправлен: руководитель увидит причину в уведомлении и вернёт проект в работу или откажет.');
                        }}
                      >
                        Попросить откат
                      </Button>
                    )}
                    {variant === 'rollback' && (
                      <Button
                        danger
                        className={hl('cancel-final')}
                        data-tt="cancel-final"
                        onClick={() => {
                          if (act('cancel-final')) setNote('Причина обязательна и попадёт в журнал аудита. После отмены проект вернётся инспектору в работу.');
                        }}
                      >
                        Отменить финализацию
                      </Button>
                    )}
                  </div>
                </div>
              }
            >
              <div className={`pr-facts ${hl('facts')}`} data-tt="facts">
                {fact('Проект', project.name)}
                {fact('Адрес', project.address)}
                {fact('Застройщик', project.developer)}
                {fact('Подрядчик', project.contractor)}
                {fact('№ разрешения', project.permit)}
                {fact('Инспектор', 'Иванов Иван (инспектор)')}
                {fact('Создан', '16.10.2026 12:00')}
                {fact('Статус проверки', <StatusPill color={status.color}>{status.label}</StatusPill>)}
                {fact('Версия матрицы', <code>m-0.401</code>)}
                {fact('Версия модели', <code>scorer-2026.09.4</code>)}
                {fact('Версия датасета', <code>none</code>)}
                {fact(
                  'Хеш манифеста',
                  <Text code copyable={{ text: 'a1b2c3d4e5f60718' }} style={{ fontSize: 12 }}>
                    a1b2c3d4e5f60718…
                  </Text>,
                )}
              </div>
            </Card>

            {note && <Alert type="info" showIcon style={{ marginBottom: 24 }} message={note} />}

            {finalized && <Alert className={hl('rin')} data-tt="rin" type="success" showIcon style={{ marginBottom: 24 }} message="Передано в ИАИС «РиН», квитанция RIN-2026-00001" />}

            {variant === 'rollback' && (
              <Alert
                className={hl('request')}
                data-tt="request"
                type="warning"
                showIcon
                style={{ marginBottom: 16 }}
                message="Иванов Иван (инспектор) просит откатить финализацию"
                description={
                  <>
                    <div>Ошибся с классом бетона на колоннах, нужно пересмотреть решение.</div>
                    <Text type="secondary">Запрос от 16.10.2026 12:30. Откат финализации закроет запрос сам.</Text>
                  </>
                }
                action={
                  <Button
                    className={`negative-action ${hl('reject-request')}`}
                    data-tt="reject-request"
                    size="small"
                    onClick={() => {
                      if (act('reject-request')) setNote('Причина отказа сохранится в запросе, финализация останется в силе.');
                    }}
                  >
                    Отклонить запрос
                  </Button>
                }
              />
            )}

            {variant === 'protocol' && !finalized && (
              <Alert
                className={hl('readiness')}
                data-tt="readiness"
                style={{ marginBottom: 24 }}
                showIcon
                type="success"
                message="Все решения приняты: проверку можно завершить"
                description="После завершения дозагрузка и смена решений станут недоступны, результат уйдёт в ИАИС «РиН»."
              />
            )}

            <div className={hl('tiles')} data-tt="tiles" style={{ overflow: 'hidden', marginBottom: 24, borderRadius: 8, padding: 8 }}>
            <Row gutter={[24, 24]}>
              <Col xs={24} sm={12} xl={{ flex: '1 1 0' }}>
                <Card style={{ ...cardStyle, marginBottom: 0, height: '100%' }}>
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    <CheckCircleOutlined style={{ fontSize: 28, color: token.colorWarning }} />
                    <div style={{ fontSize: 40, fontWeight: 600, lineHeight: 1.2 }}>57.1%</div>
                    <Progress percent={57.1} showInfo={false} size="small" strokeColor={token.colorWarning} />
                    <Text type="secondary" style={{ fontSize: 14 }}>
                      Соответствие
                    </Text>
                  </Space>
                </Card>
              </Col>
              {stats.map((item) => (
                <Col xs={24} sm={12} xl={{ flex: '1 1 0' }} key={item.title}>
                  <Card hoverable style={{ ...cardStyle, marginBottom: 0, height: '100%' }}>
                    <Space direction="vertical" size={8} style={{ width: '100%' }}>
                      {item.icon}
                      <div style={{ fontSize: 40, fontWeight: 600, lineHeight: 1.2 }}>{item.value}</div>
                      <Text type="secondary" style={{ fontSize: 14 }}>
                        {item.title}
                      </Text>
                    </Space>
                  </Card>
                </Col>
              ))}
            </Row>
            </div>

            <Card className={hl('status')} data-tt="status" style={cardStyle} title={<Text strong style={{ fontSize: 17 }}>Статус загрузки документов и тип проверки</Text>}>
              <Space size={[32, 12]} wrap>
                <Space size={8} wrap>
                  <Text type="secondary">Статус загрузки</Text>
                  {(['PD_UPLOADED', 'RD_UPLOADED', 'ID_UPLOADED'] as const).map((key) => (
                    <StatusPill key={key} color={STAGE_UPLOAD_STATUS[key].color}>
                      {STAGE_UPLOAD_STATUS[key].label}
                    </StatusPill>
                  ))}
                </Space>
                <Space size={8}>
                  <Text type="secondary">Тип проверки</Text>
                  <StatusPill tone="default">Полный комплект (ПД + РД + ИД)</StatusPill>
                </Space>
                <Space size={8}>
                  <Text type="secondary">Комплектность</Text>
                  <StatusPill color={COMPLETENESS_STATUS.COMPLETE.color}>{COMPLETENESS_STATUS.COMPLETE.label}</StatusPill>
                </Space>
              </Space>
            </Card>

            <Card className={hl('registry')} data-tt="registry" style={cardStyle} title={<Text strong style={{ fontSize: 17 }}>Реестр входных файлов</Text>}>
              <Table
                rowKey="key"
                size="small"
                pagination={false}
                scroll={{ x: 560 }}
                dataSource={FILES}
                columns={[
                  { title: th('Файл'), dataIndex: 'fileName', key: 'file' },
                  {
                    title: th('Стадия'),
                    dataIndex: 'stage',
                    key: 'stage',
                    render: (v: string) => (
                      <span className="pr-stage" style={{ background: STAGE_COLORS[v] }}>
                        {v}
                      </span>
                    ),
                  },
                  { title: th('Шифр'), dataIndex: 'cipher', key: 'cipher', render: (v: string) => v },
                  { title: th('Редакция'), dataIndex: 'revision', key: 'revision', render: (v: string) => v },
                  { title: th('Страниц прочитано'), dataIndex: 'pages', key: 'pages' },
                ]}
              />
            </Card>

            {SECTIONS.map((section) => (
              <Card
                key={section.key}
                className={hl(`sec-${section.key}`)}
                data-tt={`sec-${section.key}`}
                style={cardStyle}
                title={
                  <div className="pr-title-row" style={{ justifyContent: 'flex-start' }}>
                    <Text strong style={{ fontSize: 17 }}>
                      {section.title}
                    </Text>
                    <StatusPill tone="default">{section.rows.length}</StatusPill>
                    <InfoHint label={`Пояснение: ${section.title}`}>{section.hint}</InfoHint>
                  </div>
                }
              >
                <Table
                  rowKey="code"
                  size="small"
                  pagination={false}
                  scroll={{ x: 560 }}
                  dataSource={section.rows}
                  locale={{ emptyText: section.empty }}
                  columns={[
                    { title: th('Параметр'), dataIndex: 'code', key: 'code', render: (v: string) => <span className="pr-code">{v}</span> },
                    { title: th('Название'), dataIndex: 'name', key: 'name' },
                    { title: th('Значения'), dataIndex: 'values', key: 'values' },
                    { title: th('Решение'), dataIndex: 'decision', key: 'decision' },
                  ]}
                />
              </Card>
            ))}

            <div className={hl('tail')} data-tt="tail" style={{ borderRadius: 8, padding: 8, marginBottom: 24 }}>
              <Card style={cardStyle} title={<Text strong style={{ fontSize: 17 }}>Что нужно запросить или дозагрузить</Text>}>
                <div className="pr-request">
                  <div className="pr-request-text">
                    <Space size={8} wrap>
                      <span className="pr-code">M-055</span>
                      <span className="pr-stage" style={{ background: STAGE_COLORS['ИД'] }}>
                        ИД
                      </span>
                      <StatusPill tone="warning">Требуется уточнение</StatusPill>
                    </Space>
                    <div style={{ marginTop: 6 }}>Уточните, какая редакция проекта действует: в ПД фундаментная плита B30, а в РД и в АОСР №14 B25.</div>
                  </div>
                  <Button size="small" type="primary" onClick={() => act('other')}>
                    Дозагрузить
                  </Button>
                </div>
              </Card>
              <Card style={{ ...cardStyle, marginBottom: 0 }} title={<Text strong style={{ fontSize: 17 }}>Подпись инспектора</Text>}>
                <div className="pr-sign">
                  <div>
                    <b style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--pr-muted)', display: 'block' }}>Инспектор</b>
                    Иванов Иван (инспектор)
                  </div>
                  <div>
                    <b style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--pr-muted)', display: 'block' }}>Подпись</b>
                    <div className="pr-sign-line" />
                  </div>
                  <div>
                    <b style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--pr-muted)', display: 'block' }}>Дата</b>
                    <div className="pr-sign-line" style={{ minWidth: 140 }} />
                  </div>
                </div>
              </Card>
            </div>
          </div>
        </div>
      </SceneFrame>
    </>
  );
};
