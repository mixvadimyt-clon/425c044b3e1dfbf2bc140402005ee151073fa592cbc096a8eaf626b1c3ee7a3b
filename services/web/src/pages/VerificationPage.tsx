import React from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, App, Button, Select } from 'antd';
import { BySenseTag } from '@/widgets/BySenseTag';
import { useQueryClient } from '@tanstack/react-query';
import { REJECT_REASON } from '@/shared/statuses';
import { lowerFirst } from '@/shared/text';
import { ProjectNotSelected } from '@/widgets/ProjectNotSelected';
import { FindingDescription } from '@/widgets/FindingDescription';
import { StageComparisonTable } from '@/widgets/StageComparisonTable';
import { MarkBox, PdfPage } from '@/widgets/PdfPage';
import type { PdfMark } from '@/widgets/PdfPage';
import { useProjects } from '@/app/providers/useProjects';
import { useAuth } from '@/app/providers/useAuth';
import { useProcessFiles, useProcessStatus } from '@/api/processes';
import { bulkDecideFindings, decideFinding, editEvidence, isVerifiable, splitFinding, toFinding, useProtocolFindings, useProtocolsFindings } from '@/api/findings';
import type { ApiFinding } from '@/api/findings';
import { EvidenceEditor } from '@/widgets/EvidenceEditor';
import { CompareWorkspace } from '@/widgets/CompareWorkspace';
import { HypothesisPanels } from '@/widgets/HypothesisPanels';
import { ListFilters } from '@/widgets/ListFilters';
import { SuspicionDetail } from '@/widgets/SuspicionsPanel';
import { curateDatasetItem, useFindingProtocolIds, useRetrainItems } from '@/api/retrain';
import { formatDateTime } from '@/api/protocols';
import { filterSuspicions, METHOD_LABEL, SUSPICION_BADGE, suspicionRefs, useSuspicions } from '@/api/suspicions';
import type { ApiSuspicion, SuspicionFilter } from '@/api/suspicions';
import { stageLabel } from '@/api/pagePairs';
import type { PageRef } from '@/api/pagePairs';
import { DemoTag } from '@/widgets/DemoTag';
import { SplitFindingModal } from '@/widgets/SplitFindingModal';
import type { SplitPartValues } from '@/widgets/SplitFindingModal';
import { REJECT_TEMPLATES, bulkCandidatesOf, canSelectForBulk, decisionCommentText, isAwaitingDecision, isBulkCandidate } from '@/shared/verification';
import type { DraftFragment, EvidenceRole, Finding, RejectReason, Source } from '@/shared/verification';
import { loadRetrainQueue, updateRetrainItem } from '@/shared/retrainQueue';
import type { RetrainItem, RetrainStatus } from '@/shared/retrainQueue';
import { clampPan } from '@/widgets/zoomView';
import './VerificationPage.css';

const STAGE_COLORS: Record<string, string> = {
  'ПД': '#2450C7',
  'РД': '#B4620B',
  'ИД': '#5B4FBE',
};

// «1 запись ждёт», «2 записи ждут», «5 записей ждут»
const waitingRecordsWord = (n: number): string => {
  const last = n % 10;
  const tens = n % 100;
  if (last === 1 && tens !== 11) return 'запись ждёт';
  if (last >= 2 && last <= 4 && (tens < 12 || tens > 14)) return 'записи ждут';
  return 'записей ждут';
};

// Плашка статуса в списке несоответствий: уточнение — отдельный статус, а не «отклонено»
const findingBadge = (finding: Finding, isPending: boolean, isRetrain: boolean): { cls: string; label: string } => {
  if (isPending) return { cls: 'badge-amber', label: 'ОЖИДАЕТ' };
  if (finding.status === 'confirmed') return { cls: 'badge-green', label: isRetrain ? 'ОТПРАВЛЕНО' : 'ПОДТВЕРЖДЕНО' };
  if (finding.status === 'clarification') return finding.modelClarification ? { cls: 'badge-amber', label: 'ТРЕБУЕТ УТОЧНЕНИЯ' } : { cls: 'badge-slate', label: 'УТОЧНЕНО' };
  return { cls: 'badge-red', label: isRetrain ? 'НЕ ОТПРАВЛЕНО' : 'ОТКЛОНЕНО' };
};

// Порядок причин в меню отклонения: цифры 1–8 выбирают их с клавиатуры
const HOTKEYS_RETRAIN: Array<[string, string]> = [
  ['1', 'Отправить на дообучение (затем комментарий для модели)'],
  ['2', 'Не отправлять'],
  ['Enter', 'Подтвердить отправку в поле комментария; Shift + Enter новая строка'],
  ['← →', 'Предыдущая и следующая запись'],
  ['N', 'К следующей записи без решения'],
  ['PgUp PgDn', 'Страница назад и вперёд во всех панелях сразу (если в документе больше одной страницы)'],
  ['F', 'Во весь экран и обратно'],
  ['Esc', 'Закрыть форму комментария или выйти из полноэкранного режима'],
  ['Shift + /', 'Эта подсказка'],
];

const HOTKEYS: Array<[string, string]> = [
  ['1', 'Подтвердить нарушение (у гипотезы: сделать кандидатом)'],
  ['2', 'Отклонить: у кандидата затем 1–8 причина, у гипотезы комментарий'],
  ['3', 'Уточнить (то же у гипотезы)'],
  ['← →', 'Предыдущий и следующий кандидат'],
  ['N', 'К следующему кандидату без решения'],
  ['PgUp PgDn', 'Страница назад и вперёд во всех панелях сразу (если в документе больше одной страницы)'],
  ['E', 'Править доказательства'],
  ['S', 'Разделить на части (у составного несоответствия)'],
  ['Enter', 'Отправить решение с комментарием (отклонение, уточнение) или создать кандидата из гипотезы; Shift + Enter новая строка'],
  ['F', 'Во весь экран и обратно'],
  ['Esc', 'Выйти из полноэкранного режима, закрыть правку доказательств, список причин, форму комментария (у кандидата и у гипотезы) или сбросить массовый выбор'],
  ['Shift + /', 'Эта подсказка'],
];

const REJECT_KEYS = Object.keys(REJECT_REASON) as RejectReason[];

// Рамки по роли фрагмента: ожидаемое (эталон) — синяя, фактическое — оранжевая, контекст — серая пунктиром
const ROLE_COLORS: Record<EvidenceRole, string> = { EXPECTED: '#2450C7', ACTUAL: '#B4620B', CONTEXT: '#667085' };

type PendingDecision = { kind: 'reject'; reason: RejectReason } | { kind: 'clarify' } | null;

interface PanelStage {
  key: string;
  src?: Source;
}

// Та же форма, что у остальных кнопок проверки: радиус 8, высота 32, текст по центру
const BUTTON_BASE_STYLE: React.CSSProperties = {
  boxSizing: 'border-box',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: 32,
  borderRadius: '8px',
  padding: '0 14px',
  fontSize: '13px',
  fontWeight: 600,
  lineHeight: 1,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const TEAL_BUTTON_STYLE: React.CSSProperties = {
  ...BUTTON_BASE_STYLE,
  backgroundColor: '#12988C',
  color: '#FFFFFF',
  border: 'none',
};

const WHITE_BUTTON_STYLE: React.CSSProperties = {
  ...BUTTON_BASE_STYLE,
  backgroundColor: '#FFFFFF',
  color: '#101828',
  border: '1px solid #CBD3DE',
};

const RETRAIN_TO_FINDING_STATUS: Record<RetrainStatus, Finding['status']> = {
  pending: 'CANDIDATE',
  sent: 'confirmed',
  skipped: 'rejected',
};

const mockFindings: Finding[] = [
  {
    finding_id: 'F-ALT79B-002',
    code: 'M-002',
    parameter_name: 'Общая площадь и экспликация помещений',
    section: 'Архитектурные решения',
    review_priority: 'HIGH',
    description: 'Расхождение в площади помещения: комната 8.0 м² (ПД АР стр. 19-20) → 7.2 м² (РД-2025-04-266-АР2 стр. 4).',
    sources: {
      pd: { page: 19, totalPages: 20, value: '8.0 м²', docName: '25-014-ПД.pdf, ред. 3, Утверждён', bbox: { x: 15, y: 25, w: 30, h: 15 } },
      rd: { page: 4, totalPages: 8, value: '7.2 м²', docName: '25-014-РД.pdf, ред. РД-2, Готово', bbox: { x: 20, y: 30, w: 28, h: 14 } },
    },
    status: 'CANDIDATE',
  },
  {
    finding_id: 'F-ALT79B-055',
    code: 'M-055',
    parameter_name: 'Класс бетона',
    section: 'Конструктивные решения',
    review_priority: 'MEDIUM',
    description: 'Класс бетона фундаментной плиты изменён с B30 (ПД КР) на B25 (РД КЖ01).',
    sources: {
      pd: { page: 8, totalPages: 12, value: 'B30', docName: '25-014-ПД.pdf, ред. 3, Утверждён', bbox: { x: 45, y: 50, w: 20, h: 8 } },
      rd: { page: 8, totalPages: 15, value: 'B25', docName: '25-014-РД.pdf, ред. РД-2, Готово', bbox: { x: 45, y: 50, w: 20, h: 8 } },
    },
    gost_reference: 'ГОСТ 26633-2015',
    status: 'CANDIDATE',
  },
];

export const VerificationPage: React.FC = () => {
  const { message, modal } = App.useApp();
  const { object_id: paramObjectId, projectId } = useParams<{ object_id?: string; projectId?: string }>();
  const navigate = useNavigate();
  const panelsRef = React.useRef<HTMLDivElement>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  const queryObjectId = searchParams.get('object');
  const object_id = projectId || paramObjectId || queryObjectId;

  const queryClient = useQueryClient();
  const { projects, source: dataSource, isLoading: projectsLoading } = useProjects();
  const { user } = useAuth();
  const project = projects.find((p) => p.id === object_id);
  const apiMode = dataSource === 'api';
  // Решения, разделение и завершение проверки api разрешает только инспектору и супервизору; администратор и ML-инженер смотрят
  const canDecide = !apiMode || user?.role === 'INSPECTOR' || user?.role === 'SUPERVISOR';
  const projectName = project?.name ?? 'Жилой комплекс "Алтуфьево"';

  // Несоответствия текущей версии протокола из api; демо-набор — только в явном демо-режиме
  const processId = apiMode ? project?.processId : null;
  const processStatus = useProcessStatus(processId);
  const protocolId = processStatus.data?.current_protocol_id;
  const filesQuery = useProcessFiles(processId, processStatus.data?.updated_at);

  // Режим администратора: разбор отклонённых инспектором несоответствий перед дообучением модели
  const isRetrain = searchParams.get('mode') === 'retrain';
  const suspicionsQ = useSuspicions(apiMode && !isRetrain ? processId : null);
  const focusFindingId = searchParams.get('finding');
  const retrainApi = useRetrainItems(apiMode && isRetrain);

  // Запись для дообучения принадлежит той версии протокола, где инспектор принял решение. Если проект потом пересчитали,
  // в текущей версии её несоответствия уже нет, поэтому в режиме разбора загружаем версии самих записей.
  const retrainRawFindingIds = React.useMemo(
    () => retrainApi.items.filter((item) => (!object_id || item.projectId === object_id) && item.findingId).map((item) => item.findingId),
    [retrainApi.items, object_id]
  );
  const findingProtocols = useFindingProtocolIds(apiMode && isRetrain ? retrainRawFindingIds : []);
  const retrainProtocolIds = React.useMemo(() => {
    const ids = [...new Set(findingProtocols.protocolIds.values())];
    return ids.length > 0 ? ids : protocolId ? [protocolId] : [];
  }, [findingProtocols.protocolIds, protocolId]);
  const currentFindings = useProtocolFindings(isRetrain && apiMode ? undefined : protocolId);
  const retrainFindings = useProtocolsFindings(apiMode && isRetrain && !findingProtocols.isLoading ? retrainProtocolIds : []);
  const findingsQuery: { data: ApiFinding[] | undefined; isLoading: boolean; isSuccess: boolean } =
    apiMode && isRetrain
      ? { data: retrainFindings.data, isLoading: findingProtocols.isLoading || retrainFindings.isLoading, isSuccess: retrainFindings.isSuccess }
      : currentFindings;
  // Демо-режим: очередь из localStorage; api: записи GOLD-набора этого проекта, комментарий инспектора берётся из его решения
  const [localRetrainItems, setLocalRetrainItems] = React.useState<RetrainItem[]>(() =>
    loadRetrainQueue().filter((item) => !object_id || item.projectId === object_id)
  );
  const retrainItems = React.useMemo<RetrainItem[]>(() => {
    if (!apiMode) return localRetrainItems;
    const findingById = new Map((findingsQuery.data ?? []).map((f) => [f.id, f]));
    return retrainApi.items
      // В разбор попадают и отклонённые инспектором кандидаты, и подтверждённые нарушения — оба вида дают
      // запись GOLD-набора (`gold_label`: NEGATIVE / POSITIVE), обе нужно одобрить или исключить (REQ-ML-02)
      .filter((item) => !object_id || item.projectId === object_id)
      .map((item) => {
        const decision = findingById.get(item.findingId)?.decision;
        return { ...item, inspectorComment: decision?.comment ?? '', reasonCode: item.reasonCode ?? ((decision?.reason_code as RetrainItem['reasonCode']) || undefined) };
      });
  }, [apiMode, localRetrainItems, retrainApi.items, findingsQuery.data, object_id]);
  // Разбор для дообучения (сравнение листов): чужие несоответствия того же протокола скрываются — видны только эти
  const retrainFindingIds = React.useMemo(() => new Set(retrainItems.map((item) => item.findingId)), [retrainItems]);
  const [retrainComment, setRetrainComment] = React.useState('');
  const [showRetrainForm, setShowRetrainForm] = React.useState(false);
  // Решение по записи можно поменять: «Изменить решение» снова открывает кнопки
  const [retrainChanging, setRetrainChanging] = React.useState(false);

  const [findings, setFindings] = React.useState<Finding[]>(() =>
    isRetrain
      ? retrainItems.flatMap((item) => {
          const base = mockFindings.find((f) => f.finding_id === item.findingId);
          return base ? [{ ...base, status: RETRAIN_TO_FINDING_STATUS[item.status] }] : [];
        })
      : dataSource === 'api'
        ? []
        : mockFindings
  );
  const [deciding, setDeciding] = React.useState(false);
  // Выбранное несоответствие держим по id: после решения сервер отдаёт список в другом порядке (решённые уходят в конец),
  // и индекс, посчитанный по прежнему порядку, указывал бы уже на другого кандидата
  const selectedIdRef = React.useRef<string | undefined>(undefined);
  const [pageCounts, setPageCounts] = React.useState<Record<string, number>>({});

  React.useEffect(() => {
    if (isRetrain) return;
    if (!apiMode) {
      setFindings(mockFindings);
      return;
    }
    if (findingsQuery.data && filesQuery.data) {
      const next = findingsQuery.data.filter(isVerifiable).map((f) => toFinding(f, filesQuery.data));
      setFindings(next);
      const keep = next.findIndex((f) => f.finding_id === selectedIdRef.current);
      if (keep >= 0) setCurrentIndex(keep);
    }
  }, [isRetrain, apiMode, findingsQuery.data, filesQuery.data]);
  // Разбор дообучения на api: несоответствия проекта, по которым есть записи; статус — решение администратора по записи
  React.useEffect(() => {
    if (!isRetrain || !apiMode || !findingsQuery.data || !filesQuery.data) return;
    const all = findingsQuery.data;
    const files = filesQuery.data;
    setFindings(
      retrainItems.flatMap((item) => {
        const f = all.find((x) => x.id === item.findingId);
        return f ? [{ ...toFinding(f, files), status: RETRAIN_TO_FINDING_STATUS[item.status] }] : [];
      })
    );
  }, [isRetrain, apiMode, retrainItems, findingsQuery.data, filesQuery.data]);
  const [currentIndex, setCurrentIndex] = React.useState(() => {
    if (!isRetrain || !focusFindingId) return 0;
    const index = retrainItems.findIndex((item) => item.findingId === focusFindingId);
    return index >= 0 ? index : 0;
  });
  // Ссылка с дашборда открывает нужную запись, когда список загрузился
  const focusedRetrainRef = React.useRef(false);
  React.useEffect(() => {
    if (!isRetrain || !focusFindingId || focusedRetrainRef.current || findings.length === 0) return;
    const index = findings.findIndex((f) => f.finding_id === focusFindingId);
    if (index >= 0) {
      setCurrentIndex(index);
      focusedRetrainRef.current = true;
    }
  }, [isRetrain, focusFindingId, findings]);
  const [comment, setComment] = React.useState('');
  // Решение за ≤ 3 действия: причина отклонения выбирается из меню и сразу сохраняет решение
  const [rejectMenuOpen, setRejectMenuOpen] = React.useState(false);
  // Отклонение и уточнение требуют комментария: после выбора причины (или нажатия «Уточнить») появляется поле
  const [pendingDecision, setPendingDecision] = React.useState<PendingDecision>(null);
  // Документ согласования: только для причины отклонения «Согласованное изменение», необязательное поле
  const [approvedChangeRef, setApprovedChangeRef] = React.useState('');
  // Навигатор: только несоответствия, у которых есть доказательство на показанных сейчас страницах
  const [onlyThisPage, setOnlyThisPage] = React.useState(false);
  const [splitOpen, setSplitOpen] = React.useState(false);
  const [splitting, setSplitting] = React.useState(false);
  // Правка доказательств: нарисованные рамки и убранные фрагменты копятся здесь до сохранения
  const [editMode, setEditMode] = React.useState(false);
  const [draftAdd, setDraftAdd] = React.useState<DraftFragment[]>([]);
  const [draftRemove, setDraftRemove] = React.useState<string[]>([]);
  const [savingEvidence, setSavingEvidence] = React.useState(false);
  // Центр: три панели документов или режим «Сравнение листов»
  // `?view=compare` открывает сразу сравнение листов (переход из протокола к гипотезам)
  const [centerMode, setCenterMode] = React.useState<'panels' | 'compare'>(() => (searchParams.get('view') === 'compare' ? 'compare' : 'panels'));
  // Гипотезы в одном списке с кандидатами: выбрана либо гипотеза, либо кандидат
  const [selectedSuspicionId, setSelectedSuspicionId] = React.useState<string | undefined>(undefined);
  const [promotingId, setPromotingId] = React.useState<string | undefined>(undefined);
  const [hypDrafts, setHypDrafts] = React.useState<DraftFragment[]>([]);
  // Разделы фильтра: у кандидатов и у гипотез свои фильтры, заголовок раздела скрывает его группу в списке
  const [showCandidates, setShowCandidates] = React.useState(true);
  const [showHypotheses, setShowHypotheses] = React.useState(true);
  const [hypFilter, setHypFilter] = React.useState<SuspicionFilter>('all');
  // `?view=hypotheses` (уведомление, протокол): открыть гипотезу, ждущую решения; адрес после этого очищается
  const [wantHypothesis, setWantHypothesis] = React.useState(() => searchParams.get('view') === 'hypotheses');
  const viewParam = searchParams.get('view');
  React.useEffect(() => {
    if (viewParam === 'hypotheses') {
      setWantHypothesis(true);
      const next = new URLSearchParams(searchParams);
      next.delete('view');
      setSearchParams(next, { replace: true });
    } else if (viewParam === 'compare') {
      setCenterMode('compare');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewParam]);
  const [pendingSelectId, setPendingSelectId] = React.useState<string | undefined>(undefined);
  // Массовое решение: отмеченные кандидаты одного параметра
  const [bulkSelected, setBulkSelected] = React.useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [bulkClarify, setBulkClarify] = React.useState(false);
  const [bulkComment, setBulkComment] = React.useState('');
  const commentAreaRef = React.useRef<HTMLDivElement>(null);
  const commentAreaFullscreenRef = React.useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  const [fullscreenEvidence] = React.useState(false);
  const [zoom, setZoom] = React.useState<Record<string, number>>({});
  // Масштаб и сдвиг всех панелей меняются вместе; выключатель даёт двигать каждую отдельно
  const [syncPanels, setSyncPanels] = React.useState(true);
  // Рамки доказательства (синяя/оранжевая/серая) можно временно скрыть, если они закрывают сам документ
  const [showMarks, setShowMarks] = React.useState(true);
  const [filterTab, setFilterTab] = React.useState<'all' | 'pending' | 'confirmed' | 'rejected' | 'clarified' | 'candidate'>('pending');
  const [searchQuery, setSearchQuery] = React.useState('');
  // Раздел проекта (ПЗ, АР, КР…): на протоколе из ~132 точек список иначе не обозреть
  const [sectionFilter, setSectionFilter] = React.useState('');
  const [showFindingsPanel, setShowFindingsPanel] = React.useState(true);
  const [showEvidencePanel, setShowEvidencePanel] = React.useState(true);
  const [showVerificationWindow, setShowVerificationWindow] = React.useState(false);
  const [findingsPanelPosition, setFindingsPanelPosition] = React.useState({ x: 0, y: 0 });
  const [evidencePanelPosition, setEvidencePanelPosition] = React.useState({ x: 0, y: 0 });
  const [draggingPanel, setDraggingPanel] = React.useState<'findings' | 'evidence' | null>(null);
  const [panelDragStart, setPanelDragStart] = React.useState<{ x: number; y: number } | null>(null);
  const [currentPages, setCurrentPages] = React.useState<Record<string, number>>({});
  const [panOffset, setPanOffset] = React.useState<Record<string, { x: number; y: number }>>({});
  const [isDragging, setIsDragging] = React.useState<string | null>(null);
  const dragRef = React.useRef<{ stageKey: string; x: number; y: number; pan: { x: number; y: number }; el: HTMLElement } | null>(null);

  const currentFinding = findings[currentIndex] || findings[0];
  selectedIdRef.current = currentFinding?.finding_id;
  const totalFindings = findings.length;
  const pendingFindings = findings.filter((f) => f.status === 'CANDIDATE');
  // Вкладка «Ожидают» включает и «требуется уточнение» от модели: они тоже ждут решения инспектора, хотя в прогресс не входят
  const tabPendingFindings = findings.filter(isAwaitingDecision);
  const pendingCount = tabPendingFindings.length;
  React.useEffect(() => {
    if (filterTab !== 'pending' || findings.length === 0) return;
    if (pendingCount === 0 || (currentFinding && !isAwaitingDecision(currentFinding))) setFilterTab('all');
  }, [filterTab, findings.length, pendingCount, currentFinding]);
  const candidateFindings = findings.filter((f) => f.status === 'CANDIDATE');
  const confirmedFindings = findings.filter((f) => f.status === 'confirmed');
  const rejectedFindings = findings.filter((f) => f.status === 'rejected');
  const clarifiedFindings = findings.filter((f) => f.status === 'clarification');
  // «Требуется уточнение» от модели видны во вкладке «Ожидают», но в прогресс проверки не входят: решения инспектора по ним ещё нет
  const modelClarifiedCount = clarifiedFindings.filter((f) => f.modelClarification).length;
  const inspectorClarifiedCount = clarifiedFindings.length - modelClarifiedCount;
  const progressTotal = totalFindings - modelClarifiedCount;
  const hypothesesOn = apiMode && !isRetrain;
  const suspicionList = React.useMemo(() => suspicionsQ.data ?? [], [suspicionsQ.data]);
  const selectedSuspicion = suspicionList.find((x) => x.suspicion_id === selectedSuspicionId);
  const isFinalizedProject = !isRetrain && apiMode && processStatus.data?.status === 'FINALIZED';
  const allProcessed = pendingFindings.length === 0;

  // Три панели всегда: у стадии без доказательств показываем «нет доказательств» и «Дозагрузить»
  const panelStages = React.useMemo<PanelStage[]>(() => {
    if (!currentFinding) return [];
    return [
      { key: 'ПД', src: currentFinding.sources.pd },
      { key: 'РД', src: currentFinding.sources.rd },
      { key: 'ИД', src: currentFinding.sources.id_ },
    ];
  }, [currentFinding]);
  const panelColumns = panelStages.map((s) => (s.src ? 'minmax(0, 1fr)' : 'minmax(170px, 0.45fr)')).join(' ') || '1fr';

  const presentStages = React.useMemo(() => {
    if (!currentFinding) return [];
    return [
      currentFinding.sources.pd && { key: 'ПД', src: currentFinding.sources.pd },
      currentFinding.sources.rd && { key: 'РД', src: currentFinding.sources.rd },
      currentFinding.sources.id_ && { key: 'ИД', src: currentFinding.sources.id_ },
    ].filter(Boolean) as Array<{ key: string; src: Source }>;
  }, [currentFinding]);

  React.useEffect(() => {
    if (commentAreaRef.current && comment) {
      commentAreaRef.current.scrollTop = commentAreaRef.current.scrollHeight;
    }
  }, [comment]);

  React.useEffect(() => {
    if (commentAreaFullscreenRef.current && comment) {
      commentAreaFullscreenRef.current.scrollTop = commentAreaFullscreenRef.current.scrollHeight;
    }
  }, [comment]);

  const filteredFindings = React.useMemo(() => {
    let result = sectionFilter ? findings.filter((f) => f.section === sectionFilter) : findings;

    if (filterTab === 'pending') {
      result = result.filter(isAwaitingDecision);
    } else if (filterTab === 'confirmed') {
      result = result.filter(f => f.status === 'confirmed');
    } else if (filterTab === 'rejected') {
      result = result.filter(f => f.status === 'rejected');
    } else if (filterTab === 'clarified') {
      result = result.filter(f => f.status === 'clarification' && !f.modelClarification);
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(f =>
        f.code.toLowerCase().includes(q) ||
        f.parameter_name.toLowerCase().includes(q)
      );
    }

    if (onlyThisPage && currentFinding) {
      // Файл и страница, которые сейчас видны в панелях текущего несоответствия
      const shown = (['ПД', 'РД', 'ИД'] as const).flatMap((key) => {
        const src = key === 'ПД' ? currentFinding.sources.pd : key === 'РД' ? currentFinding.sources.rd : currentFinding.sources.id_;
        return src?.fileId ? [{ fileId: src.fileId, page: currentPages[key] ?? src.page }] : [];
      });
      result = result.filter(
        (f) =>
          f.finding_id === currentFinding.finding_id ||
          [f.sources.pd, f.sources.rd, f.sources.id_].some((src) => src?.marks?.some((m) => shown.some((p) => p.fileId === src.fileId && p.page === m.page)))
      );
    }

    return result;
  }, [findings, filterTab, searchQuery, sectionFilter, onlyThisPage, currentFinding, currentPages]);

  const sectionCounts = React.useMemo(() => {
    const counts = new Map<string, number>();
    findings.forEach((f) => f.section && counts.set(f.section, (counts.get(f.section) ?? 0) + 1));
    return Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b, 'ru'));
  }, [findings]);
  const shownFindings = React.useMemo(() => (showCandidates ? filteredFindings : []), [showCandidates, filteredFindings]);
  const shownSuspicions = React.useMemo(
    () => (hypothesesOn && showHypotheses ? filterSuspicions(suspicionList, hypFilter, searchQuery) : []),
    [hypothesesOn, showHypotheses, suspicionList, hypFilter, searchQuery]
  );
  // Порядок перехода по списку (← / →): сначала кандидаты, затем гипотезы
  const visibleItems = React.useMemo(
    () => [...shownFindings.map((f) => `f:${f.finding_id}`), ...shownSuspicions.map((x) => `s:${x.suspicion_id}`)],
    [shownFindings, shownSuspicions]
  );
  const currentItemKey = selectedSuspicionId ? `s:${selectedSuspicionId}` : currentFinding ? `f:${currentFinding.finding_id}` : '';

  React.useEffect(() => {
    if (commentAreaRef.current) {
      commentAreaRef.current.scrollTop = commentAreaRef.current.scrollHeight;
    }
  }, [comment]);

  React.useEffect(() => {
    if (commentAreaFullscreenRef.current) {
      commentAreaFullscreenRef.current.scrollTop = commentAreaFullscreenRef.current.scrollHeight;
    }
  }, [comment]);

  const handleDecision = React.useCallback(
    async (decision: 'confirmed' | 'rejected' | 'clarification', reason?: RejectReason) => {
      if (decision === 'rejected' && !reason) {
        return;
      }
      const target = findings[currentIndex];
      if (!target || deciding) return;

      // Комментарий обязателен при отклонении и уточнении
      const typed = comment.trim();
      if (decision !== 'confirmed' && !typed) return;
      const finalComment = typed || undefined;

      if (apiMode && !isRetrain) {
        setDeciding(true);
        try {
          await decideFinding(target.finding_id, {
            action: decision === 'confirmed' ? 'CONFIRM' : decision === 'rejected' ? 'REJECT' : 'CLARIFY',
            reason_code: decision === 'rejected' ? reason : undefined,
            comment: finalComment,
            approved_change_ref: decision === 'rejected' && reason === 'APPROVED_CHANGE' && approvedChangeRef.trim() ? approvedChangeRef.trim() : undefined,
          });
        } catch (error) {
          message.error(error instanceof Error ? error.message : 'Не удалось сохранить решение');
          setDeciding(false);
          return;
        }
        setDeciding(false);
        // Решение можно исправить сразу: ссылка возвращает к этому же кандидату (по id, порядок списка после обновления другой)
        const decidedId = target.finding_id;
        message.success({
          key: 'decision-saved',
          duration: 5,
          content: (
            <span>
              Решение сохранено.{' '}
              <a
                role="button"
                onClick={() => {
                  message.destroy('decision-saved');
                  setSelectedSuspicionId(undefined);
                  setPendingSelectId(decidedId);
                }}
              >
                Вернуться к этому кандидату
              </a>
            </span>
          ),
        });
        void queryClient.invalidateQueries({ queryKey: ['protocol-findings'] });
        void queryClient.invalidateQueries({ queryKey: ['process-status'] });
        void queryClient.invalidateQueries({ queryKey: ['projects'] });
      }

      const updatedFindings = [...findings];
      updatedFindings[currentIndex] = {
        ...updatedFindings[currentIndex],
        status: decision,
        inspector_comment: finalComment,
        reason_code: decision === 'rejected' ? reason : undefined,
        // Решение инспектора принято: запись больше не «требует уточнения» от модели
        modelClarification: undefined,
      };
      setFindings(updatedFindings);
      setComment('');
      setPendingDecision(null);
      setRejectMenuOpen(false);

      // Идём дальше по тому же виду записей: после кандидата к следующему кандидату, после «требуется уточнение» к следующей
      // такой же записи; необязательные записи не затягивают инспектора, который закончил с кандидатами
      const wasModelClarification = Boolean(target.modelClarification);
      const inSameGroup = (f: Finding) => (wasModelClarification ? f.status === 'clarification' && Boolean(f.modelClarification) : f.status === 'CANDIDATE');
      const remainingPending = updatedFindings.filter(inSameGroup);

      // После последнего решения остаёмся в верификации: решение можно изменить, а проверку завершить в протоколе
      if (remainingPending.length === 0) {
        message.success(
          wasModelClarification
            ? 'Все записи «требуется уточнение» разобраны. Решения можно изменить здесь.'
            : 'Все кандидаты обработаны. Решения можно изменить здесь, завершить проверку: в протоколе.'
        );
        return;
      }

      const nextPendingIndex = updatedFindings.findIndex((f, idx) => idx > currentIndex && inSameGroup(f));

      if (nextPendingIndex !== -1) {
        setCurrentIndex(nextPendingIndex);
      } else {
        const prevPendingIndex = updatedFindings.findIndex(inSameGroup);
        if (prevPendingIndex !== -1 && prevPendingIndex !== currentIndex) {
          setCurrentIndex(prevPendingIndex);
        }
      }
    },
    [findings, currentIndex, comment, approvedChangeRef, apiMode, isRetrain, deciding, queryClient, message]
  );

  const handleChangeDecision = React.useCallback(() => {
    const updatedFindings = [...findings];
    updatedFindings[currentIndex] = {
      ...updatedFindings[currentIndex],
      status: 'CANDIDATE',
      inspector_comment: undefined,
      reason_code: undefined,
    };
    setFindings(updatedFindings);
    setComment('');
    setPendingDecision(null);
  }, [findings, currentIndex]);

  const currentRetrainItem = retrainItems.find((item) => item.findingId === currentFinding?.finding_id);

  const handleRetrainDecision = async (status: Exclude<RetrainStatus, 'pending'>) => {
    if (!currentRetrainItem) return;
    if (apiMode) {
      try {
        await curateDatasetItem(currentRetrainItem.id, status === 'sent' ? 'APPROVED' : 'EXCLUDED', retrainComment);
      } catch (error) {
        message.error(error instanceof Error ? error.message : 'Не удалось сохранить решение');
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ['dataset-items'] });
      // Та же запись в списке страницы «Дообучение»
      void queryClient.invalidateQueries({ queryKey: ['ml-dataset-items'] });
    } else {
      const queue = updateRetrainItem(currentRetrainItem.id, {
        status,
        modelComment: status === 'sent' ? retrainComment.trim() : undefined,
        decidedAt: new Date().toISOString(),
      });
      setLocalRetrainItems(queue.filter((item) => !object_id || item.projectId === object_id));
    }
    setRetrainChanging(false);

    const updatedFindings = findings.map((f) =>
      f.finding_id === currentRetrainItem.findingId ? { ...f, status: RETRAIN_TO_FINDING_STATUS[status] } : f
    );
    setFindings(updatedFindings);
    setRetrainComment('');
    setShowRetrainForm(false);
    message.success(status === 'sent' ? 'Отправлено на дообучение модели' : 'Не отправлено на дообучение');

    const nextPending = updatedFindings.findIndex((f, idx) => idx > currentIndex && f.status === 'CANDIDATE');
    const anyPending = updatedFindings.findIndex((f) => f.status === 'CANDIDATE');
    if (nextPending !== -1) {
      setCurrentIndex(nextPending);
    } else if (anyPending !== -1) {
      setCurrentIndex(anyPending);
    } else {
      navigate('/dashboard');
    }
  };

  // Другая запись: решение и комментарий начинаются заново
  const retrainItemId = currentRetrainItem?.id;
  React.useEffect(() => {
    setRetrainChanging(false);
    setShowRetrainForm(false);
    setRetrainComment('');
  }, [retrainItemId]);

  const handleRetrainReopen = () => {
    if (!currentRetrainItem) return;
    // На api запись нельзя вернуть в «ожидает» — можно принять другое решение (пока набор не выпущен)
    if (apiMode) {
      setRetrainChanging(true);
      return;
    }
    const queue = updateRetrainItem(currentRetrainItem.id, {
      status: 'pending',
      modelComment: undefined,
      decidedAt: undefined,
    });
    setLocalRetrainItems(queue.filter((item) => !object_id || item.projectId === object_id));
    setFindings(
      findings.map((f) =>
        f.finding_id === currentRetrainItem.findingId ? { ...f, status: 'CANDIDATE' as const } : f
      )
    );
    setRetrainComment('');
    setShowRetrainForm(false);
  };

  // Когда в области решения появляется форма или комментарий, сразу прокручиваем область вниз
  const currentAwaiting = Boolean(currentFinding && isAwaitingDecision(currentFinding));
  React.useEffect(() => {
    if (!pendingDecision && !showRetrainForm && currentAwaiting) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      document.querySelectorAll<HTMLElement>('.vw-col-evidence-scroll').forEach((el) => {
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingDecision, showRetrainForm, currentAwaiting, currentFinding?.status, currentFinding?.finding_id]);

  // «Отклонить» открывает меню причин; выбор причины сразу сохраняет решение
  const handleReject = React.useCallback(() => {
    setRejectMenuOpen((prev) => !prev);
  }, []);

  // «Уточнить» открывает поле комментария (обязательного)
  const handleClarification = React.useCallback(() => {
    setRejectMenuOpen(false);
    setComment('');
    setPendingDecision((prev) => (prev?.kind === 'clarify' ? null : { kind: 'clarify' }));
  }, []);

  // Причина выбрана: подставляем шаблон комментария; инспектор правит его и отправляет решение
  const chooseRejectReason = React.useCallback((reason: RejectReason) => {
    setRejectMenuOpen(false);
    setComment(reason === 'OTHER' ? '' : REJECT_TEMPLATES[reason]);
    setApprovedChangeRef('');
    setPendingDecision({ kind: 'reject', reason });
  }, []);

  const canEditEvidence = apiMode && canDecide && !isRetrain;

  // Открыть несоответствие по id (клик по красной области, кандидат из гипотезы): пока его нет в списке, ждём обновления
  const selectFindingById = (id: string) => {
    const index = findings.findIndex((f) => f.finding_id === id);
    if (index >= 0) {
      setSelectedSuspicionId(undefined);
      setCurrentIndex(index);
    } else setPendingSelectId(id);
  };
  React.useEffect(() => {
    if (!pendingSelectId) return;
    const index = findings.findIndex((f) => f.finding_id === pendingSelectId);
    if (index >= 0) {
      setSelectedSuspicionId(undefined);
      setCurrentIndex(index);
      setPendingSelectId(undefined);
    }
  }, [pendingSelectId, findings]);

  // Другая гипотеза: перевод в кандидата начинается заново, нарисованные рамки относились к прежней
  React.useEffect(() => {
    setPromotingId(undefined);
    setHypDrafts([]);
  }, [selectedSuspicionId]);

  // Открыть гипотезу, ждущую решения: по ссылке из уведомления или протокола; если кандидатов нет — сразу
  React.useEffect(() => {
    if (!hypothesesOn || !suspicionsQ.isSuccess) return;
    if (wantHypothesis) {
      const target = suspicionList.find((x) => x.inspector_status === 'PENDING' || x.inspector_status === 'CLARIFICATION_REQUIRED') ?? suspicionList[0];
      if (target) {
        setShowHypotheses(true);
        setHypFilter('all');
        setSelectedSuspicionId(target.suspicion_id);
      }
      setWantHypothesis(false);
      return;
    }
    const noCandidates = findingsQuery.isSuccess && !(findingsQuery.data ?? []).some(isVerifiable);
    if (noCandidates && !selectedSuspicionId && suspicionList.length > 0) setSelectedSuspicionId(suspicionList[0].suspicion_id);
  }, [hypothesesOn, suspicionsQ.isSuccess, suspicionList, wantHypothesis, findingsQuery.isSuccess, findingsQuery.data, selectedSuspicionId]);

  // Выбранная строка списка всегда на виду
  React.useEffect(() => {
    document.querySelector('.vw-findings-list .finding-item.selected')?.scrollIntoView({ block: 'nearest' });
  }, [selectedSuspicionId, currentIndex, suspicionList.length]);

  const bulkEnabled = apiMode && canDecide && !isRetrain;

  // Отметка снимается, когда кандидат получил решение или пропал из списка
  React.useEffect(() => {
    setBulkSelected((prev) => {
      const next = prev.filter((id) => findings.some((f) => f.finding_id === id && isBulkCandidate(f)));
      return next.length === prev.length ? prev : next;
    });
  }, [findings]);

  const selectedFindings = findings.filter((f) => bulkSelected.includes(f.finding_id));

  const toggleBulk = (finding: Finding) => {
    setBulkSelected((prev) => (prev.includes(finding.finding_id) ? prev.filter((id) => id !== finding.finding_id) : [...prev, finding.finding_id]));
  };

  const clearBulk = () => {
    setBulkSelected([]);
    setBulkClarify(false);
    setBulkComment('');
  };

  const runBulk = async (action: 'CONFIRM' | 'CLARIFY', text?: string) => {
    const ids = [...bulkSelected];
    setBulkBusy(true);
    try {
      await bulkDecideFindings(ids, action, text);
      message.success(action === 'CONFIRM' ? `Подтверждено нарушений: ${ids.length}` : `Отправлено на уточнение: ${ids.length}`);
      clearBulk();
      void queryClient.invalidateQueries({ queryKey: ['protocol-findings'] });
      void queryClient.invalidateQueries({ queryKey: ['process-status'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось применить массовое решение');
    } finally {
      setBulkBusy(false);
    }
  };

  const confirmBulk = () => {
    const code = selectedFindings[0]?.code ?? '';
    modal.confirm({
      title: `Подтвердить нарушений: ${selectedFindings.length}?`,
      content: `Параметр ${code}. Каждый кандидат получит решение «Подтверждено», отменить можно по одному: «Изменить решение».`,
      okText: 'Подтвердить',
      cancelText: 'Отмена',
      onOk: () => runBulk('CONFIRM'),
    });
  };

  const cancelEdit = () => {
    setEditMode(false);
    setDraftAdd([]);
    setDraftRemove([]);
  };
  const toggleEdit = () => (editMode ? cancelEdit() : setEditMode(true));
  const toggleEditRef = React.useRef(toggleEdit);
  toggleEditRef.current = toggleEdit;
  const editModeRef = React.useRef(editMode);
  editModeRef.current = editMode;

  // Правка относится к одному несоответствию: при переходе к другому черновик сбрасывается
  React.useEffect(() => {
    setEditMode(false);
    setDraftAdd([]);
    setDraftRemove([]);
  }, [currentFinding?.finding_id]);

  const canEditEvidenceRef = React.useRef(canEditEvidence);
  canEditEvidenceRef.current = canEditEvidence;

  const handleSaveEvidence = async (reason: string, reference: string) => {
    if (!currentFinding) return;
    setSavingEvidence(true);
    try {
      await editEvidence(currentFinding.finding_id, { added: draftAdd, removedIds: draftRemove, reason, reference });
      message.success('Правка сохранена: новая версия доказательств, машинная остаётся в истории');
      cancelEdit();
      void queryClient.invalidateQueries({ queryKey: ['protocol-findings'] });
      void queryClient.invalidateQueries({ queryKey: ['protocol'] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось сохранить правку доказательств');
    } finally {
      setSavingEvidence(false);
    }
  };

  const handleSplit = async (parts: SplitPartValues[]) => {
    if (!currentFinding) return;
    setSplitting(true);
    try {
      await splitFinding(currentFinding.finding_id, parts);
      message.success(`Разделено на ${parts.length} части: решения принимаются по каждой`);
      setSplitOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['protocol-findings'] });
      void queryClient.invalidateQueries({ queryKey: ['process-status'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось разделить кандидата');
    } finally {
      setSplitting(false);
    }
  };

  const cancelPending = React.useCallback(() => {
    setPendingDecision(null);
    setComment('');
  }, []);

  const submitPending = () => {
    if (!pendingDecision || !comment.trim()) return;
    if (pendingDecision.kind === 'reject') void handleDecision('rejected', pendingDecision.reason);
    else void handleDecision('clarification');
  };

  // Новое несоответствие — форма комментария закрывается
  const currentFindingId = currentFinding?.finding_id;
  React.useEffect(() => {
    setPendingDecision(null);
    setComment('');
    setApprovedChangeRef('');
  }, [currentFindingId]);
  const pendingRef = React.useRef(pendingDecision);
  pendingRef.current = pendingDecision;
  const cancelPendingRef = React.useRef(cancelPending);
  cancelPendingRef.current = cancelPending;
  // Переход к предыдущему / следующему несоответствию списка (← / →)
  const selectRelative = (delta: number) => {
    const pos = visibleItems.indexOf(currentItemKey);
    const target = visibleItems[pos < 0 ? 0 : Math.min(Math.max(pos + delta, 0), visibleItems.length - 1)];
    if (!target) return;
    if (target.startsWith('s:')) setSelectedSuspicionId(target.slice(2));
    else {
      setSelectedSuspicionId(undefined);
      setCurrentIndex(findings.findIndex((f) => f.finding_id === target.slice(2)));
    }
  };
  const selectRelativeRef = React.useRef(selectRelative);
  selectRelativeRef.current = selectRelative;
  // К следующему кандидату без решения по текущему порядку списка (N): после него идёт круг сначала
  const selectNextPending = () => {
    const pendingIds = new Set(pendingFindings.map((f) => `f:${f.finding_id}`));
    const pos = visibleItems.indexOf(currentItemKey);
    const start = pos + 1;
    const ordered = [...visibleItems.slice(start), ...visibleItems.slice(0, start)];
    const target = ordered.find((key) => pendingIds.has(key) && key !== currentItemKey);
    if (!target) return;
    setSelectedSuspicionId(undefined);
    setPendingSelectId(target.slice(2));
  };
  const selectNextPendingRef = React.useRef(selectNextPending);
  selectNextPendingRef.current = selectNextPending;
  const showHotkeys = () =>
    modal.info({
      title: 'Горячие клавиши верификации',
      icon: null,
      okText: 'Закрыть',
      maskClosable: true,
      content: (
        <>
          <table className="vw-hotkeys">
            <tbody>
              {(isRetrain ? HOTKEYS_RETRAIN : HOTKEYS).map(([keys, action]) => (
                <tr key={keys}>
                  <td>
                    <kbd>{keys}</kbd>
                  </td>
                  <td>{action}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ marginTop: 12, opacity: 0.7, fontSize: 13 }}>Клавиши не работают, пока курсор стоит в поле ввода.</p>
        </>
      ),
    });
  const retrainKeysRef = React.useRef({ active: false, send: () => {}, skip: () => {}, close: () => {} });
  retrainKeysRef.current = {
    active: isRetrain && Boolean(currentRetrainItem) && (currentRetrainItem?.status === 'pending' || retrainChanging),
    send: () => setShowRetrainForm(true),
    skip: () => void handleRetrainDecision('skipped'),
    close: () => {
      setShowRetrainForm(false);
      setRetrainComment('');
    },
  };
  const showHotkeysRef = React.useRef(showHotkeys);
  showHotkeysRef.current = showHotkeys;
  const chooseRejectReasonRef = React.useRef(chooseRejectReason);
  chooseRejectReasonRef.current = chooseRejectReason;
  const rejectMenuOpenRef = React.useRef(rejectMenuOpen);
  rejectMenuOpenRef.current = rejectMenuOpen;
  const bulkSelectedRef = React.useRef(bulkSelected);
  bulkSelectedRef.current = bulkSelected;
  const clearBulkRef = React.useRef(clearBulk);
  clearBulkRef.current = clearBulk;

  const toggleFullscreen = React.useCallback(() => {
    if (!isFullscreen) {
      setIsFullscreen(true);
      setShowFindingsPanel(false);
      setShowEvidencePanel(false);
      setFindingsPanelPosition({ x: 0, y: 0 });
      setEvidencePanelPosition({ x: 0, y: 0 });
    } else {
      setIsFullscreen(false);
    }
  }, [isFullscreen]);

  // Ключ, под которым хранятся масштаб и сдвиг панели: общий при синхронизации, свой иначе
  const viewKey = React.useCallback((stageKey: string) => (syncPanels ? '*' : stageKey), [syncPanels]);

  // Новое несоответствие — панели снова открываются на странице доказательства в исходном масштабе
  const findingKey = currentFinding?.finding_id;
  React.useEffect(() => {
    setZoom({});
    setPanOffset({});
    setCurrentPages({});
  }, [findingKey]);

  const fitView = () => {
    setZoom({});
    setPanOffset({});
  };

  const pageOf = (stageKey: string, src: Source) => currentPages[stageKey] ?? src.page;
  const totalPagesOf = (src: Source) => (src.fileId ? pageCounts[src.fileId] : undefined) || src.totalPages || src.page;

  // PgUp / PgDn листают страницы во всех панелях сразу
  const shiftPages = (delta: number) => {
    const next = { ...currentPages };
    let moved = false;
    for (const stage of panelStages) {
      if (!stage.src) continue;
      const total = totalPagesOf(stage.src);
      const from = currentPages[stage.key] ?? stage.src.page;
      const to = Math.min(Math.max(from + delta, 1), total);
      if (to !== from) moved = true;
      next[stage.key] = to;
    }
    if (!moved) {
      // Без ответа клавиша выглядит сломанной: скажем, почему страница не сменилась
      message.info({ key: 'page-edge', content: delta > 0 ? 'Дальше страниц нет: это последняя страница документа' : 'Это первая страница документа' });
      return;
    }
    setCurrentPages(next);
  };
  const shiftPagesRef = React.useRef(shiftPages);
  shiftPagesRef.current = shiftPages;

  const handleWheel = React.useCallback((e: WheelEvent, stageKey: string) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -10 : 10;
    const key = viewKey(stageKey);
    setZoom((prev) => ({
      ...prev,
      [key]: Math.max(50, Math.min(400, (prev[key] || 100) + delta))
    }));
  }, [viewKey]);
  // Масштаб уменьшили: сдвиг, допустимый при большом масштабе, мог стать слишком большим, поэтому подтягиваем его к границам
  React.useEffect(() => {
    setPanOffset((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const key of Object.keys(prev)) {
        const el = document.querySelector<HTMLElement>(key === '*' ? '[data-zoom-stage]' : `[data-zoom-stage="${key}"]`);
        if (!el) continue;
        const c = clampPan(prev[key], zoom[key] || 100, el.offsetWidth, el.offsetHeight);
        if (c.x !== prev[key].x || c.y !== prev[key].y) {
          next[key] = c;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [zoom]);
  const handleWheelRef = React.useRef(handleWheel);
  handleWheelRef.current = handleWheel;

  // Масштаб колесом: обработчик не «пассивный» (React вешает wheel пассивным, и preventDefault в нём даёт ошибку в консоли)
  React.useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const area = (e.target as Element | null)?.closest?.('[data-zoom-stage]');
      const stageKey = area?.getAttribute('data-zoom-stage');
      if (stageKey) handleWheelRef.current(e, stageKey);
    };
    document.addEventListener('wheel', onWheel, { passive: false });
    return () => document.removeEventListener('wheel', onWheel);
  }, []);

  const handleMouseDown = React.useCallback((e: React.MouseEvent, stageKey: string) => {
    if (e.button === 0) {
      dragRef.current = { stageKey, x: e.clientX, y: e.clientY, pan: panRef.current[viewKey(stageKey)] || { x: 0, y: 0 }, el: e.currentTarget as HTMLElement };
      setIsDragging(stageKey);
      e.preventDefault();
    }
  }, [viewKey]);

  // Мышь ведём по окну, а не по самой странице: курсор может вылететь за её край при быстром движении, и сдвиг не должен обрываться
  const zoomRef = React.useRef(zoom);
  zoomRef.current = zoom;
  const panRef = React.useRef(panOffset);
  panRef.current = panOffset;
  const viewKeyRef = React.useRef(viewKey);
  viewKeyRef.current = viewKey;
  React.useEffect(() => {
    if (!isDragging) return;
    const move = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      // Кнопку уже отпустили за пределами окна: сдвиг заканчиваем, а не тащим страницу без нажатия
      if (e.buttons === 0) {
        dragRef.current = null;
        setIsDragging(null);
        return;
      }
      const key = viewKeyRef.current(drag.stageKey);
      const zoomValue = zoomRef.current[key] || 100;
      // Сдвиг считаем от точки захвата, а не накапливаем шаги: страница остаётся ровно под курсором, а у границы не «залипает»
      // (сдвиг лежит внутри scale(), поэтому делим на масштаб)
      const next = { x: drag.pan.x + ((e.clientX - drag.x) * 100) / zoomValue, y: drag.pan.y + ((e.clientY - drag.y) * 100) / zoomValue };
      setPanOffset((prev) => ({ ...prev, [key]: clampPan(next, zoomValue, drag.el.offsetWidth, drag.el.offsetHeight) }));
    };
    const up = () => {
      dragRef.current = null;
      setIsDragging(null);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [isDragging]);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) {
        return;
      }

      if (e.key === 'Escape' && editModeRef.current) {
        e.preventDefault();
        toggleEditRef.current();
        return;
      }

      if ((e.key === 'e' || e.key === 'E' || e.key === 'у' || e.key === 'У') && !e.ctrlKey && !e.metaKey && canEditEvidenceRef.current && currentFinding && !selectedSuspicionId) {
        e.preventDefault();
        toggleEditRef.current();
        return;
      }

      if (e.key === 'Escape' && bulkSelectedRef.current.length > 0) {
        e.preventDefault();
        clearBulkRef.current();
        return;
      }

      if (e.key === 'Escape') {
        if (isFullscreen) {
          e.preventDefault();
          toggleFullscreen();
          return;
        }
      }

      if ((e.key === '?' || (e.code === 'Slash' && e.shiftKey)) && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        showHotkeysRef.current();
        return;
      }

      if (e.code === 'KeyF' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        toggleFullscreen();
        return;
      }

      if ((e.key === 'n' || e.key === 'N' || e.key === 'т' || e.key === 'Т') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        selectNextPendingRef.current();
        return;
      }

      if (e.key === 'PageDown' || e.key === 'PageUp') {
        e.preventDefault();
        shiftPagesRef.current(e.key === 'PageDown' ? 1 : -1);
        return;
      }

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        selectRelativeRef.current(e.key === 'ArrowRight' ? 1 : -1);
        return;
      }

      if (isRetrain && retrainKeysRef.current.active) {
        if (e.key === '1') {
          e.preventDefault();
          retrainKeysRef.current.send();
        } else if (e.key === '2') {
          e.preventDefault();
          retrainKeysRef.current.skip();
        } else if (e.key === 'Escape') {
          retrainKeysRef.current.close();
        }
        return;
      }

      if (isRetrain || !canDecide || selectedSuspicionId || !currentFinding || !isAwaitingDecision(currentFinding)) return;

      // Разбить на части: доступно только у составного несоответствия (2+ фрагмента), клавиша не пересекается с 1–3 и E
      if (e.code === 'KeyS' && !e.ctrlKey && !e.metaKey && !e.altKey && apiMode && (currentFinding.fragments?.length ?? 0) >= 2 && !deciding) {
        e.preventDefault();
        setSplitOpen(true);
        return;
      }

      // Меню причин открыто: цифры 1–8 выбирают причину
      if (rejectMenuOpenRef.current && /^[1-8]$/.test(e.key)) {
        e.preventDefault();
        chooseRejectReasonRef.current(REJECT_KEYS[Number(e.key) - 1]);
        return;
      }
      if (e.key === 'Escape' && (rejectMenuOpenRef.current || pendingRef.current)) {
        setRejectMenuOpen(false);
        cancelPendingRef.current();
        return;
      }

      if (e.key === '1') {
        e.preventDefault();
        void handleDecision('confirmed');
      } else if (e.key === '2') {
        e.preventDefault();
        handleReject();
      } else if (e.key === '3') {
        e.preventDefault();
        handleClarification();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentFinding, selectedSuspicionId, canDecide, handleDecision, handleReject, handleClarification, isFullscreen, isRetrain, toggleFullscreen, apiMode, deciding]);

  const handlePanelMouseDown = React.useCallback((e: React.MouseEvent, panel: 'findings' | 'evidence') => {
    const target = e.target as HTMLElement;
    if (target.closest('.panel-header-drag')) {
      setDraggingPanel(panel);
      setPanelDragStart({ x: e.clientX, y: e.clientY });
      e.preventDefault();
    }
  }, []);

  const handlePanelMouseMove = React.useCallback((e: MouseEvent) => {
    if (draggingPanel && panelDragStart) {
      const dx = e.clientX - panelDragStart.x;
      const dy = e.clientY - panelDragStart.y;

      if (draggingPanel === 'findings') {
        setFindingsPanelPosition((prev) => ({
          x: prev.x + dx,
          y: prev.y + dy,
        }));
      } else {
        setEvidencePanelPosition((prev) => ({
          x: prev.x + dx,
          y: prev.y + dy,
        }));
      }

      setPanelDragStart({ x: e.clientX, y: e.clientY });
    }
  }, [draggingPanel, panelDragStart]);

  const handlePanelMouseUp = React.useCallback(() => {
    setDraggingPanel(null);
    setPanelDragStart(null);
  }, []);

  React.useEffect(() => {
    if (draggingPanel) {
      document.addEventListener('mousemove', handlePanelMouseMove);
      document.addEventListener('mouseup', handlePanelMouseUp);
      return () => {
        document.removeEventListener('mousemove', handlePanelMouseMove);
        document.removeEventListener('mouseup', handlePanelMouseUp);
      };
    }
  }, [draggingPanel, handlePanelMouseMove, handlePanelMouseUp]);

  React.useEffect(() => {
    const fullscreenWrapper = document.querySelector('.verification-fullscreen-wrapper');

    if (isFullscreen && fullscreenWrapper) {
      setFindingsPanelPosition({ x: 0, y: 0 });
      setEvidencePanelPosition({ x: 0, y: 0 });
      // Request fullscreen API on the wrapper element
      const elem = fullscreenWrapper as HTMLElement;
      // Браузер разрешает полноэкранный режим только сразу после клика; иначе остаётся «во весь экран» средствами страницы
      if (elem.requestFullscreen && navigator.userActivation?.isActive) {
        elem.requestFullscreen().catch(() => undefined);
      }
    } else {
      // Exit fullscreen API
      if (document.fullscreenElement) {
        document.exitFullscreen();
      }
    }
  }, [isFullscreen]);

  React.useEffect(() => {
    const handleFullscreenChange = () => {
      if (!document.fullscreenElement && isFullscreen) {
        setIsFullscreen(false);
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, [isFullscreen]);

  if (!object_id) {
    return <ProjectNotSelected context="verification" />;
  }

  if (apiMode && (isRetrain ? projectsLoading || findingsQuery.isLoading || filesQuery.isLoading || retrainApi.isLoading : projectsLoading || processStatus.isLoading || findingsQuery.isLoading)) {
    return (
      <div className="vw-container">
        <div className="na-panel">
          <div className="t" style={{ fontWeight: 700, fontSize: '13.5px' }}>Загрузка кандидатов…</div>
        </div>
      </div>
    );
  }

  // Финализированный проект: вся работа в протоколе, полное окно верификации не нужно
  if (isFinalizedProject) {
    return (
      <div className="vw-container">
        <div className="vw-header">
          <div className="vw-header-top">
            <div className="vw-title">
              <h2>
                Верификация проекта «{projectName}»
              </h2>
            </div>
          </div>
        </div>
        <div className="na-panel">
          <svg width="52" height="52" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          </svg>
          <div className="t" style={{ fontWeight: 700, fontSize: '13.5px', marginBottom: 3 }}>
            Проект финализирован
          </div>
          <div className="expl" style={{ maxWidth: 520 }}>
            {user?.role === 'ADMIN'
              ? 'Все решения и результаты проверки: в протоколе. Вы можете отменить финализацию в протоколе (кнопка «Отменить финализацию», нужна причина). Решения после этого принимают инспектор и супервизор.'
              : user?.role === 'SUPERVISOR'
                ? 'Все решения и результаты проверки: в протоколе. Чтобы что-то изменить, отмените финализацию в протоколе (кнопка «Отменить финализацию», нужна причина): после этого решения снова можно менять здесь.'
                : 'Все решения и результаты проверки: в протоколе. Чтобы что-то изменить, обратитесь к администратору или супервизору: они могут отменить финализацию.'}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <Button type="primary" size="large" onClick={() => navigate(`/protocol?object=${object_id}`)}>
              Перейти к протоколу
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const refreshAfterChange = () => {
    void queryClient.invalidateQueries({ queryKey: ['protocol-findings'] });
    void queryClient.invalidateQueries({ queryKey: ['process-status'] });
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
  };
  // Гипотеза изменилась на сервере: перечитать список гипотез, пары листов и протокол
  const onHypothesisChanged = () => {
    void suspicionsQ.refetch();
    void queryClient.invalidateQueries({ queryKey: ['page-pairs'] });
    refreshAfterChange();
  };
  const startPromote = (id: string) => {
    setPromotingId(id);
    setSelectedSuspicionId(id);
    setHypDrafts([]);
    // Рамки рисуются на двух страницах рядом
    setCenterMode('compare');
  };
  const cancelPromote = () => {
    setPromotingId(undefined);
    setHypDrafts([]);
  };
  const addHypDraft = (ref: PageRef, box: { x: number; y: number; w: number; h: number }) =>
    setHypDrafts((prev) => [
      ...prev,
      { key: `${Date.now()}-${prev.length}`, stage: stageLabel(ref.stage) as DraftFragment['stage'], fileId: ref.file_id, page: ref.page, bbox: box, role: ref.stage === 'PD' ? 'EXPECTED' : 'ACTUAL', value: '' },
    ]);
  // Гипотеза стала кандидатом: он открывается в панелях ПД / РД / ИД
  const openPromoted = (findingId: string) => {
    setCenterMode('panels');
    selectFindingById(findingId);
  };

  const pctOf = (n: number) => (progressTotal ? (n / progressTotal) * 100 : 0);
  const confirmedPct = pctOf(confirmedFindings.length);
  const rejectedPct = pctOf(rejectedFindings.length);
  const clarifiedPct = pctOf(inspectorClarifiedCount);

  // Шапка проверки (название, кнопки, прогресс, переключатель): одна и та же для кандидатов и гипотез
  const verificationHeader = (
        <div className="vw-header">
          <div className="vw-header-top">
            <div className="vw-title">
              <h2>
                {isRetrain ? 'Дообучение модели, проект' : 'Верификация проекта'} «{projectName}» {isRetrain && dataSource !== 'api' && <DemoTag />}
              </h2>
            </div>
              <div className="vw-header-actions" style={{ display: 'flex', gap: '8px' }}>
                {isRetrain ? (
                  <button className="btn-white" style={WHITE_BUTTON_STYLE} onClick={() => navigate('/dashboard')}>
                    {apiMode ? '← К дашборду' : '← К комментариям на дообучение'}
                  </button>
                ) : (
                  <>
                    <button className="btn-white" style={WHITE_BUTTON_STYLE} onClick={() => navigate(`/upload?object=${object_id}&focus=upload`)}>
                      ↑︎ Дозагрузить
                    </button>
                    <button
                      style={{ ...TEAL_BUTTON_STYLE }}
                      onClick={() => navigate(`/protocol?object=${object_id}`)}
                    >
                      Перейти к протоколу
                    </button>
                  </>
                )}
              </div>
        </div>
        {allProcessed && !isRetrain && (
          <Alert
            className="vw-done-banner"
            type={modelClarifiedCount > 0 ? 'info' : 'success'}
            showIcon
            message={
              modelClarifiedCount > 0
                ? canDecide
                  ? `Кандидаты обработаны. Ещё ${modelClarifiedCount} ${waitingRecordsWord(modelClarifiedCount)} выбора значения (в списке слева, «Требует уточнения»): разбирать необязательно, завершить проверку можно в протоколе.`
                  : 'Кандидаты обработаны инспектором.'
                : canDecide
                  ? 'Все кандидаты обработаны. Решение можно изменить здесь; завершить проверку: в протоколе.'
                  : 'Все кандидаты обработаны инспектором.'
            }
          />
        )}
        <div className="vw-progress-wrap">
          <span style={{ fontSize: '11.5px', fontWeight: 700, color: '#667085', whiteSpace: 'nowrap' }}>
            {confirmedFindings.length + rejectedFindings.length + inspectorClarifiedCount}/{progressTotal} {isRetrain ? 'решено' : 'проверено'}
          </span>
          <div className="vw-progress-bar">
            <div className="seg-confirmed" style={{ width: `${confirmedPct}%` }} />
            <div className="seg-rejected" style={{ width: `${rejectedPct}%` }} />
            <div className="seg-clarified" style={{ width: `${clarifiedPct}%` }} />
          </div>
          <div className="vw-legend-mini">
            <span>
              <div className="dot dot-green" />
              {isRetrain ? 'Отправлено' : 'Подтверждено'}: {confirmedFindings.length}
            </span>
            <span>
              <div className="dot dot-red" />
              {isRetrain ? 'Не отправлено' : 'Отклонено'}: {rejectedFindings.length}
            </span>
            {!isRetrain && (
              <span>
                <div className="dot dot-gray" />
                Уточнено: {inspectorClarifiedCount}
              </span>
            )}
            <span>
              <div className="dot dot-yellow" />
              Ожидает: {tabPendingFindings.length}
            </span>
          </div>
          <button className="tool-btn vw-help-btn" onClick={showHotkeys} title="Горячие клавиши (Shift + /)" aria-label="Горячие клавиши">
            ?
          </button>
        </div>
      </div>
  );

  // Нечего показывать: без этого первая отрисовка обращалась бы к несуществующему несоответствию
  if (!currentFinding && apiMode && isRetrain) {
    return <ProjectNotSelected context="verification" heading="Запись не выбрана" />;
  }
  if (!currentFinding && (!apiMode || isRetrain)) {
    return (
      <div className="vw-container">
        <div className="na-panel">
          <div className="t" style={{ fontWeight: 700, fontSize: '13.5px', marginBottom: 3 }}>
            {isRetrain ? 'Нет записей для решения' : 'Нет кандидатов для показа'}
          </div>
          {isRetrain && (
            <>
              <div className="expl" style={{ maxWidth: 420, marginBottom: 16 }}>
                Решения по отклонённым кандидатам этого проекта уже приняты.
              </div>
              <Button type="primary" onClick={() => navigate('/dashboard')}>
                К комментариям на дообучение
              </Button>
            </>
          )}
        </div>
      </div>
    );
  }

  if (!isRetrain && apiMode && findings.length === 0 && suspicionList.length === 0 && !suspicionsQ.isLoading) {
    const noProtocol = !protocolId;
    return (
      <div className="vw-container">
        <div className="vw-header">
          <div className="vw-header-top">
            <div className="vw-title">
              <h2>{projectName}</h2>
            </div>
          </div>
        </div>
        <div className="na-panel">
          <div className="t" style={{ fontWeight: 700, fontSize: '13.5px', marginBottom: 3 }}>
            {noProtocol ? 'Проверка ещё не запускалась' : 'Кандидатов на верификацию нет'}
          </div>
          <div className="expl">
            {noProtocol ? 'Загрузите документы проекта: после разбора здесь появятся кандидаты.' : 'Система не нашла расхождений, которые требуют решения инспектора. Результат: в протоколе.'}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <Button size="large" onClick={() => navigate(`/upload?object=${object_id}&focus=upload`)}>↑︎ Загрузить</Button>
            {!noProtocol && (
              <Button type="primary" size="large" onClick={() => navigate(`/protocol?object=${object_id}`)}>
                Перейти к протоколу
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const centerSwitch =
    apiMode ? (
      <div className="cmp-seg" role="group" aria-label="Режим центра">
        <button className={centerMode === 'panels' ? 'is-on' : ''} onClick={() => setCenterMode('panels')} title="Документы трёх стадий рядом: доказательства выбранного кандидата">
          <span className="lbl-full">Панели ПД / РД / ИД</span>
          <span className="lbl-short">Панели</span>
        </button>
        <button className={centerMode === 'compare' ? 'is-on' : ''} onClick={() => setCenterMode('compare')} title="Листы разных стадий, наложенные друг на друга: видно, что изменилось">
          <span className="lbl-full">Сравнение листов</span>
          <span className="lbl-short">Листы</span>
        </button>
      </div>
    ) : null;

  // Режим «Сравнение листов»: в полном экране без повторных пояснений, в обычном переключатель и «Во весь экран» стоят в одной строке с выбором пары
  const sheetsMode = apiMode && centerMode === 'compare';
  const fullscreenButton = (
    <button className="btn btn-ghost fullscreen-toggle-btn" onClick={toggleFullscreen}>
      ⛶ Во весь экран <span className="key-hint" title="Горячая клавиша F">F</span>
    </button>
  );
  const renderCompare = (fs: boolean) => (
    <CompareWorkspace
      protocolId={isRetrain && currentFinding ? (findingProtocols.protocolIds.get(currentFinding.finding_id) ?? protocolId) : protocolId}
      currentFindingId={selectedSuspicion ? undefined : currentFinding?.finding_id}
      selectedSuspicionId={selectedSuspicionId}
      onSelectFinding={selectFindingById}
      onSelectSuspicion={setSelectedSuspicionId}
      drawing={Boolean(promotingId)}
      drafts={hypDrafts}
      onAddDraft={addHypDraft}
      hideHelp={fs}
      leading={fs ? undefined : centerSwitch}
      trailing={fs ? undefined : fullscreenButton}
      restricted={isRetrain}
      visibleFindingIds={isRetrain ? retrainFindingIds : undefined}
    />
  );

  const renderHypothesisPanels = () => (
    <HypothesisPanels suspicion={selectedSuspicion} files={filesQuery.data ?? []} sync={syncPanels} renderEmpty={(stageKey) => renderDocPanel({ key: stageKey })} />
  );

  const renderSuspicionDetail = () => (
    <SuspicionDetail
      key={selectedSuspicion?.suspicion_id ?? 'none'}
      suspicion={selectedSuspicion}
      canDecide={canDecide}
      promotingId={promotingId}
      onStartPromote={startPromote}
      onCancelPromote={cancelPromote}
      drafts={hypDrafts}
      onChangeDraft={(key, patch) => setHypDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)))}
      onRemoveDraft={(key) => setHypDrafts((prev) => prev.filter((d) => d.key !== key))}
      files={filesQuery.data ?? []}
      onChanged={onHypothesisChanged}
      onOpenFinding={openPromoted}
    />
  );

  const syncToggle = (
    <button
      className="btn btn-ghost sync-toggle-btn"
      onClick={() => setSyncPanels((value) => !value)}
      title="Масштаб и сдвиг меняются во всех панелях сразу"
    >
      {syncPanels ? '🔗 Панели синхронны' : 'Панели независимы'}
    </button>
  );

  const marksToggle = (
    <button
      className="btn btn-ghost sync-toggle-btn"
      onClick={() => setShowMarks((value) => !value)}
      title="Скрыть или показать рамки доказательства поверх документа"
    >
      {showMarks ? '▢ Скрыть рамки' : '▢ Показать рамки'}
    </button>
  );

  // Загружены ли документы стадии: от этого зависит, что писать в пустой панели (нет файла или в нём ничего не нашли)
  const STAGE_CODE: Record<string, string> = { 'ПД': 'PD', 'РД': 'RD', 'ИД': 'ID' };
  const stageLoaded = (stageKey: string): boolean | undefined =>
    apiMode && filesQuery.data ? filesQuery.data.some((f) => f.doc_stage === STAGE_CODE[stageKey] && f.processing_status !== 'REJECTED') : undefined;

  // Панель решения: не больше 3 действий от открытия карточки; одна и та же во всех режимах
  const renderDecisionBar = () => {
    if (!isAwaitingDecision(currentFinding)) return null;
    if (!canDecide) {
      return (
        <>
          <div className="hint" style={{ fontSize: '12.5px', lineHeight: 1.5, marginTop: 10 }}>
            Решения по кандидатам принимают инспектор и супервизор. Роли «{user?.role === 'ADMIN' ? 'Администратор' : 'ML-инженер'}» доступен только просмотр.
          </div>
        </>
      );
    }
    return (
      <>
        {apiMode && (currentFinding.fragments?.length ?? 0) >= 2 && (
          <button className="btn btn-ghost btn-block split-btn" onClick={() => setSplitOpen(true)} disabled={deciding} title="Горячая клавиша S">
            ✂ Разделить на части <span className="key-hint" title="Горячая клавиша S">S</span>
          </button>
        )}
        <div className="decision-btns">
          <button className="btn btn-success btn-block" onClick={() => void handleDecision('confirmed')} disabled={deciding}>
            ✓ Подтвердить нарушение <span className="key-hint" title="Горячая клавиша 1">1</span>
          </button>

          <button className="btn btn-danger btn-block negative-action" onClick={handleReject} disabled={deciding} aria-expanded={rejectMenuOpen}>
            ✕ Отклонить {rejectMenuOpen ? '▴' : '▾'} <span className="key-hint" title="Горячая клавиша 2">2</span>
          </button>
          {/* Причины показываем прямо в панели, а не всплывающим окном: оно уезжало за край экрана, когда колонка прокручена */}
          {rejectMenuOpen && (
            <div className="reject-reasons" ref={(el) => el?.scrollIntoView({ block: 'nearest' })}>
              {REJECT_KEYS.map((key, i) => (
                <button key={key} className="btn btn-ghost btn-block reject-reason" onClick={() => chooseRejectReason(key)}>
                  <span className="key-hint">{i + 1}</span>
                  <span>{REJECT_REASON[key].label}</span>
                </button>
              ))}
            </div>
          )}

          <button className="btn btn-primary btn-block" onClick={handleClarification} disabled={deciding}>
            ? Уточнить <span className="key-hint" title="Горячая клавиша 3">3</span>
          </button>
        </div>

        {pendingDecision && (
          <div className="decision-form decision-comment">
            <div style={{ fontSize: '12.5px', fontWeight: 700, marginBottom: 8 }}>
              {pendingDecision.kind === 'reject' ? `Причина: ${lowerFirst(REJECT_REASON[pendingDecision.reason].label)}` : 'Уточнение'}
            </div>
            {pendingDecision.kind === 'reject' && pendingDecision.reason === 'APPROVED_CHANGE' && (
              <>
                <label htmlFor="approved-change-ref" style={{ display: 'block', fontSize: '12px', marginBottom: 6 }}>
                  Документ согласования
                </label>
                <input
                  id="approved-change-ref"
                  type="text"
                  value={approvedChangeRef}
                  onChange={(e) => setApprovedChangeRef(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && comment.trim() && !deciding) {
                      e.preventDefault();
                      submitPending();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelPending();
                    }
                  }}
                  placeholder="Письмо № 14 от 12.09.2026"
                  title="Например: письмо заказчика № 14 от 12.09.2026"
                  maxLength={300}
                  style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, border: '1px solid #CBD3DE', borderRadius: 5, padding: '7px 10px', fontFamily: 'inherit', marginBottom: 10, textOverflow: 'ellipsis' }}
                />
              </>
            )}
            <label style={{ display: 'block', fontSize: '12px', marginBottom: 6 }}>
              {pendingDecision.kind === 'reject' ? 'Комментарий для дообучения ИИ *' : 'Что нужно уточнить *'}
            </label>
            <textarea
              autoFocus
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && comment.trim() && !deciding) {
                  e.preventDefault();
                  submitPending();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelPending();
                }
              }}
              placeholder={pendingDecision.kind === 'reject' ? 'Обоснование решения…' : 'Опишите, что нужно уточнить…'}
              style={{
                width: '100%',
                minHeight: 80,
                resize: 'vertical',
                fontSize: '13px',
                border: '1px solid #CBD3DE',
                borderRadius: '5px',
                padding: '8px 10px',
                fontFamily: 'inherit',
                marginBottom: 8,
              }}
            />
            <div className="hint" style={{ fontSize: '11px', color: '#667085', marginBottom: 10 }}>
              {pendingDecision.kind === 'reject'
                ? 'Комментарий обязателен: он станет примером для дообучения под контролем администратора. Текст подставлен по шаблону причины, его можно править.'
                : 'Комментарий обязателен: он попадёт в протокол и в запрос на уточнение.'}
            </div>
            <div className="decision-actions">
              <button
                className="btn btn-primary"
                onClick={submitPending}
                disabled={!comment.trim() || deciding}
                title="Enter"
              >
                {pendingDecision.kind === 'reject' ? 'Отправить на дообучение' : 'Отправить на уточнение'}
              </button>
              <button className="btn btn-ghost negative-action" onClick={cancelPending} title="Esc">
                Отмена
              </button>
            </div>
          </div>
        )}
      </>
    );
  };

  // Навигатор: «3 из 18», стрелки, фильтр «только эта страница»
  const renderNavigator = () => {
    const pos = visibleItems.indexOf(currentItemKey);
    return (
      <>
      <div className="vw-nav">
        <button className="tool-btn" onClick={() => selectRelative(-1)} disabled={pos <= 0} title="Предыдущее (←)" aria-label="Предыдущий кандидат">
          ←
        </button>
        <span className="vw-nav-pos">
          {visibleItems.length === 0 ? 'Ничего не найдено' : `${pos + 1} из ${visibleItems.length}`}
        </span>
        <button className="tool-btn" onClick={() => selectRelative(1)} disabled={pos < 0 || pos >= visibleItems.length - 1} title="Следующее (→)" aria-label="Следующий кандидат">
          →
        </button>
        {apiMode && !isRetrain && (
          <label className="vw-nav-page" title="Показать только кандидатов с доказательством на страницах, которые открыты сейчас">
            <input type="checkbox" checked={onlyThisPage} onChange={(e) => setOnlyThisPage(e.target.checked)} /> Только эта страница
          </label>
        )}
      </div>
      {renderBulkBar()}
      </>
    );
  };

  // Фильтр списка: в режиме api у кандидатов и гипотез свои разделы; дообучение и демо-режим — прежний ряд фильтров кандидатов
  const hypCounts: Record<SuspicionFilter, number> = {
    all: suspicionList.length,
    PENDING: suspicionList.filter((x) => x.inspector_status === 'PENDING').length,
    CLARIFICATION_REQUIRED: suspicionList.filter((x) => x.inspector_status === 'CLARIFICATION_REQUIRED').length,
    DISMISSED: suspicionList.filter((x) => x.inspector_status === 'DISMISSED').length,
    PROMOTED: suspicionList.filter((x) => x.inspector_status === 'PROMOTED').length,
  };
  // Открытый пункт из другого раздела переводим на первый пункт выбранного, иначе справа останется карточка вне списка
  const chooseSection = (section: string) => {
    setSectionFilter(section);
    if (section && findings[currentIndex]?.section !== section) {
      const first = findings.findIndex((f) => f.section === section);
      if (first !== -1) setCurrentIndex(first);
    }
  };

  const sectionSelect =
    sectionCounts.length > 1 ? (
      <Select
        className="vw-section-select"
        showSearch
        allowClear
        aria-label="Раздел"
        placeholder={`Все разделы (${findings.length})`}
        value={sectionFilter || undefined}
        onChange={(value) => chooseSection(value ?? '')}
        optionFilterProp="label"
        options={sectionCounts.map(([section, count]) => ({ value: section, label: `${section} (${count})` }))}
        style={{ width: '100%' }}
        notFoundContent="Такого раздела нет"
      />
    ) : null;
  const renderFilters = () =>
    hypothesesOn ? (
      <ListFilters
        candidates={{
          open: showCandidates,
          onToggle: () => setShowCandidates((value) => !value),
          counts: { all: totalFindings, pending: tabPendingFindings.length, confirmed: confirmedFindings.length, rejected: rejectedFindings.length, clarified: inspectorClarifiedCount },
          value: filterTab === 'candidate' ? 'all' : filterTab,
          onChange: setFilterTab,
        }}
        hypotheses={{ open: showHypotheses, onToggle: () => setShowHypotheses((value) => !value), counts: hypCounts, value: hypFilter, onChange: setHypFilter }}
        query={searchQuery}
        onQuery={setSearchQuery}
        extra={sectionSelect}
      />
    ) : (
      <div className="vw-findings-filters">
        <div className="vw-findings-tabs">
          <button
            className={`vw-tab ${filterTab === 'all' ? 'active' : ''}`}
            onClick={() => setFilterTab('all')}
          >
            Все ({totalFindings})
          </button>
          <button
            className={`vw-tab ${filterTab === 'pending' ? 'active' : ''}`}
            onClick={() => setFilterTab('pending')}
          >
            Ожидают ({tabPendingFindings.length})
          </button>
          <button
            className={`vw-tab ${filterTab === 'confirmed' ? 'active' : ''}`}
            onClick={() => setFilterTab('confirmed')}
          >
            {isRetrain ? 'Отправлено' : 'Подтверждено'} ({confirmedFindings.length})
          </button>
          <button
            className={`vw-tab ${filterTab === 'rejected' ? 'active' : ''}`}
            onClick={() => setFilterTab('rejected')}
          >
            {isRetrain ? 'Не отправлено' : 'Отклонено'} ({rejectedFindings.length})
          </button>
          {!isRetrain && (
            <button
              className={`vw-tab ${filterTab === 'clarified' ? 'active' : ''}`}
              onClick={() => setFilterTab('clarified')}
            >
              Уточнено ({inspectorClarifiedCount})
            </button>
          )}
        </div>
        <input
          type="text"
          className="vw-search"
          placeholder="Поиск по коду или названию"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {sectionSelect}
      </div>
    );

  const renderFindingItem = (finding: Finding) => {
    const globalIdx = findings.findIndex((f) => f.finding_id === finding.finding_id);
    const isActive = !selectedSuspicionId && globalIdx === currentIndex;
    const isPending = finding.status === 'CANDIDATE';

    return (
      <div
        key={finding.finding_id}
        className={`finding-item ${isActive ? 'selected' : ''}`}
        onClick={() => {
          setSelectedSuspicionId(undefined);
          setCurrentIndex(globalIdx);
        }}
      >
        <div className="row1">
          {renderBulkCheck(finding)}
          <span className="code">{finding.code}</span>
          <span className={`badge ${findingBadge(finding, isPending, isRetrain).cls}`}>{findingBadge(finding, isPending, isRetrain).label}</span>
        </div>
        <div className="pname">{finding.parameter_name}</div>
        <div className="vals">
          {finding.sources.pd && <span><b>ПД:</b> {finding.sources.pd.value}</span>}
          {finding.sources.rd && <span><b>РД:</b> {finding.sources.rd.value}</span>}
          {finding.sources.id_ && <span><b>ИД:</b> {finding.sources.id_.value}</span>}
        </div>
      </div>
    );
  };

  const renderSuspicionItem = (item: ApiSuspicion) => {
    const badge = SUSPICION_BADGE[item.inspector_status];
    return (
      <div key={item.suspicion_id} className={`finding-item is-hypothesis ${selectedSuspicionId === item.suspicion_id ? 'selected' : ''}`} onClick={() => setSelectedSuspicionId(item.suspicion_id)}>
        <div className="row1">
          <span className="code">Гипотеза: {METHOD_LABEL[item.discovery_method]}</span>
          <span className={`badge ${badge.cls}`}>{badge.label}</span>
        </div>
        <div className="pname">{item.description}</div>
        <div className="vals">{suspicionRefs(item) && <span>{suspicionRefs(item)}</span>}</div>
      </div>
    );
  };

  // Один список: сначала кандидаты, затем гипотезы
  const renderList = () => (
    <div className="vw-findings-list">
      {shownFindings.map(renderFindingItem)}
      {shownSuspicions.map(renderSuspicionItem)}
      {visibleItems.length === 0 && (
        <div className="sus-empty" style={{ padding: 16 }}>
          Ничего не найдено
        </div>
      )}
    </div>
  );

  // Панель массового решения над списком: только подтверждение и уточнение, отклонять можно лишь по одному
  const renderBulkBar = () => {
    if (!bulkEnabled) return null;
    const code = selectedFindings[0]?.code ?? (currentFinding && isBulkCandidate(currentFinding) ? currentFinding.code : undefined);
    const group = code ? bulkCandidatesOf(findings, code) : [];
    if (selectedFindings.length === 0) {
      if (group.length < 2) return null;
      return (
        <div className="bulk-bar">
          <button className="bulk-link" onClick={() => setBulkSelected(group.map((f) => f.finding_id))}>
            ☐ Выбрать все по {code}: {group.length} шт. и решить сразу
          </button>
        </div>
      );
    }
    return (
      <div className="bulk-bar bulk-bar-active">
        <div className="bulk-title">
          Выбрано: {selectedFindings.length} по {code}
        </div>
        <div className="bulk-actions">
          <button className="btn btn-success" disabled={bulkBusy} onClick={confirmBulk}>
            ✓ Подтвердить: {selectedFindings.length} шт.
          </button>
          <button className="btn btn-primary" disabled={bulkBusy} onClick={() => setBulkClarify((v) => !v)}>
            ? Уточнить: {selectedFindings.length} шт.
          </button>
          <button className="btn btn-ghost negative-action" disabled={bulkBusy} onClick={clearBulk}>
            Сбросить
          </button>
        </div>
        {group.length > selectedFindings.length && (
          <button className="bulk-link" onClick={() => setBulkSelected(group.map((f) => f.finding_id))}>
            ☐ Выбрать все по {code}: {group.length} шт.
          </button>
        )}
        {bulkClarify && (
          <div className="bulk-clarify">
            <textarea value={bulkComment} onChange={(e) => setBulkComment(e.target.value)} rows={2} placeholder="Что нужно уточнить (обязательно)" />
            <button className="btn btn-primary" disabled={bulkBusy || !bulkComment.trim()} onClick={() => void runBulk('CLARIFY', bulkComment)}>
              Отправить на уточнение
            </button>
          </div>
        )}
        <div className="bulk-hint">Массового отклонения нет: каждое отклонение - по отдельности, с причиной.</div>
      </div>
    );
  };

  // Флажок в строке списка: недоступен для других параметров, пока выбран один
  const renderBulkCheck = (finding: Finding) => {
    if (!bulkEnabled || !isBulkCandidate(finding)) return null;
    // Флажок нужен только там, где есть что решать разом: у параметра не меньше двух кандидатов без решения (или он уже отмечен)
    if (bulkCandidatesOf(findings, finding.code).length < 2 && !bulkSelected.includes(finding.finding_id)) return null;
    const allowed = canSelectForBulk(selectedFindings, finding);
    return (
      <input
        type="checkbox"
        className="bulk-check"
        checked={bulkSelected.includes(finding.finding_id)}
        disabled={!allowed || bulkBusy}
        onClick={(e) => e.stopPropagation()}
        onChange={() => toggleBulk(finding)}
        title={allowed ? 'Отметить, чтобы подтвердить или отправить на уточнение сразу несколько кандидатов одного параметра' : 'Массовое решение: только по одному параметру'}
        aria-label={`Отметить ${finding.code}`}
      />
    );
  };

  const ACTION_LABEL = { CONFIRM: 'Подтверждено', REJECT: 'Отклонено', CLARIFY: 'Уточнение' } as const;

  // Основание, история решений и версии доказательств (REQ-CMP-09): в конце блока «Описание» во всех режимах —
  // кроме разбора для дообучения: там нужно только отправить/отклонить, а история решений дублирует блок
  // «Отклонено/Подтверждено инспектором» ниже (см. renderRetrainDecision), остальное — лишние технические детали
  const renderCardExtras = () => {
    if (isRetrain) return null;
    const f = currentFinding;
    const decisions = f.decisionHistory ?? [];
    const versions = f.evidenceVersions ?? [];
    const stageRows = f.stageComparisons ?? [];
    if (!f.ruleKey && !f.delta && !f.rationaleSource && stageRows.length === 0 && !f.evidenceChanged && decisions.length === 0 && versions.length === 0) return null;
    return (
      <>
        {f.evidenceChanged && (
          <div className="ev-block">
            <div className="card-warn">Доказательства изменились после дозагрузки, прежнее решение сброшено. Проверьте кандидата заново.</div>
          </div>
        )}

        {stageRows.length > 0 && (
          <div className="ev-block">
            <div className="ev-lbl">Сравнение по стадиям</div>
            <StageComparisonTable rows={stageRows} />
          </div>
        )}

        {(f.ruleKey || (f.delta && stageRows.length === 0) || f.rationaleSource) && (
          <div className="ev-block">
            <div className="ev-lbl">Основание</div>
            <div className="card-facts">
              {f.ruleKey && (
                <div>
                  <span>Правило</span>
                  <b>{f.ruleKey}</b>
                </div>
              )}
              {f.delta && stageRows.length === 0 && (
                <div>
                  <span>Отклонение</span>
                  <b>{f.delta}</b>
                </div>
              )}
              {f.rationaleSource && (
                <div>
                  <span>Обоснование</span>
                  <b>{f.rationaleSource === 'AI' ? 'сформулировал ИИ' : 'правила проверки'}</b>
                </div>
              )}
            </div>
          </div>
        )}

        {decisions.length > 0 && (
          <div className="ev-block">
            <details className="card-history">
              <summary>История решений ({decisions.length})</summary>
              <ul>
                {decisions.map((d, i) => (
                  <li key={i}>
                    <b>{ACTION_LABEL[d.action]}</b>
                    {d.reasonCode ? `: ${lowerFirst(REJECT_REASON[d.reasonCode].label)}` : ''}
                    <span className="meta">
                      {d.by ? `${d.by}, ` : ''}
                      {d.at}
                    </span>
                    {d.comment && <div className="note">{d.comment}</div>}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}

        {versions.length > 0 && (
          <div className="ev-block">
            <details className="card-history">
              <summary>Версии доказательств ({versions.length})</summary>
              <ul>
                {[...versions].reverse().map((v) => (
                  <li key={v.version}>
                    <b>v{v.version}</b>, {v.source === 'MODEL' ? 'машинная' : `правка инспектора${v.by ? ` ${v.by}` : ''}`}
                    {v.version === versions[versions.length - 1].version ? ', текущая' : ''}
                    <span className="meta">
                      {v.at}, фрагментов: {v.fragments}
                    </span>
                    {(v.reason || v.reference) && (
                      <div className="note">
                        {v.reason}
                        {v.reference ? ` (${v.reference})` : ''}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}
      </>
    );
  };

  // Кнопка правки и сам редактор доказательств — над остальными блоками карточки
  const renderEvidenceEdit = () => {
    if (!canEditEvidence) return null;
    if (!editMode) {
      return (
        <div className="ev-block">
          <button className="btn btn-ghost btn-block" style={{ fontSize: '13px' }} onClick={toggleEdit}>
            ✎ Править доказательства (E)
          </button>
        </div>
      );
    }
    return (
      <div className="ev-block">
        <EvidenceEditor
          fragments={currentFinding.fragments ?? []}
          removedIds={draftRemove}
          drafts={draftAdd}
          saving={savingEvidence}
          onToggleRemove={(id) => setDraftRemove((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))}
          onChangeDraft={(key, patch) => setDraftAdd((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)))}
          onRemoveDraft={(key) => setDraftAdd((prev) => prev.filter((d) => d.key !== key))}
          onSave={(reason, reference) => void handleSaveEvidence(reason, reference)}
          onCancel={cancelEdit}
        />
      </div>
    );
  };

  // Разбор дообучения (решение администратора по отклонённому несоответствию): один и тот же в обычном и полноэкранном режимах
  const renderRetrainDecision = () => {
    if (!isRetrain || !currentRetrainItem) return null;
    return (
      <>
                <div className="ev-block ev-block-sep" style={{ paddingTop: 16 }}>
                  <div className="ev-lbl">{currentRetrainItem.verdict === 'confirmed' ? 'Подтверждено инспектором' : 'Отклонено инспектором'}</div>
                  <div className="ev-card">
                    <div style={{ fontSize: 12, color: '#667085', marginBottom: 8 }}>
                      {currentRetrainItem.inspector}, {apiMode ? formatDateTime(currentRetrainItem.timestamp) : currentRetrainItem.timestamp}
                    </div>
                    {currentRetrainItem.reasonCode && (
                      <>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#667085', marginBottom: 4 }}>Причина</div>
                        <div style={{ fontSize: 13, marginBottom: 8 }}>{REJECT_REASON[currentRetrainItem.reasonCode].label}</div>
                      </>
                    )}
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#667085', marginBottom: 4 }}>Комментарий</div>
                    <div style={{ fontSize: 13, lineHeight: 1.6 }}>{currentRetrainItem.inspectorComment || 'Без комментария'}</div>
                  </div>
                </div>

                <div className="ev-block ev-block-sep" style={{ paddingTop: 16 }}>
                  <div className="ev-lbl">Решение по дообучению</div>

                  {currentRetrainItem.status !== 'pending' && !retrainChanging ? (
                    <div className="ev-card">
                      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
                        {currentRetrainItem.status === 'sent' ? 'Отправлено на дообучение' : 'Не отправлено на дообучение'}
                      </div>
                      {currentRetrainItem.status === 'sent' && currentRetrainItem.modelComment && (
                        <>
                          <div style={{ fontSize: 11, fontWeight: 700, color: '#667085', marginBottom: 4 }}>
                            Комментарий для модели
                          </div>
                          <div style={{ fontSize: 13, lineHeight: 1.6 }}>{currentRetrainItem.modelComment}</div>
                        </>
                      )}
                      {/* На api решение можно менять, пока запись не вошла в выпущенную версию набора */}
                      {currentRetrainItem.status === 'skipped' || (apiMode && !currentRetrainItem.datasetVersion) ? (
                        <button
                          className="btn btn-ghost btn-block"
                          style={{ marginTop: 10, fontSize: '13px' }}
                          onClick={handleRetrainReopen}
                        >
                          ✎ Изменить решение
                        </button>
                      ) : (
                        <div style={{ marginTop: 10, fontSize: 12, color: '#667085' }}>
                          {currentRetrainItem.datasetVersion
                            ? `Запись уже вошла в версию набора ${currentRetrainItem.datasetVersion}, решение по ней не меняется.`
                            : 'Запись уже отправлена на дообучение, решение по ней не меняется.'}
                        </div>
                      )}
                    </div>
                  ) : (
                    <>
                      <div className="decision-btns">
                        <button
                          className="btn btn-success btn-block"
                          onClick={() => setShowRetrainForm(true)}
                        >
                          Отправить на дообучение <span className="key-hint" title="Горячая клавиша 1">1</span>
                        </button>
                        <button
                          className="btn btn-danger btn-block negative-action"
                          onClick={() => handleRetrainDecision('skipped')}
                        >
                          Не отправлять <span className="key-hint" title="Горячая клавиша 2">2</span>
                        </button>
                      </div>
                      {retrainChanging && (
                        <button
                          className="btn btn-ghost btn-block negative-action"
                          style={{ marginTop: 8, fontSize: '13px' }}
                          onClick={() => {
                            setRetrainChanging(false);
                            setShowRetrainForm(false);
                            setRetrainComment('');
                          }}
                        >
                          Не менять
                        </button>
                      )}

                      {showRetrainForm && (
                        <div className="decision-form">
                          <label style={{ marginBottom: 8, display: 'block', fontSize: '12px' }}>
                            Комментарий для модели *
                          </label>
                          <textarea
                            value={retrainComment}
                            onChange={(e) => setRetrainComment(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && retrainComment.trim()) {
                                e.preventDefault();
                                void handleRetrainDecision('sent');
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                setShowRetrainForm(false);
                                setRetrainComment('');
                              }
                            }}
                            placeholder="Что модель должна учесть при дообучении..."
                            autoFocus
                            style={{
                              width: '100%',
                              minHeight: 80,
                              resize: 'vertical',
                              fontSize: '13px',
                              border: '1px solid #CBD3DE',
                              borderRadius: '5px',
                              padding: '8px 10px',
                              fontFamily: 'inherit',
                              marginBottom: 8,
                            }}
                          />
                          <div className="decision-actions">
                            <button className="btn btn-primary" onClick={() => handleRetrainDecision('sent')} disabled={!retrainComment.trim()} title="Enter">
                              Подтвердить отправку
                            </button>
                            <button
                              className="btn btn-ghost negative-action"
                              title="Esc"
                              onClick={() => {
                                setShowRetrainForm(false);
                                setRetrainComment('');
                              }}
                            >
                              Отмена
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </>
    );
  };

  const markColor = (stageKey: string, role?: EvidenceRole) => (role ? ROLE_COLORS[role] : STAGE_COLORS[stageKey]);

  // Панель документа одинаковая в обычном и полноэкранном режимах
  const renderDocPanel = (stage: PanelStage) => {
    const src = stage.src;
    if (!src) {
      const loaded = stageLoaded(stage.key);
      return (
        <div key={stage.key} className="doc-panel doc-panel-empty">
          <div className="doc-panel-head">
            <span className="stage" style={{ background: STAGE_COLORS[stage.key] }}>
              {stage.key}
            </span>
            <span className="dname">{loaded === false ? 'Документы не загружены' : 'Нет доказательств'}</span>
          </div>
          <div className="doc-panel-empty-body">
            <div>
              {loaded === false
                ? isRetrain
                  ? `Документы стадии ${stage.key} не загружены: на момент решения инспектора их не было в проекте, сравнить не с чем.`
                  : `Документы стадии ${stage.key} не загружены. Загрузите их, чтобы сравнить с другими стадиями.`
                : loaded === true
                  ? selectedSuspicion
                    ? `Документы стадии ${stage.key} загружены, но у гипотезы нет области на этой стадии.`
                    : `Документы стадии ${stage.key} загружены, но система не нашла в них значение для этого параметра.`
                  : `По стадии ${stage.key} нет доказательств для ${selectedSuspicion ? 'этой гипотезы' : 'этого кандидата'}.`}
            </div>
            {!isRetrain && (
              <button className="btn-white" style={WHITE_BUTTON_STYLE} onClick={() => navigate(`/upload?object=${object_id}&focus=upload`)}>
                ↑︎ Дозагрузить
              </button>
            )}
          </div>
        </div>
      );
    }

    const vk = viewKey(stage.key);
    const page = pageOf(stage.key, src);
    const total = totalPagesOf(src);
    const zoomValue = zoom[vk] || 100;
    const pan = panOffset[vk];
    // Разбор для дообучения: инспектор принял решение по одному значению на стадию — лишние фрагменты (например,
    // задвоенная ручная рамка поверх той же точки) администратору не нужны и только мешают понять, что отклонено
    const allMarksRaw = src.marks && src.marks.length > 0 ? src.marks : src.bbox ? [{ page: src.page, bbox: src.bbox, value: src.value, role: src.role }] : [];
    const allMarks = isRetrain ? allMarksRaw.slice(0, 1) : allMarksRaw;
    // В режиме правки убранные фрагменты серые, новые рамки рисуются цветом своей роли; нарисованное инспектором помечено ✎
    const removed = editMode ? new Set(draftRemove) : null;
    const marks: PdfMark[] = [
      ...allMarks
        .filter((m) => m.page === page)
        .map((m) => {
          const isRemoved = Boolean(removed && m.fragmentId && removed.has(m.fragmentId));
          return {
            bbox: m.bbox,
            label: `${m.manual ? '✎ ' : ''}${m.bySense ? '≈ ' : ''}${m.value}`,
            color: isRemoved ? '#98A2B3' : markColor(stage.key, m.role),
            dashed: m.role === 'CONTEXT' || isRemoved,
          };
        }),
      ...(editMode
        ? draftAdd
            .filter((d) => d.fileId === src.fileId && d.page === page)
            .map((d) => ({ bbox: d.bbox, label: `новая${d.value ? `: ${d.value}` : ''}`, color: markColor(stage.key, d.role), dashed: false }))
        : []),
    ];
    const onDraw =
      editMode && src.fileId
        ? (box: { x: number; y: number; w: number; h: number }) =>
            setDraftAdd((prev) => [
              ...prev,
              { key: `${Date.now()}-${prev.length}`, stage: stage.key as DraftFragment['stage'], fileId: src.fileId!, page, bbox: box, role: stage.key === 'ПД' ? 'EXPECTED' : 'ACTUAL', value: '' },
            ])
        : undefined;

    return (
      <div key={stage.key} className="doc-panel">
        <div className="doc-panel-head">
          <span className="stage" style={{ background: STAGE_COLORS[stage.key] }}>
            {stage.key}
          </span>
          <span className="dname">{src.docName || `Документ ${stage.key}`}</span>
          <span style={{ fontSize: '11px', color: '#667085', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
            {src.sheet ? `лист ${src.sheet}, ` : ''}стр. {src.page}
          </span>
          {src.area && (
            <span style={{ fontSize: '11px', color: '#667085', fontFamily: 'IBM Plex Mono, monospace' }}>{src.area} м²</span>
          )}
        </div>
        <div className="doc-panel-canvas">
          <div
            className={src.fileId ? 'blueprint-page pdf-stage' : 'blueprint-page'}
            data-zoom-stage={stage.key}
            onMouseDown={(e) => handleMouseDown(e, stage.key)}
            style={{
              transform: `scale(${zoomValue / 100}) translate(${pan?.x || 0}px, ${pan?.y || 0}px)`,
              transformOrigin: 'center',
              cursor: isDragging === stage.key ? 'grabbing' : 'grab',
              // Пока страницу тащат, без сглаживания: иначе она отстаёт от курсора
              transition: isDragging === stage.key ? 'none' : undefined,
            }}
          >
            {src.fileId ? (
              <PdfPage
                fileId={src.fileId}
                page={page}
                marks={showMarks ? marks : []}
                fragment={{ fileName: src.docName, value: src.value, snippet: src.snippet }}
                onDraw={onDraw}
                onPageCount={(count) => setPageCounts((prev) => (prev[src.fileId!] === count ? prev : { ...prev, [src.fileId!]: count }))}
              />
            ) : (
              marks.map((mark, i) => <MarkBox key={i} mark={mark} />)
            )}
          </div>
        </div>
        <div className="doc-panel-tools">
          <div className="grp">
            <button
              className="tool-btn"
              onClick={() => setCurrentPages((prev) => ({ ...prev, [stage.key]: Math.max(page - 1, 1) }))}
              disabled={page <= 1}
              title="Предыдущая страница (PgUp, во всех панелях)"
            >
              ←
            </button>
            <span style={{ fontSize: '11px', padding: '0 8px' }}>
              {page} / {total}
            </span>
            <button
              className="tool-btn"
              onClick={() => setCurrentPages((prev) => ({ ...prev, [stage.key]: Math.min(page + 1, total) }))}
              disabled={page >= total}
              title="Следующая страница (PgDn, во всех панелях)"
            >
              →
            </button>
            {page !== src.page && (
              <button className="tool-btn tool-btn-text" onClick={() => setCurrentPages((prev) => ({ ...prev, [stage.key]: src.page }))} title="Вернуться к странице с доказательством">
                к доказательству
              </button>
            )}
          </div>
          <div className="grp">
            <button
              className="tool-btn"
              onClick={() => setZoom((prev) => ({ ...prev, [vk]: Math.max(50, (prev[vk] || 100) - 25) }))}
              disabled={zoomValue <= 50}
              title="Уменьшить"
            >
              −
            </button>
            <span>{zoomValue}%</span>
            <button
              className="tool-btn"
              onClick={() => setZoom((prev) => ({ ...prev, [vk]: Math.min(400, (prev[vk] || 100) + 25) }))}
              disabled={zoomValue >= 400}
              title="Увеличить"
            >
              +
            </button>
            <button className="tool-btn tool-btn-text" onClick={fitView} title="Вписать страницу">
              Вписать
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
    {isFullscreen && (
      <div className="verification-fullscreen-wrapper" style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 9999,
        background: '#FFFFFF',
        display: 'flex',
        flexDirection: 'column',
      }}>
        {/* Fullscreen toolbar */}
        <div className="compare-toolbar" style={{
          padding: '10px 24px',
          borderBottom: '1px solid #E3E8EF',
          background: '#FFFFFF'
        }}>
          <div className="fs-toolbar-row">
            <button className="btn btn-ghost fs-toolbar-btn" onClick={() => setShowFindingsPanel((value) => !value)}>
              📋 {showFindingsPanel ? 'Свернуть список' : 'Показать список'}
            </button>
            <button className="btn btn-ghost fs-toolbar-btn" onClick={() => setShowEvidencePanel((value) => !value)}>
              ✓ {showEvidencePanel ? 'Свернуть проверку' : 'Показать проверку'}
            </button>
            {centerSwitch}
            {centerMode === 'panels' && syncToggle}
            {centerMode === 'panels' && marksToggle}
            <button className="fullscreen-exit-btn-bottom fs-toolbar-btn" onClick={toggleFullscreen}>
              ✕ Свернуть (ESC)
            </button>
          </div>
        </div>

        {/* Fullscreen comparison area */}
        <div style={{ flex: 1, overflow: 'auto', padding: apiMode && centerMode === 'compare' ? '0 24px 16px' : '24px', display: 'flex' }}>
          {apiMode && centerMode === 'compare' ? (
            <div className="compare-workspace" style={{ flex: 1, height: '100%' }}>
              {renderCompare(true)}
            </div>
          ) : selectedSuspicion ? (
            <div className="compare-workspace" style={{ flex: 1, height: '100%' }}>
              {renderHypothesisPanels()}
            </div>
          ) : (
            <div
              ref={panelsRef}
              className="compare-panels"
              style={{
                gridTemplateColumns: panelColumns,
                height: '100%',
                flex: 1,
              }}
            >
              {panelStages.map(renderDocPanel)}
            </div>
          )}
        </div>

        {/* Fullscreen floating panels */}
        {showFindingsPanel && (
          <div
            className="floating-panel"
            style={{
              position: 'fixed',
              left: `${20 + findingsPanelPosition.x}px`,
              top: `${84 + findingsPanelPosition.y}px`,
              width: '320px',
              height: 'min(500px, calc(100vh - 104px))',
              zIndex: 10000,
              background: '#FFFFFF',
              borderRadius: '12px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <div
              className="panel-header-drag"
              onMouseDown={(e) => handlePanelMouseDown(e, 'findings')}
              style={{
                padding: '12px 16px',
                borderBottom: '1px solid #E3E8EF',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                cursor: 'move',
                userSelect: 'none',
                background: '#F7F9FB',
              }}
            >
              <span style={{ fontSize: '14px', fontWeight: 600 }}>Список</span>
              <button
                className="tool-btn"
                onClick={() => setShowFindingsPanel(false)}
                title="Скрыть"
              >
                ✕
              </button>
            </div>
            <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              {renderFilters()}
              {renderNavigator()}
              {renderList()}
            </div>
          </div>
        )}

        {showEvidencePanel && (
          <div
            className="floating-panel"
            style={{
              position: 'fixed',
              right: `${20 - evidencePanelPosition.x}px`,
              top: `${84 + evidencePanelPosition.y}px`,
              width: '360px',
              height: 'min(600px, calc(100vh - 104px))',
              zIndex: 10000,
              background: '#FFFFFF',
              borderRadius: '12px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <div
              className="panel-header-drag"
              onMouseDown={(e) => handlePanelMouseDown(e, 'evidence')}
              style={{
                padding: '12px 16px',
                borderBottom: '1px solid #E3E8EF',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                cursor: 'move',
                userSelect: 'none',
                background: '#F7F9FB',
              }}
            >
              <span style={{ fontSize: '14px', fontWeight: 600 }}>Проверка</span>
              <button
                className="tool-btn"
                onClick={() => setShowEvidencePanel(false)}
                title="Скрыть"
              >
                ✕
              </button>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '16px' }}>
              {selectedSuspicion ? renderSuspicionDetail() : currentFinding && (<>
              <div className="ev-block">
                <div className={`prio prio-${currentFinding.review_priority}`}>
                  <span className="flag"></span>
                  {currentFinding.review_priority === 'HIGH' ? 'ВЫСОКИЙ' :
                   currentFinding.review_priority === 'MEDIUM' ? 'СРЕДНИЙ' : 'НИЗКИЙ'}
                </div>
              </div>

              <div className="ev-block">
                <div className="code" style={{ fontWeight: 800, fontSize: '14px', marginBottom: 4, fontFamily: 'IBM Plex Mono, monospace' }}>
                  {currentFinding.code}
                </div>
                <div style={{ fontSize: '13px', color: '#667085', marginBottom: 16 }}>
                  {currentFinding.parameter_name}
                </div>
              </div>

              <div className="ev-block">
                <div className="ev-lbl">Раздел</div>
                <div className="ev-field" style={{ fontSize: '12.5px' }}>
                  {currentFinding.section}
                </div>
              </div>

              <div className="ev-block">
                <div className="ev-lbl">Источники</div>
                {presentStages?.map((stage) => (
                  <div key={stage.key} className="src-row">
                    <div className="stagechip" style={{ background: STAGE_COLORS[stage.key] }}>
                      {stage.key}
                    </div>
                    <div className="d">
                      <div className="fn">{stage.src.value}<BySenseTag show={stage.src.bySense} /></div>
                      <div className="meta">стр. {stage.src.page}</div>
                    </div>
                  </div>
                ))}
              </div>

              {currentFinding.gost_reference && (
                <div className="ev-block">
                  <div className="ev-lbl">Нормативное основание</div>
                  <div style={{ fontSize: '12px', lineHeight: 1.6 }}>
                    {currentFinding.gost_reference}
                  </div>
                </div>
              )}

              <FindingDescription finding={currentFinding} />

              {renderEvidenceEdit()}
              {renderCardExtras()}

              {renderRetrainDecision()}

              {!isRetrain && (
              <div className="ev-block ev-block-sep" style={{ paddingTop: 16 }}>
                {currentFinding.modelClarification && (
                  <div className="hint" style={{ fontSize: '12.5px', lineHeight: 1.5, marginBottom: 10 }}>
                    Система не смогла определить результат по этой записи, поэтому она требует уточнения.
                  </div>
                )}
                <div className="ev-lbl">Решение инспектора</div>

                {!isAwaitingDecision(currentFinding) && (
                  <div className="ev-card" style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: '11px', fontWeight: 700, color: '#667085', marginBottom: 6 }}>
                      Комментарий
                    </div>
                    <div style={{ fontSize: '13px', lineHeight: 1.6, marginBottom: 8 }}>
                      {decisionCommentText(currentFinding)}
                    </div>
                    {currentFinding.status === 'rejected' && currentFinding.reason_code && (
                      <>
                        <div style={{ fontSize: '11px', fontWeight: 700, color: '#667085', marginBottom: 4 }}>
                          Причина:
                        </div>
                        <div style={{ fontSize: '13px' }}>
                          {REJECT_REASON[currentFinding.reason_code].label}
                        </div>
                      </>
                    )}
                    {canDecide && (
                    <button
                      className="btn btn-ghost btn-block"
                      style={{ marginTop: 10, fontSize: '13px' }}
                      onClick={handleChangeDecision}
                    >
                      ✎ Изменить решение
                    </button>
                    )}
                  </div>
                )}

                {renderDecisionBar()}
              </div>
              )}
              </>)}
            </div>
          </div>
        )}
      </div>
    )}

    {!isFullscreen && (
    <div className="vw-container">
      {verificationHeader}

      {/* Body */}
      <div className="vw-body">
        {/* Left panel: Findings list */}
        {!isFullscreen && (
          <div className="vw-col-findings">
            {renderFilters()}
            {renderNavigator()}
            {renderList()}
          </div>
        )}

        {/* Center: Comparison panels */}
        <div className="vw-col-center" style={{ overflowX: 'auto' }}>
          {!sheetsMode && (
            <div className="compare-toolbar">
              <div className="compare-actions">
                {centerSwitch}
                {fullscreenButton}
                {centerMode === 'panels' && syncToggle}
                {centerMode === 'panels' && marksToggle}
              </div>
            </div>
          )}

          {apiMode && centerMode === 'compare' ? (
            <div className="compare-workspace">{renderCompare(false)}</div>
          ) : selectedSuspicion ? (
            <div className="compare-workspace">{renderHypothesisPanels()}</div>
          ) : (
          <div
            ref={panelsRef}
            className="compare-panels"
            style={{
              gridTemplateColumns: panelColumns,
            }}
          >
            {panelStages.map(renderDocPanel)}
          </div>
          )}
        </div>

        {/* Right panel: Inspector decision */}
        {!isFullscreen && (
          <div className="vw-col-evidence">
            <div className="vw-col-evidence-scroll">
            {selectedSuspicion ? renderSuspicionDetail() : currentFinding && (<>
            <div className="ev-block">
              <div className={`prio prio-${currentFinding.review_priority}`}>
                <span className="flag"></span>
                {currentFinding.review_priority === 'HIGH' ? 'ВЫСОКИЙ' :
                 currentFinding.review_priority === 'MEDIUM' ? 'СРЕДНИЙ' : 'НИЗКИЙ'}
              </div>
            </div>

            <div className="ev-block">
              <div className="code" style={{ fontWeight: 800, fontSize: '14px', marginBottom: 4, fontFamily: 'IBM Plex Mono, monospace' }}>
                {currentFinding.code}
              </div>
              <div style={{ fontSize: '13px', color: '#667085', marginBottom: 16 }}>
                {currentFinding.parameter_name}
              </div>
            </div>

            <div className="ev-block">
              <div className="ev-lbl">Раздел</div>
              <div className="ev-field" style={{ fontSize: '12.5px' }}>
                {currentFinding.section}
              </div>
            </div>

            <div className="ev-block">
              <div className="ev-lbl">Источники</div>
              {presentStages?.map((stage) => (
                <div key={stage.key} className="src-row">
                  <div className="stagechip" style={{ background: STAGE_COLORS[stage.key] }}>
                    {stage.key}
                  </div>
                  <div className="d">
                    <div className="fn">{stage.src.value}<BySenseTag show={stage.src.bySense} /></div>
                    <div className="meta">стр. {stage.src.page}</div>
                  </div>
                </div>
              ))}
            </div>

            {currentFinding.gost_reference && (
              <div className="ev-block">
                <div className="ev-lbl">Нормативное основание</div>
                <div style={{ fontSize: '12px', lineHeight: 1.6 }}>
                  {currentFinding.gost_reference}
                </div>
              </div>
            )}

            <FindingDescription finding={currentFinding} />

              {renderEvidenceEdit()}
              {renderCardExtras()}

            {renderRetrainDecision()}

            {!isRetrain && (
            <div className="ev-block ev-block-sep" style={{ paddingTop: 16 }}>
              {currentFinding.modelClarification && (
                <div className="hint" style={{ fontSize: '12.5px', lineHeight: 1.5, marginBottom: 10 }}>
                  Система не смогла определить результат по этой записи, поэтому она требует уточнения.
                </div>
              )}
              <div className="ev-lbl">Решение инспектора</div>

              {!isAwaitingDecision(currentFinding) && (
                <div className="ev-card" style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, color: '#667085', marginBottom: 6 }}>
                    Комментарий
                  </div>
                  <div style={{ fontSize: '13px', lineHeight: 1.6, marginBottom: 8 }}>
                    {decisionCommentText(currentFinding)}
                  </div>
                  {currentFinding.status === 'rejected' && currentFinding.reason_code && (
                    <>
                      <div style={{ fontSize: '11px', fontWeight: 700, color: '#667085', marginBottom: 4 }}>
                        Причина:
                      </div>
                      <div style={{ fontSize: '13px' }}>
                        {REJECT_REASON[currentFinding.reason_code].label}
                      </div>
                    </>
                  )}
                  {canDecide && (
                  <button
                    className="btn btn-ghost btn-block"
                    style={{ marginTop: 10, fontSize: '13px' }}
                    onClick={handleChangeDecision}
                  >
                    ✎ Изменить решение
                  </button>
                  )}
                </div>
              )}

              {renderDecisionBar()}
            </div>
            )}
            </>)}
            </div>
          </div>
        )}

        {/* Verification Window */}
        {showVerificationWindow && !fullscreenEvidence && (
          <div className="vw-container">
            <div className="vw-header">
              <h3>Результаты верификации</h3>
              <button
                className="vw-close"
                onClick={() => setShowVerificationWindow(false)}
              >
                ×
              </button>
            </div>
            <div className="vw-content">
              <div className="vw-toolbar">
                <div className="vw-tabs">
                  <button
                    className={`vw-tab ${filterTab === 'all' ? 'active' : ''}`}
                    onClick={() => setFilterTab('all')}
                  >
                    Все ({findings.length})
                  </button>
                  <button
                    className={`vw-tab ${filterTab === 'candidate' ? 'active' : ''}`}
                    onClick={() => setFilterTab('candidate')}
                  >
                    Требуют проверки ({candidateFindings.length})
                  </button>
                  <button
                    className={`vw-tab ${filterTab === 'confirmed' ? 'active' : ''}`}
                    onClick={() => setFilterTab('confirmed')}
                  >
                    Подтверждено ({confirmedFindings.length})
                  </button>
                  <button
                    className={`vw-tab ${filterTab === 'rejected' ? 'active' : ''}`}
                    onClick={() => setFilterTab('rejected')}
                  >
                    Отклонено ({rejectedFindings.length})
                  </button>
                {!isRetrain && (
                  <button
                    className={`vw-tab ${filterTab === 'clarified' ? 'active' : ''}`}
                    onClick={() => setFilterTab('clarified')}
                  >
                    Уточнено ({inspectorClarifiedCount})
                  </button>
                )}
                </div>
                <input
                  type="text"
                  className="vw-search"
                  placeholder="Поиск по коду или названию"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              {renderNavigator()}
<div className="vw-findings-list">
                {filteredFindings.map((finding) => {
                  const globalIdx = findings.findIndex(f => f.finding_id === finding.finding_id);
                  const isActive = globalIdx === currentIndex;
                  const isPending = finding.status === 'CANDIDATE';

                  return (
                    <div
                      key={finding.finding_id}
                      className={`finding-item ${isActive ? 'selected' : ''}`}
                      onClick={() => setCurrentIndex(globalIdx)}
                    >
                      <div className="row1">
                        {renderBulkCheck(finding)}
                        <span className="code">{finding.code}</span>
                        <span className={`badge ${findingBadge(finding, isPending, isRetrain).cls}`}>{findingBadge(finding, isPending, isRetrain).label}</span>
                      </div>
                      <div className="pname">{finding.parameter_name}</div>
                      <div className="vals">
                        {finding.sources.pd && <span><b>ПД:</b> {finding.sources.pd.value}</span>}
                        {finding.sources.rd && <span><b>РД:</b> {finding.sources.rd.value}</span>}
                        {finding.sources.id_ && <span><b>ИД:</b> {finding.sources.id_.value}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {isFullscreen && showEvidencePanel && (
          <div
            className="floating-panel"
            style={{
              position: 'fixed',
              right: `${20 - evidencePanelPosition.x}px`,
              top: `${84 + evidencePanelPosition.y}px`,
              width: '360px',
              height: 'min(600px, calc(100vh - 104px))',
              zIndex: 300,
              background: '#FFFFFF',
              borderRadius: '12px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            <div
              className="panel-header-drag"
              onMouseDown={(e) => handlePanelMouseDown(e, 'evidence')}
              style={{
                padding: '12px 16px',
                borderBottom: '1px solid #E3E8EF',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                cursor: 'move',
                userSelect: 'none',
                background: '#F7F9FB',
              }}
            >
              <span style={{ fontSize: '14px', fontWeight: 600 }}>Проверка инспектора</span>
              <button
                className="tool-btn"
                onClick={() => setShowEvidencePanel(false)}
                title="Скрыть"
              >
                ✕
              </button>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '16px' }}>
              <div className="ev-block">
                <div className={`prio prio-${currentFinding.review_priority}`}>
                  <span className="flag"></span>
                  {currentFinding.review_priority === 'HIGH' ? 'ВЫСОКИЙ' :
                   currentFinding.review_priority === 'MEDIUM' ? 'СРЕДНИЙ' : 'НИЗКИЙ'}
                </div>
              </div>

              <div className="ev-block">
                <div className="code" style={{ fontWeight: 800, fontSize: '14px', marginBottom: 4, fontFamily: 'IBM Plex Mono, monospace' }}>
                  {currentFinding.code}
                </div>
                <div style={{ fontSize: '13px', color: '#667085', marginBottom: 16 }}>
                  {currentFinding.parameter_name}
                </div>
              </div>

              <div className="ev-block">
                <div className="ev-lbl">Раздел</div>
                <div className="ev-field" style={{ fontSize: '12.5px' }}>
                  {currentFinding.section}
                </div>
              </div>

              <div className="ev-block">
                <div className="ev-lbl">Источники</div>
                {presentStages?.map((stage) => (
                  <div key={stage.key} className="src-row">
                    <div className="stagechip" style={{ background: STAGE_COLORS[stage.key] }}>
                      {stage.key}
                    </div>
                    <div className="d">
                      <div className="fn">{stage.src.value}<BySenseTag show={stage.src.bySense} /></div>
                      <div className="meta">стр. {stage.src.page}</div>
                    </div>
                  </div>
                ))}
              </div>

              {currentFinding.gost_reference && (
                <div className="ev-block">
                  <div className="ev-lbl">Нормативное основание</div>
                  <div style={{ fontSize: '12px', lineHeight: 1.6 }}>
                    {currentFinding.gost_reference}
                  </div>
                </div>
              )}

              <FindingDescription finding={currentFinding} />

              {renderEvidenceEdit()}
              {renderCardExtras()}

              {renderRetrainDecision()}

              {!isRetrain && (
              <div className="ev-block ev-block-sep" style={{ paddingTop: 16 }}>
                {currentFinding.modelClarification && (
                  <div className="hint" style={{ fontSize: '12.5px', lineHeight: 1.5, marginBottom: 10 }}>
                    Система не смогла определить результат по этой записи, поэтому она требует уточнения.
                  </div>
                )}
                <div className="ev-lbl">Решение инспектора</div>

                {!isAwaitingDecision(currentFinding) && (
                  <div className="decision-form" style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: 8 }}>
                      {currentFinding.status === 'confirmed' ? '✓ Нарушение подтверждено' :
                       currentFinding.status === 'rejected' ? '✕ Отклонено' :
                       'Требует уточнения'}
                    </div>
                    {currentFinding.inspector_comment && (
                      <div style={{ fontSize: '13px', marginBottom: 8, lineHeight: 1.5 }}>
                        <strong>Комментарий:</strong><br />
                        {currentFinding.inspector_comment}
                      </div>
                    )}
                    {currentFinding.reason_code && (
                      <div style={{ fontSize: '13px', marginBottom: 8 }}>
                        <strong>Причина:</strong> {REJECT_REASON[currentFinding.reason_code].label}
                      </div>
                    )}
                    {canDecide && (
                      <button
                        className="btn btn-ghost btn-block"
                        onClick={handleChangeDecision}
                        style={{ fontSize: '13px' }}
                      >
                        ✎ Изменить решение
                      </button>
                    )}
                  </div>
                )}

                {renderDecisionBar()}
              </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
    )}
    {currentFinding && (
    <SplitFindingModal
      open={splitOpen}
      title={currentFinding.parameter_name}
      baseRuleKey={currentFinding.ruleKey}
      fragments={currentFinding.fragments ?? []}
      saving={splitting}
      onCancel={() => setSplitOpen(false)}
      onSubmit={handleSplit}
    />
    )}
    </>
  );
};
