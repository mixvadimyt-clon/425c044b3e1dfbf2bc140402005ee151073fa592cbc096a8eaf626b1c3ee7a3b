import React from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Dropdown,
  Input,
  Modal,
  Progress,
  Row,
  Select,
  Space,
  Table,
  Tooltip,
  Typography,
  App,
  theme,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
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
  SearchOutlined,
} from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/app/providers/useAuth';
import { useProjects } from '@/app/providers/useProjects';
import { ProjectNotSelected } from '@/widgets/ProjectNotSelected';
import { StatusPill } from '@/widgets/StatusPill';
import {
  APPROVAL_STATUS,
  CHECK_PRIORITY,
  COMPLETENESS_STATUS,
  FINDING_STATUS,
  PROCESS_STATUS,
  REJECT_REASON,
  STAGE_UPLOAD_STATUS,
} from '@/shared/statuses';
import { useProcess, useProcessStatus } from '@/api/processes';
import { useProtocolFindings } from '@/api/findings';
import { useSuspicions } from '@/api/suspicions';
import { RequestExistsError, rejectUnfinalizeRequest, requestUnfinalize, useUnfinalizeRequests } from '@/api/unfinalizeRequests';
import {
  downloadProtocol,
  finalizeProcess,
  formatDateTime,
  retrySync,
  toProtocolVersion,
  unfinalizeProcess,
  useProtocol,
  useProtocolVersions,
  useSyncInfo,
} from '@/api/protocols';
import type { ExportFormat } from '@/api/protocols';
import { pageLabel } from '@/shared/text';
import { EvidenceCardDrawer } from './protocol/EvidenceCardDrawer';
import { INSPECTOR_NAME, PROCESS_ID, PROTOCOL_VERSIONS, SCENARIO_LABEL } from './protocol/protocolData';
import type { ProtocolFinding, ProtocolVersion, Suspicion } from './protocol/protocolData';
import { TableEmpty } from '@/widgets/TableEmpty';
import { InfoHint } from '@/widgets/InfoHint';
import './ProtocolPage.css';

const { Title, Text } = Typography;
const { TextArea } = Input;

const TEAL = '#12988C';

const STAGE_COLORS: Record<string, string> = {
  'ПД': '#2450C7',
  'РД': '#B4620B',
  'ИД': '#5B4FBE',
};

// Название внешней ИС приходит из api (`external_system`), здесь — значение для макета
const EXTERNAL_SYSTEM = 'ИАИС «РиН»';

type SectionKey = 'completeness' | 'candidates' | 'confirmed' | 'negative' | 'suspicions';

const COMPLETENESS_STATUSES = ['MISSING_EVIDENCE', 'NOT_APPLICABLE', 'NOT_COMPARABLE', 'CLARIFICATION_REQUIRED'];

const pluralize = (n: number) => {
  const word =
    n % 10 === 1 && n % 100 !== 11
      ? 'запись'
      : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)
        ? 'записи'
        : 'записей';
  return `${n} ${word}`;
};

const StageChip: React.FC<{ stage: string }> = ({ stage }) => (
  <span className="pr-stage" style={{ background: STAGE_COLORS[stage] }}>
    {stage}
  </span>
);

const th = (title: string) => (
  <Text strong style={{ fontSize: 14 }}>
    {title}
  </Text>
);

const matches = (query: string, parts: Array<string | undefined>) =>
  !query || parts.filter(Boolean).join(' ').toLowerCase().includes(query);

export const ProtocolPage: React.FC = () => {
  const { message, modal } = App.useApp();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { projects, source: dataSource, isLoading: projectsLoading } = useProjects();
  const { token } = theme.useToken();
  const queryClient = useQueryClient();
  const { projectId } = useParams<{ projectId?: string }>();
  // Прямая ссылка `/projects/:projectId/protocol` (router.tsx) даёт id параметром маршрута, а не строкой запроса
  const objectId = projectId ?? searchParams.get('object');
  const apiMode = dataSource === 'api';

  // Версия протокола: у демо-версий её номер, у версий из api — id протокола; пусто — текущая
  const [versionKey, setVersionKey] = React.useState<string | undefined>(undefined);
  const [query, setQuery] = React.useState('');
  const [sectionFilter, setSectionFilter] = React.useState<string | undefined>(undefined);
  const [cardFinding, setCardFinding] = React.useState<ProtocolFinding | null>(null);
  const [finalized, setFinalized] = React.useState(false);
  const [registryQuery, setRegistryQuery] = React.useState('');
  const [unfinalizeOpen, setUnfinalizeOpen] = React.useState(false);
  const [unfinalizeReason, setUnfinalizeReason] = React.useState('');
  const [working, setWorking] = React.useState(false);
  // Инспектор просит откат, администратор и руководитель могут отклонить открытый запрос
  const [requestOpen, setRequestOpen] = React.useState(false);
  const [requestReason, setRequestReason] = React.useState('');
  const [requestSentFor, setRequestSentFor] = React.useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = React.useState(false);
  const [rejectReason, setRejectReason] = React.useState('');
  const bodyRef = React.useRef<HTMLDivElement>(null);

  const project = projects.find((p) => p.id === objectId);
  const processId = apiMode ? project?.processId : null;
  const statusQ = useProcessStatus(processId);
  const suspicionsQ = useSuspicions(processId);
  const openSuspicions = (suspicionsQ.data ?? []).filter((s) => s.inspector_status === 'PENDING' || s.inspector_status === 'CLARIFICATION_REQUIRED').length;
  const refreshKey = statusQ.data?.updated_at;
  const processQ = useProcess(processId, refreshKey);
  const versionsQ = useProtocolVersions(processId, refreshKey);
  const currentProtocolId = statusQ.data?.current_protocol_id ?? undefined;
  const activeProtocolId = apiMode ? (versionKey ?? currentProtocolId) : undefined;
  const protocolQ = useProtocol(activeProtocolId, refreshKey);
  const findingsQ = useProtocolFindings(activeProtocolId);
  const finalizedInApi = statusQ.data?.status === 'FINALIZED';
  const syncQ = useSyncInfo(processId, finalizedInApi);
  const requestsQ = useUnfinalizeRequests(apiMode && finalizedInApi && (user?.role === 'ADMIN' || user?.role === 'SUPERVISOR'));

  if (!objectId) {
    return <ProjectNotSelected context="protocol" />;
  }

  const pageTitle = (
    <div style={{ padding: '16px 24px', background: token.colorBgContainer, borderBottom: `1px solid ${token.colorBorder}` }}>
      <Title level={2} style={{ margin: 0 }}>
        Протокол проекта «{project?.name ?? (projectsLoading ? '…' : 'без названия')}»
      </Title>
    </div>
  );

  // Список проектов ещё грузится: без него не известен процесс, и страница успела бы сказать «Протокола пока нет»
  if (apiMode && projectsLoading && !project) {
    return (
      <div className="pr-root" style={{ height: 'auto' }}>
        {pageTitle}
        <div className="pr-body">
          <Text type="secondary">Загрузка проекта…</Text>
        </div>
      </div>
    );
  }

  // Администратор работает только с финализированными проектами: их протоколы он может откатить
  const isAdmin = apiMode && user?.role === 'ADMIN';
  if (isAdmin && project && !project.finalized) {
    return (
      <div className="pr-root" style={{ height: 'auto' }}>
        {pageTitle}
        <div className="pr-body" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: 36, textAlign: 'center', color: '#94A0B2' }}>
          <div style={{ fontWeight: 700, fontSize: '13.5px' }}>Проект не финализирован</div>
          <div style={{ fontSize: 14, color: '#667085', maxWidth: 460, lineHeight: 1.6 }}>
            Администратор работает с протоколами финализированных проектов. Откатить финализацию можно после того, как инспектор завершит проверку.
          </div>
          <Button size="large" onClick={() => navigate('/dashboard')}>
            К дашборду
          </Button>
        </div>
      </div>
    );
  }

  if (apiMode && !activeProtocolId && !statusQ.isLoading) {
    return (
      <div className="pr-root" style={{ height: 'auto' }}>
        {pageTitle}
        <div className="pr-body">
          <Alert
            type="info"
            showIcon
            message="Протокола пока нет"
            description="Загрузите документы проекта. Когда разбор закончится, здесь появится протокол проверки."
            action={<Button type="primary" onClick={() => navigate(`/upload?object=${objectId}&focus=upload`)}>Загрузить</Button>}
          />
        </div>
      </div>
    );
  }

  if (apiMode && (!protocolQ.data || !findingsQ.data)) {
    return (
      <div className="pr-root" style={{ height: 'auto' }}>
        {pageTitle}
        <div className="pr-body">
          {protocolQ.isError || findingsQ.isError ? <Alert type="error" showIcon message="Не удалось загрузить протокол" /> : <Text type="secondary">Загрузка протокола…</Text>}
        </div>
      </div>
    );
  }

  const ver: ProtocolVersion =
    apiMode && protocolQ.data && findingsQ.data
      ? toProtocolVersion({ protocol: protocolQ.data, findings: findingsQ.data, completeness: processQ.data?.completeness?.status })
      : (PROTOCOL_VERSIONS.find((v) => v.value === versionKey) ?? PROTOCOL_VERSIONS[0]);
  const currentVersionKey = apiMode ? currentProtocolId : (PROTOCOL_VERSIONS.find((v) => v.current) ?? PROTOCOL_VERSIONS[0]).value;
  const versionOptions = apiMode
    ? (versionsQ.data ?? []).map((v) => ({ value: v.id, label: `Версия ${v.version} (${formatDateTime(v.created_at)}${v.is_current ? ', текущая' : ''})` }))
    : PROTOCOL_VERSIONS.map((v) => ({ value: v.value, label: v.label }));
  const versionNumber = ver.number ?? ver.value;
  const processLabel = apiMode ? (processId ?? '').slice(0, 8) : PROCESS_ID;
  const inspectorName = apiMode ? (protocolQ.data?.inspector?.full_name ?? user?.full_name ?? '') : INSPECTOR_NAME;
  const externalSystem = syncQ.data?.external_system ?? EXTERNAL_SYSTEM;
  const readOnly = !ver.current;

  const vars = {
    '--pr-teal': TEAL,
    '--pr-border': token.colorBorder,
    '--pr-muted': token.colorTextSecondary,
  } as React.CSSProperties;

  const cardStyle: React.CSSProperties = {
    borderRadius: 12,
    background: token.colorBgContainer,
    border: `1px solid ${token.colorBorder}`,
    marginBottom: 24,
  };

  const q = query.trim().toLowerCase();
  const findingText = (f: ProtocolFinding) => [
    f.paramCode,
    f.paramName,
    f.ruleKey,
    f.expected,
    f.actual,
    f.rationale,
    f.normative,
    f.request,
    ...f.sources.map((s) => `${s.fileName} ${s.cipher}`),
    f.decision?.by,
    f.decision?.comment,
  ];

  const sectionOptions = Array.from(new Set(ver.findings.map((f) => f.section).filter((s): s is string => Boolean(s)))).sort();
  const all = ver.findings.filter((f) => (!sectionFilter || f.section === sectionFilter) && matches(q, findingText(f)));
  const groups: Record<SectionKey, ProtocolFinding[] | Suspicion[]> = {
    completeness: all.filter((f) => COMPLETENESS_STATUSES.includes(f.status)),
    candidates: all.filter((f) => f.status === 'CANDIDATE'),
    confirmed: all.filter((f) => f.status === 'CONFIRMED_VIOLATION'),
    // В таблицу (4) попадают только отклонения инспектора: вердикт движка «нарушения нет» (значения совпали) это не находка
    negative: all.filter((f) => f.status === 'NEGATIVE_VERIFIED' && f.decision),
    suspicions: ver.suspicions.filter((s) => matches(q, [s.code, s.topic, s.description, s.fileName])),
  };

  // Сводка считается по всем записям версии, без учёта поиска
  const total = {
    completeness: ver.findings.filter((f) => COMPLETENESS_STATUSES.includes(f.status)).length,
    candidates: ver.findings.filter((f) => f.status === 'CANDIDATE').length,
    confirmed: ver.findings.filter((f) => f.status === 'CONFIRMED_VIOLATION').length,
    negative: ver.findings.filter((f) => f.status === 'NEGATIVE_VERIFIED' && f.decision).length,
    systemOk: ver.findings.filter((f) => f.status === 'NEGATIVE_VERIFIED' && !f.decision).length,
    suspicions: ver.suspicions.length,
  };
  const evaluated = total.candidates + total.confirmed + total.negative + total.systemOk;
  const compliance: number | null = apiMode
    ? (protocolQ.data?.summary.compliance_percent ?? null)
    : evaluated
      ? Math.round((1 - total.confirmed / evaluated) * 100)
      : 100;
  const foundCount = Object.values(groups).reduce((sum, list) => sum + list.length, 0);

  const canFinalize = apiMode ? Boolean(processQ.data?.can_finalize) : total.candidates === 0;
  const canUnfinalize = user?.role === 'ADMIN' || user?.role === 'SUPERVISOR';
  // Инспектор сам финализацию не отменяет: он просит об этом с причиной
  const canRequestUnfinalize = apiMode && user?.role === 'INSPECTOR' && Boolean(processId);
  const requestSent = requestSentFor === processId;
  const openRequest = (requestsQ.data ?? []).find((r) => r.object_id === objectId);
  // Завершить проверку и принять решения api разрешает только инспектору и супервизору (администратор может лишь отменить финализацию)
  const canFinalizeRole = !apiMode || user?.role === 'INSPECTOR' || user?.role === 'SUPERVISOR';
  const isFinalized = (apiMode ? finalizedInApi : finalized) && !readOnly;
  const processStatus = readOnly
    ? PROCESS_STATUS.COMPLETED
    : apiMode
      ? PROCESS_STATUS[statusQ.data?.status ?? 'PENDING']
      : isFinalized
        ? PROCESS_STATUS.FINALIZED
        : PROCESS_STATUS.VERIFYING;
  const missingRequests = ver.findings.filter((f) => f.status === 'MISSING_EVIDENCE' || f.status === 'NOT_COMPARABLE');
  const editable = !readOnly && !isFinalized;

  const openVerification = () => navigate(`/verification?object=${objectId}`);
  const openHypotheses = () => navigate(`/verification?object=${objectId}&view=hypotheses`);
  // «Заполнить» реквизиты — к началу страницы загрузки, «Дозагрузить» — сразу к разделу загрузки документов
  const openUpload = () => navigate(`/upload?object=${objectId}`);
  const openUploadDocs = () => navigate(`/upload?object=${objectId}&focus=upload`);

  const registryShown = (() => {
    const q = registryQuery.trim().toLowerCase();
    if (!q) return ver.registry;
    return ver.registry.filter((r) => [r.fileName, r.cipher, r.title, r.stage, r.revision].join(' ').toLowerCase().includes(q));
  })();

  const scrollToSection = (key: SectionKey) => {
    const el = bodyRef.current?.querySelector(`#pr-${key}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const handleExport = async (format: ExportFormat) => {
    if (apiMode && activeProtocolId) {
      const extension = format === 'gold' || format === 'submission' ? 'json' : format;
      try {
        await downloadProtocol(activeProtocolId, format, `protocol_v${versionNumber}.${extension}`);
      } catch (error) {
        message.error(error instanceof Error ? error.message : 'Не удалось выгрузить протокол');
      }
      return;
    }
    if (format !== 'json') {
      message.info(`Выгрузка в ${format.toUpperCase()} доступна при подключении к серверу`);
      return;
    }
    const payload = {
      schema_version: 'inspector-protocol/1.0',
      process_id: PROCESS_ID,
      protocol_version: versionNumber,
      exported_at: new Date().toISOString(),
      findings: ver.findings,
      suspicions: ver.suspicions,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `protocol_${PROCESS_ID}_v${versionNumber}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const exportMenu = [
    { key: 'pdf', icon: <FilePdfOutlined />, label: 'PDF', onClick: () => handleExport('pdf') },
    { key: 'docx', icon: <FileWordOutlined />, label: 'DOCX', onClick: () => handleExport('docx') },
    { key: 'xml', icon: <FileTextOutlined />, label: 'XML', onClick: () => handleExport('xml') },
    { key: 'json', icon: <FileTextOutlined />, label: 'JSON', onClick: () => handleExport('json') },
    ...(apiMode ? [{ key: 'gold', icon: <FileTextOutlined />, label: 'Выгрузка GOLD', onClick: () => handleExport('gold') }] : []),
  ];

  // После финализации и её отмены меняются статус проверки, версия, список проектов и передача во внешнюю ИС
  const refreshAfterChange = async () => {
    await queryClient.invalidateQueries({ queryKey: ['process-status'] });
    void queryClient.invalidateQueries({ queryKey: ['process'] });
    void queryClient.invalidateQueries({ queryKey: ['protocol'] });
    void queryClient.invalidateQueries({ queryKey: ['protocol-versions'] });
    void queryClient.invalidateQueries({ queryKey: ['protocol-findings'] });
    void queryClient.invalidateQueries({ queryKey: ['inspection-sync'] });
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
    void queryClient.invalidateQueries({ queryKey: ['unfinalize-requests'] });
  };

  const handleFinalize = () => {
    // Финализация не требует полного комплекта: параметры без доказательств — это нехватка данных,
    // а не решение инспектора, они остаются в протоколе как есть (таблица «Комплектность»)
    const incomplete = total.completeness > 0 ? `По ${total.completeness} параметрам не хватает документов для сравнения: они останутся в протоколе как «нет данных», это не блокирует завершение. ` : '';
    modal.confirm({
      title: 'Завершить проверку?',
      content: `${incomplete}После финализации дозагрузка и смена решений станут недоступны. Результат уйдёт в ${externalSystem}.`,
      okText: 'Завершить',
      cancelText: 'Отмена',
      onOk: async () => {
        if (apiMode && processId) {
          try {
            await finalizeProcess(processId);
            await refreshAfterChange();
            message.success('Протокол финализирован');
          } catch (error) {
            message.error(error instanceof Error ? error.message : 'Не удалось завершить проверку');
          }
          return;
        }
        setFinalized(true);
        message.success('Протокол финализирован');
      },
    });
  };

  const handleUnfinalize = async () => {
    if (!unfinalizeReason.trim()) return;
    if (apiMode && processId) {
      setWorking(true);
      try {
        await unfinalizeProcess(processId, unfinalizeReason.trim());
        await refreshAfterChange();
      } catch (error) {
        message.error(error instanceof Error ? error.message : 'Не удалось отменить финализацию');
        setWorking(false);
        return;
      }
      setWorking(false);
    } else {
      setFinalized(false);
    }
    setUnfinalizeOpen(false);
    setUnfinalizeReason('');
    message.success(isAdmin ? 'Финализация откатена, причина записана в журнал аудита' : 'Финализация отменена, причина записана в журнал аудита');
    // Проект вернулся инспектору: у администратора на этой странице ему больше нечего смотреть
    if (isAdmin) navigate('/dashboard');
  };

  const handleRequestUnfinalize = async () => {
    if (!processId || !requestReason.trim()) return;
    setWorking(true);
    try {
      await requestUnfinalize(processId, requestReason.trim());
      message.success('Запрос отправлен: администратор и руководитель получили уведомление');
    } catch (error) {
      // Запрос уже открыт: повторять не нужно, только запоминаем это для кнопки
      if (!(error instanceof RequestExistsError)) {
        message.error(error instanceof Error ? error.message : 'Не удалось отправить запрос на откат');
        setWorking(false);
        return;
      }
      message.info(error.message);
    }
    setWorking(false);
    setRequestSentFor(processId);
    setRequestOpen(false);
    setRequestReason('');
  };

  const handleRejectRequest = async () => {
    if (!openRequest || !rejectReason.trim()) return;
    setWorking(true);
    try {
      await rejectUnfinalizeRequest(openRequest.id, rejectReason.trim());
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось отклонить запрос');
      setWorking(false);
      return;
    }
    setWorking(false);
    setRejectOpen(false);
    setRejectReason('');
    message.success('Запрос отклонён, причина сохранена');
    void queryClient.invalidateQueries({ queryKey: ['unfinalize-requests'] });
  };

  const handleRetrySync = async () => {
    if (!processId) return;
    try {
      await retrySync(processId);
      await queryClient.invalidateQueries({ queryKey: ['inspection-sync'] });
      message.success('Отправка поставлена в очередь');
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось повторить отправку');
    }
  };

  const cardButton = (f: ProtocolFinding) => (
    <Button
      size="small"
      type="primary"
      onClick={(e) => {
        e.stopPropagation();
        setCardFinding(f);
      }}
    >
      Карточка
    </Button>
  );

  const paramCell = (f: ProtocolFinding) => (
    <>
      <span className="pr-code">{f.paramCode}</span>
      <span className="pr-sub">{f.paramName}</span>
    </>
  );

  const sourceCell = (f: ProtocolFinding, role: 'EXPECTED' | 'ACTUAL', value?: string) => {
    const src = f.sources.find((s) => s.role === role);
    return (
      <>
        <b>{value ?? 'нет'}</b>
        {src && (
          <span className="pr-sub">
            <StageChip stage={src.stage} /> {pageLabel(src.sheet.toLowerCase(), src.page)}
          </span>
        )}
      </>
    );
  };

  // Общие колонки таблиц (2), (3), (4)
  const findingColumns = (withDecision: boolean): ColumnsType<ProtocolFinding> => [
    { title: th('Параметр'), key: 'param', render: (_, f) => paramCell(f) },
    {
      title: (
        <Tooltip title="Высокий, средний или низкий приоритет задаёт только очерёдность проверки и не является юридическим основанием. Нарушение подтверждает только инспектор.">
          <span>{th('Приоритет проверки')}</span>
        </Tooltip>
      ),
      key: 'priority',
      render: (_, f) => {
        const p = f.priority ? CHECK_PRIORITY[f.priority] : undefined;
        return p ? <StatusPill color={p.color}>{p.label}</StatusPill> : 'нет';
      },
    },
    { title: th('Ожидается'), key: 'expected', render: (_, f) => sourceCell(f, 'EXPECTED', f.expected) },
    { title: th('Фактически'), key: 'actual', render: (_, f) => sourceCell(f, 'ACTUAL', f.actual) },
    { title: th('Отклонение'), dataIndex: 'delta', key: 'delta', render: (v?: string) => v ?? 'нет' },
    {
      title: th('Решение инспектора'),
      key: 'decision',
      className: 'col-wrap',
      render: (_, f) =>
        withDecision && f.decision ? (
          <>
            <StatusPill color={FINDING_STATUS[f.status].color}>
              {f.decision.reasonCode ? REJECT_REASON[f.decision.reasonCode].label : FINDING_STATUS[f.status].label}
            </StatusPill>
            <span className="pr-sub">
              {f.decision.by}, {f.decision.at}
            </span>
          </>
        ) : withDecision ? (
          // В таблице решений находка без решения инспектора — вердикт движка «нарушения нет», решать по ней нечего
          <StatusPill color="success">Нарушения нет</StatusPill>
        ) : (
          <StatusPill tone="default">Ожидает решения</StatusPill>
        ),
    },
    { title: '', key: 'open', fixed: 'right', width: 116, render: (_, f) => cardButton(f) },
  ];

  // Таблица (1): комплектность и сопоставимость
  const completenessColumns: ColumnsType<ProtocolFinding> = [
    { title: th('Параметр'), key: 'param', render: (_, f) => paramCell(f) },
    {
      title: th('Статус'),
      key: 'status',
      render: (_, f) => <StatusPill color={FINDING_STATUS[f.status].color}>{FINDING_STATUS[f.status].label}</StatusPill>,
    },
    { title: th('Стадия'), key: 'stage', render: (_, f) => (f.stage ? <StageChip stage={f.stage} /> : 'нет') },
    { title: th('Причина'), dataIndex: 'rationale', key: 'rationale', className: 'col-wrap', width: 230 },
    {
      title: th('Что сделать'),
      dataIndex: 'request',
      key: 'request',
      className: 'col-wrap',
      width: 210,
      render: (v?: string) => v ?? 'нет',
    },
    {
      title: '',
      key: 'open',
      fixed: 'right',
      width: 116,
      render: (_, f) =>
        f.status === 'MISSING_EVIDENCE' && editable ? (
          <Button
            size="small"
            type="primary"
            onClick={(e) => {
              e.stopPropagation();
              openUploadDocs();
            }}
          >
            Дозагрузить
          </Button>
        ) : (
          cardButton(f)
        ),
    },
  ];

  // Таблица (5): гипотезы свободного поиска
  const suspicionColumns: ColumnsType<Suspicion> = [
    { title: th('Код'), dataIndex: 'code', key: 'code', render: (v: string) => <span className="pr-code">{v}</span> },
    { title: th('Тема'), dataIndex: 'topic', key: 'topic' },
    { title: th('Описание'), dataIndex: 'description', key: 'description', className: 'col-wrap', width: 380 },
    {
      title: th('Источник'),
      key: 'source',
      render: (_, s) => (
        <>
          <StageChip stage={s.stage} />
          <span className="pr-sub">
            {pageLabel(s.fileName, s.page)}
          </span>
        </>
      ),
    },
    { title: th('Уверенность'), dataIndex: 'confidence', key: 'confidence', render: (v: number) => `${Math.round(v * 100)} %` },
    { title: th('Статус'), key: 'status', render: () => <StatusPill tone="default">Ожидает решения</StatusPill> },
  ];

  const rowProps = (f: ProtocolFinding) => ({ className: 'pr-row-click', onClick: () => setCardFinding(f) });
  const tableProps = {
    pagination: { defaultPageSize: 10, hideOnSinglePage: true, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'] },
    // Ниже этой ширины таблица прокручивается вбок; выше — колонки делят место, длинный текст переносится
    scroll: { x: 760 },
    // Ширина колонок по содержимому: слова не рвутся посередине, лишний текст уходит на следующую строку
    tableLayout: 'auto' as const,
  };

  const sections: Array<{ key: SectionKey; title: string; hint: string; table: React.ReactNode }> = [
    {
      key: 'completeness',
      title: '(1) Комплектность и сопоставимость',
      hint: 'Не нарушения: чего не хватает или что нельзя сопоставить. Вывод о нарушении по этим параметрам не делается.',
      table: (
        <Table
          rowKey="id"
          columns={completenessColumns}
          dataSource={groups.completeness as ProtocolFinding[]}
          onRow={rowProps}
          locale={{ emptyText: <TableEmpty hint="Здесь появятся параметры, для которых не хватает документов или значения нельзя сравнить.">Записей нет</TableEmpty> }}
          {...tableProps}
        />
      ),
    },
    {
      key: 'candidates',
      title: '(2) Предварительные кандидаты',
      hint: 'Расхождения, найденные системой. Решение принимает инспектор в верификации.',
      table: (
        <Table
          rowKey="id"
          columns={findingColumns(false)}
          dataSource={groups.candidates as ProtocolFinding[]}
          onRow={rowProps}
          locale={{ emptyText: <TableEmpty hint="По каждому найденному расхождению уже принято решение.">Необработанных кандидатов нет</TableEmpty> }}
          {...tableProps}
        />
      ),
    },
    {
      key: 'confirmed',
      title: '(3) Подтверждённые нарушения',
      hint: 'Решение принял инспектор, у каждой записи полная карточка доказательства.',
      table: (
        <Table
          rowKey="id"
          columns={findingColumns(true)}
          dataSource={groups.confirmed as ProtocolFinding[]}
          onRow={rowProps}
          locale={{ emptyText: <TableEmpty hint="Нарушение подтверждает только инспектор в верификации, кнопкой «Подтвердить».">Подтверждённых нарушений нет</TableEmpty> }}
          {...tableProps}
        />
      ),
    },
    {
      key: 'negative',
      title: '(4) Проверенные отрицательные',
      hint: 'Кандидаты, отклонённые инспектором с причиной. Они пополняют набор для дообучения.',
      table: (
        <>
          <Table
            rowKey="id"
            columns={findingColumns(true)}
            dataSource={groups.negative as ProtocolFinding[]}
            onRow={rowProps}
            locale={{ emptyText: <TableEmpty hint="Сюда попадают кандидаты, которые инспектор отклонил с указанием причины.">Отклонённых кандидатов нет</TableEmpty> }}
            {...tableProps}
          />
        </>
      ),
    },
    {
      key: 'suspicions',
      title: '(5) Гипотезы свободного поиска',
      hint: 'Подозрения вне матрицы. Это не нарушения, пока инспектор не сделает их кандидатами.',
      table: (
        <Table
          rowKey="id"
          columns={suspicionColumns}
          dataSource={groups.suspicions as Suspicion[]}
          locale={{ emptyText: <TableEmpty hint="Гипотезы — подозрения вне матрицы: они появляются, если проверка нашла что-то за её пределами.">Гипотез нет</TableEmpty> }}
          {...tableProps}
        />
      ),
    },
  ];

  const stats: Array<{ key?: SectionKey; title: string; value: number; icon: React.ReactNode }> = [
    { key: 'completeness', title: 'Комплектность', value: total.completeness, icon: <AppstoreAddOutlined style={{ fontSize: 28, color: token.colorWarning }} /> },
    { key: 'candidates', title: 'Кандидаты', value: total.candidates, icon: <ClockCircleOutlined style={{ fontSize: 28, color: TEAL }} /> },
    { key: 'confirmed', title: 'Подтверждено', value: total.confirmed, icon: <CloseCircleOutlined style={{ fontSize: 28, color: token.colorError }} /> },
    { key: 'negative', title: 'Отрицательные', value: total.negative, icon: <CheckCircleOutlined style={{ fontSize: 28, color: token.colorSuccess }} /> },
    { key: 'suspicions', title: 'Гипотезы', value: total.suspicions, icon: <BulbOutlined style={{ fontSize: 28, color: token.colorTextSecondary }} /> },
  ];

  const upload = STAGE_UPLOAD_STATUS;
  const scenario = SCENARIO_LABEL[ver.scenario];

  const fact = (label: string, value: React.ReactNode, fillable = false) => (
    <div>
      <b>{label}</b>
      {value ? (
        value
      ) : (
        <>
          <Text type="secondary">Не указано</Text>
          {fillable && !isAdmin && editable && (
            <a className="pr-fill" onClick={openUpload}>
              Заполнить
            </a>
          )}
        </>
      )}
    </div>
  );

  return (
    <>
      <div className="pr-root" style={vars}>
        {/* Заголовок страницы, как на остальных экранах */}
        {pageTitle}

        <div className="pr-body" ref={bodyRef}>
          {/* Сведения о проверке */}
          <Card
            style={cardStyle}
            title={
              <div className="pr-title-row">
                <Text strong style={{ fontSize: 17 }}>
                  Протокол проверки № {processLabel}, версия {versionNumber}
                </Text>
                <div className="pr-actions">
                  <Select
                    value={ver.value}
                    onChange={(value) => {
                      setVersionKey(value);
                      setQuery('');
                    }}
                    style={{ minWidth: 250 }}
                    options={versionOptions}
                  />
                  {!isAdmin && (
                    <Button type="primary" onClick={openVerification}>
                      Верификация
                    </Button>
                  )}
                  <Dropdown menu={{ items: exportMenu }} placement="bottomRight">
                    <Button icon={<DownloadOutlined />}>Скачать</Button>
                  </Dropdown>
                  {!readOnly && !isFinalized && canFinalizeRole && (
                    <Tooltip title={canFinalize ? '' : `Обработайте всех кандидатов (осталось ${total.candidates})`}>
                      <span>
                        <Button type="primary" disabled={!canFinalize} onClick={handleFinalize}>
                          Завершить проверку
                        </Button>
                      </span>
                    </Tooltip>
                  )}
                  {isFinalized && canRequestUnfinalize && (
                    <Tooltip title={requestSent ? 'Запрос уже отправлен и ждёт решения' : ''}>
                      <span>
                        <Button danger disabled={requestSent} onClick={() => setRequestOpen(true)}>
                          Попросить откат
                        </Button>
                      </span>
                    </Tooltip>
                  )}
                  {isFinalized && canUnfinalize && (
                    <Button danger onClick={() => setUnfinalizeOpen(true)}>
                      {isAdmin ? 'Откатить финализацию' : 'Отменить финализацию'}
                    </Button>
                  )}
                </div>
              </div>
            }
          >
            {readOnly && (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 16 }}
                message={`Это прежняя версия ${versionNumber} от ${ver.createdAt}. Она сохранена в истории и не меняется.`}
                action={
                  <Button size="small" type="primary" onClick={() => setVersionKey(currentVersionKey)}>
                    К текущей версии
                  </Button>
                }
              />
            )}

            <div className="pr-facts">
              {fact('Проект', project?.name)}
              {fact('Адрес', project?.address, true)}
              {fact('Застройщик', project?.developer, true)}
              {fact('Подрядчик', project?.contractor, true)}
              {fact('№ разрешения', project?.permit, true)}
              {fact('Инспектор', inspectorName)}
              {fact('Создан', ver.createdAt)}
              {fact('Статус проверки', <StatusPill color={processStatus.color}>{processStatus.label}</StatusPill>)}
              {fact('Версия матрицы', <code>{ver.matrixVersion}</code>)}
              {fact('Версия модели', <code>{ver.modelVersion}</code>)}
              {fact('Версия датасета', <code>{ver.datasetVersion}</code>)}
              {fact(
                'Хеш манифеста',
                <Text code copyable={{ text: ver.manifestHash }} style={{ fontSize: 12 }}>
                  {ver.manifestHash.slice(0, 16)}…
                </Text>
              )}
            </div>
          </Card>

          {isFinalized && !apiMode && (
            <Alert
              type="success"
              showIcon
              style={{ marginBottom: 24 }}
              message={`Передаётся в ${externalSystem}`}
              description="Протокол финализирован, результат уйдёт автоматически. Если система недоступна, отправка повторится, решения инспектора не изменятся."
            />
          )}

          {isFinalized && apiMode && syncQ.data && (
            <Alert
              type={syncQ.data.sync_status === 'SYNCED' ? 'success' : syncQ.data.sync_status === 'SYNC_FAILED' ? 'error' : 'info'}
              showIcon
              style={{ marginBottom: 24 }}
              message={
                syncQ.data.sync_status === 'SYNCED'
                  ? `Передано в ${externalSystem}, квитанция ${syncQ.data.receipt_id ?? 'нет'}`
                  : syncQ.data.sync_status === 'SYNC_FAILED'
                    ? `Не передано в ${externalSystem}: ${syncQ.data.last_error ?? 'ошибка связи'}`
                    : syncQ.data.sync_status === 'PENDING_SYNC'
                      ? `Передаётся в ${externalSystem}, попытка ${syncQ.data.attempts ?? 1}${syncQ.data.next_attempt_at ? `, следующая в ${formatDateTime(syncQ.data.next_attempt_at)}` : ''}`
                      : `Передача в ${externalSystem} не запускалась`
              }
              action={
                syncQ.data.sync_status === 'SYNC_FAILED' ? (
                  <Button size="small" onClick={handleRetrySync}>
                    Отправить повторно
                  </Button>
                ) : undefined
              }
            />
          )}

          {isFinalized && canUnfinalize && openRequest && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              message={openRequest.requested_by_name ? `${openRequest.requested_by_name} просит откатить финализацию` : 'Инспектор просит откатить финализацию'}
              description={
                <>
                  <div>{openRequest.reason}</div>
                  <Text type="secondary">Запрос от {formatDateTime(openRequest.created_at)}. Откат финализации закроет запрос сам.</Text>
                </>
              }
              action={
                <Button className="negative-action" size="small" onClick={() => setRejectOpen(true)}>
                  Отклонить запрос
                </Button>
              }
            />
          )}

          {/* Сводка */}
          {!readOnly && !isFinalized && canFinalizeRole && (
            <Alert
              style={{ marginBottom: 24 }}
              showIcon
              type={canFinalize ? 'success' : 'warning'}
              message={canFinalize ? 'Все решения приняты: проверку можно завершить' : `До завершения проверки осталось решений: ${total.candidates}`}
              description={
                canFinalize
                  ? `${total.completeness > 0 ? `Решений по кандидатам не осталось. По ${total.completeness} параметрам не хватает документов: они останутся в протоколе как «нет данных», это не мешает завершить проверку. ` : ''}После завершения дозагрузка и смена решений станут недоступны, результат уйдёт в ${externalSystem}.`
                  : 'Завершить проверку можно, когда по каждому кандидату принято решение: подтвердить, отклонить или запросить уточнение.'
              }
            />
          )}

          <Row gutter={[24, 24]} style={{ marginBottom: 24 }}>
            <Col xs={24} sm={12} xl={{ flex: '1 1 0' }}>
              <Card style={{ ...cardStyle, marginBottom: 0, height: '100%' }}>
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <CheckCircleOutlined style={{ fontSize: 28, color: (compliance ?? 0) >= 80 ? token.colorSuccess : token.colorWarning }} />
                  <div style={{ fontSize: 40, fontWeight: 600, lineHeight: 1.2 }}>{compliance === null ? 'нет' : `${compliance}%`}</div>
                  <Progress percent={compliance ?? 0} showInfo={false} size="small" strokeColor={(compliance ?? 0) >= 80 ? token.colorSuccess : token.colorWarning} />
                  <Text type="secondary" style={{ fontSize: 14 }}>
                    Соответствие
                  </Text>
                </Space>
              </Card>
            </Col>
            {stats.map((item) => (
              <Col xs={24} sm={12} xl={{ flex: '1 1 0' }} key={item.title}>
                <Card
                  hoverable
                  style={{ ...cardStyle, marginBottom: 0, height: '100%' }}
                  onClick={() => item.key && scrollToSection(item.key)}
                >
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

          {/* Статус загрузки и тип проверки */}
          <Card style={cardStyle} title={<Text strong style={{ fontSize: 17 }}>Статус загрузки документов и тип проверки</Text>}>
            <Space size={[32, 12]} wrap>
              <Space size={8} wrap>
                <Text type="secondary">Статус загрузки</Text>
                {[ver.uploadStatus.pd, ver.uploadStatus.rd, ver.uploadStatus.id].map((key) => {
                  const item = upload[key as keyof typeof upload];
                  return (
                    <StatusPill key={key} color={item.color}>
                      {item.label}
                    </StatusPill>
                  );
                })}
              </Space>
              <Space size={8}>
                <Text type="secondary">Тип проверки</Text>
                <StatusPill tone="default">{scenario}</StatusPill>
              </Space>
              <Space size={8}>
                <Text type="secondary">Комплектность</Text>
                <StatusPill color={COMPLETENESS_STATUS[ver.completeness as keyof typeof COMPLETENESS_STATUS].color}>
                  {COMPLETENESS_STATUS[ver.completeness as keyof typeof COMPLETENESS_STATUS].label}
                </StatusPill>
              </Space>
            </Space>
          </Card>

          {/* Реестр входных файлов */}
          <Card
            style={cardStyle}
            title={<Text strong style={{ fontSize: 17 }}>Реестр входных файлов</Text>}
            extra={
              <Input
                allowClear
                prefix={<SearchOutlined />}
                placeholder="Поиск: файл, шифр, заголовок"
                value={registryQuery}
                onChange={(e) => setRegistryQuery(e.target.value)}
                style={{ width: 280, maxWidth: '100%' }}
              />
            }
          >
            <Table
              rowKey="fileId"
              pagination={{ defaultPageSize: 20, hideOnSinglePage: true, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'], position: ['bottomLeft'] }}
              scroll={{ x: 720 }}
              tableLayout="auto"
              dataSource={registryShown}
              columns={[
                {
                  title: th('Файл'),
                  key: 'file',
                  render: (_, r) => (
                    <>
                      {r.fileName}
                      {r.title && <span className="pr-sub">{r.title}</span>}
                      <span className="pr-sub">{r.fileId}</span>
                      {r.uploaded && <span className="pr-sub">{r.uploaded}</span>}
                    </>
                  ),
                },
                { title: th('Стадия'), dataIndex: 'stage', key: 'stage', render: (v: string) => <StageChip stage={v} /> },
                { title: th('Шифр'), dataIndex: 'cipher', key: 'cipher' },
                { title: th('Редакция'), dataIndex: 'revision', key: 'revision' },
                {
                  title: th('Статус утверждения'),
                  dataIndex: 'approval',
                  key: 'approval',
                  render: (v: keyof typeof APPROVAL_STATUS) => (
                    <StatusPill color={APPROVAL_STATUS[v].color}>{APPROVAL_STATUS[v].label}</StatusPill>
                  ),
                },
                { title: th('Страниц прочитано'), dataIndex: 'pages', key: 'pages' },
                {
                  title: th('SHA-256'),
                  width: 190,
                  dataIndex: 'sha256',
                  key: 'sha256',
                  render: (v: string) => (
                    <Text code copyable={{ text: v }} title={v} style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                      {v.slice(0, 8)}…{v.slice(-4)}
                    </Text>
                  ),
                },
              ]}
              footer={() =>
                ver.uploadStatus.id === 'ID_MISSING' ? (
                  <Text type="secondary">
                    Исполнительная документация (ИД) не загружена.{' '}
                    {editable && <a onClick={openUploadDocs}>Дозагрузить</a>}
                  </Text>
                ) : null
              }
            />
          </Card>

          {/* Поиск по протоколу */}
          <div
            className="pr-search-bar"
            style={{
              position: 'sticky',
              top: 0,
              zIndex: 5,
              background: token.colorBgContainer,
              border: `1px solid ${token.colorBorder}`,
              borderRadius: 12,
              padding: '12px 16px',
              marginBottom: 24,
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <Input
              allowClear
              size="large"
              prefix={<SearchOutlined />}
              placeholder="Поиск по протоколу: параметр, значение, файл, шифр, инспектор"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ flex: '1 1 280px', minWidth: 220 }}
            />
            {sectionOptions.length > 1 && (
              <Select
                allowClear
                size="large"
                showSearch
                optionFilterProp="label"
                placeholder="Раздел"
                value={sectionFilter}
                onChange={setSectionFilter}
                options={sectionOptions.map((s) => ({ value: s, label: s }))}
                style={{ width: 140 }}
              />
            )}
            <Text type="secondary" style={{ whiteSpace: 'nowrap' }}>
              {q || sectionFilter ? `Найдено: ${pluralize(foundCount)}` : `Всего: ${pluralize(foundCount)}`}
            </Text>
          </div>

          {/* 5 таблиц друг за другом (REQ-CMP-08) */}
          {sections.map((section) => (
            <Card
              id={`pr-${section.key}`}
              key={section.key}
              style={cardStyle}
              title={
                <div className="pr-title-row" style={{ justifyContent: 'flex-start' }}>
                  <Text strong style={{ fontSize: 17 }}>
                    {section.title}
                  </Text>
                  <StatusPill tone="default">{groups[section.key].length}</StatusPill>
                  <InfoHint label={`Пояснение: ${section.title}`}>{section.hint}</InfoHint>
                </div>
              }
              extra={
                section.key === 'suspicions' && apiMode && !readOnly && !isAdmin && total.suspicions > 0 ? (
                  <Button onClick={openHypotheses}>{openSuspicions > 0 ? `Разобрать гипотезы (${openSuspicions})` : 'Открыть гипотезы'}</Button>
                ) : null
              }
            >
              {section.table}
            </Card>
          ))}

          {/* Что нужно запросить или дозагрузить (REQ-VER-07) */}
          <Card style={cardStyle} title={<Text strong style={{ fontSize: 17 }}>Что нужно запросить или дозагрузить</Text>}>
            {missingRequests.length === 0 ? (
              <Text type="secondary">Комплект полный, запрашивать нечего.</Text>
            ) : (
              missingRequests.map((f) => (
                <div className="pr-request" key={f.id}>
                  <div className="pr-request-text">
                    <Space size={8} wrap>
                      <span className="pr-code">{f.paramCode}</span>
                      {f.stage && <StageChip stage={f.stage} />}
                      <StatusPill color={FINDING_STATUS[f.status].color}>{FINDING_STATUS[f.status].label}</StatusPill>
                    </Space>
                    <div style={{ marginTop: 6 }}>{f.request}</div>
                  </div>
                  {editable && (
                    <Button size="small" type="primary" onClick={openUploadDocs}>
                      Дозагрузить
                    </Button>
                  )}
                </div>
              ))
            )}
          </Card>

          {/* Подпись */}
          <Card style={cardStyle} title={<Text strong style={{ fontSize: 17 }}>Подпись инспектора</Text>}>
            <div className="pr-sign">
              <div>
                <b style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--pr-muted)', display: 'block' }}>
                  Инспектор
                </b>
                {inspectorName}
              </div>
              <div>
                <b style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--pr-muted)', display: 'block' }}>
                  Подпись
                </b>
                <div className="pr-sign-line" />
              </div>
              <div>
                <b style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--pr-muted)', display: 'block' }}>
                  Дата
                </b>
                <div className="pr-sign-line" style={{ minWidth: 140 }} />
              </div>
            </div>
          </Card>
        </div>

        <EvidenceCardDrawer
          finding={cardFinding}
          onClose={() => setCardFinding(null)}
          onOpenVerification={
            isAdmin
              ? undefined
              : () => {
                  setCardFinding(null);
                  openVerification();
                }
          }
        />

        <Modal
          title={isAdmin ? 'Откатить финализацию' : 'Отменить финализацию'}
          open={unfinalizeOpen}
          onOk={handleUnfinalize}
          onCancel={() => setUnfinalizeOpen(false)}
          okText={isAdmin ? 'Откатить' : 'Отменить финализацию'}
          cancelText="Закрыть"
          confirmLoading={working}
          okButtonProps={{ danger: true, disabled: !unfinalizeReason.trim() }}
        >
          <Text type="secondary">Причина обязательна и попадёт в журнал аудита.</Text>
          <TextArea
            rows={4}
            value={unfinalizeReason}
            onChange={(e) => setUnfinalizeReason(e.target.value)}
            placeholder="Почему нужно вернуть проверку в работу"
            style={{ marginTop: 12 }}
          />
        </Modal>

        <Modal
          title="Попросить откат финализации"
          open={requestOpen}
          onOk={handleRequestUnfinalize}
          onCancel={() => setRequestOpen(false)}
          okText="Отправить запрос"
          cancelText="Закрыть"
          confirmLoading={working}
          okButtonProps={{ disabled: !requestReason.trim() }}
        >
          <Text type="secondary">Финализацию отменяет администратор или руководитель. Причина обязательна: они увидят её в уведомлении.</Text>
          <TextArea rows={4} value={requestReason} onChange={(e) => setRequestReason(e.target.value)} placeholder="Почему нужно вернуть проверку в работу" style={{ marginTop: 12 }} />
        </Modal>

        <Modal
          title="Отклонить запрос на откат"
          open={rejectOpen}
          onOk={handleRejectRequest}
          onCancel={() => setRejectOpen(false)}
          okText="Отклонить"
          cancelText="Закрыть"
          confirmLoading={working}
          okButtonProps={{ danger: true, disabled: !rejectReason.trim() }}
        >
          <Text type="secondary">Причина отказа сохранится в запросе. Финализация останется в силе.</Text>
          <TextArea rows={4} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="Почему откат не нужен" style={{ marginTop: 12 }} />
        </Modal>
      </div>
    </>
  );
};
