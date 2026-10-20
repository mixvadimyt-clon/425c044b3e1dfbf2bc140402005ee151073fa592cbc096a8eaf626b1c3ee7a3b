import React from 'react';
import { Modal, Select, theme } from 'antd';
import { highlight } from '@/shared/guide';
import { REJECT_REASON } from '@/shared/statuses';
import { REJECT_TEMPLATES } from '@/shared/verification';
import type { DecisionEntry, DraftFragment, EvidenceVersionEntry } from '@/shared/verification';
import {
  TRAINER_CANDIDATES,
  TRAINER_HYPOTHESES,
  fragmentsOf,
  hasOpenAction,
  initialTrainerState,
  trainerCounts,
  trainerReducer,
  verdictOf,
} from '@/shared/trainer';
import type {
  TrainerAction,
  TrainerCandidate,
  TrainerDoc,
  TrainerFragment,
  TrainerHypothesis,
  TrainerHypothesisStatus,
  TrainerRejectReason,
  TrainerStage,
} from '@/shared/trainer';
import { TRAINING_PROJECT } from '@/shared/training';
import { MarkBox } from '@/widgets/PdfPage';
import { EvidenceEditor } from '@/widgets/EvidenceEditor';
import { SplitFindingModal } from '@/widgets/SplitFindingModal';
import type { SplitPartValues } from '@/widgets/SplitFindingModal';
import { StageComparisonTable } from '@/widgets/StageComparisonTable';
import { ListFilters } from '@/widgets/ListFilters';
import type { CandidateFilter } from '@/widgets/ListFilters';
import type { SuspicionFilter } from '@/api/suspicions';
import { SceneFrame } from '../guideUi';
import type { SceneProps } from '../guideUi';
import { CompareSheets } from './verification/CompareSheets';
import { HypothesisCard } from './verification/HypothesisCard';
import type { PromoteInput } from './verification/HypothesisCard';
import { HOTKEYS, HYPOTHESIS_BADGE, STAGES, STAGE_COLORS, TEAL_BUTTON, VERDICT_BADGE, WHITE_BUTTON, nowText } from './verification/consts';
import { FloatingPanel, PageImage } from './verification/parts';

const REJECT_KEYS = Object.keys(REJECT_REASON) as TrainerRejectReason[];
const ROLE_COLORS = { EXPECTED: '#2450C7', ACTUAL: '#B4620B', CONTEXT: '#667085' } as const;
const HYP_COLOR = '#D97706';
const FILTER_OF: Record<Exclude<CandidateFilter, 'all'>, 'pending' | 'confirmed' | 'rejected' | 'clarification'> = {
  pending: 'pending',
  confirmed: 'confirmed',
  rejected: 'rejected',
  clarified: 'clarification',
};

/** Что ждёт форма комментария: отклонение с причиной или уточнение. */
type Pending = { kind: 'reject'; reason: TrainerRejectReason } | { kind: 'clarify' } | null;

/**
 * Верификация из настоящих блоков: шапка с прогрессом, список кандидатов и гипотез, панели документов или сравнение листов
 * и карточка решения. Данные учебные, на сервер ничего не уходит. Пока идёт урок, работает только то, что просит шаг;
 * после урока всё работает как в настоящей верификации.
 */
export const VerificationScene: React.FC<SceneProps> = ({ step, act, coach, paused, registerEscape, registerEnter }) => {
  const { token } = theme.useToken();
  const [candidates, setCandidates] = React.useState<TrainerCandidate[]>(TRAINER_CANDIDATES);
  const reducer = React.useMemo(() => trainerReducer(candidates), [candidates]);
  const [state, dispatch] = React.useReducer(reducer, undefined, initialTrainerState);
  const stateRef = React.useRef(state);
  stateRef.current = state;
  const hl = (target: string) => highlight(step, target);

  // Фильтры списка
  const [filter, setFilter] = React.useState<CandidateFilter>('all');
  const [query, setQuery] = React.useState('');
  const [sectionFilter, setSectionFilter] = React.useState('');
  const [onlyThisPage, setOnlyThisPage] = React.useState(false);
  const [showCandidates, setShowCandidates] = React.useState(true);
  const [showHypotheses, setShowHypotheses] = React.useState(true);
  const [hypFilter, setHypFilter] = React.useState<SuspicionFilter>('all');

  // Центр
  const [showMarks, setShowMarks] = React.useState(true);
  const [sync, setSync] = React.useState(true);
  // Масштаб страниц: по умолчанию значение крупно, «Вписать» показывает лист целиком
  const [zoom, setZoom] = React.useState(3);
  const [centerMode, setCenterMode] = React.useState<'panels' | 'compare'>('panels');
  const [hotkeysOpen, setHotkeysOpen] = React.useState(false);

  // Решение: комментарий, история, версии доказательств
  const [pending, setPending] = React.useState<Pending>(null);
  const [comment, setComment] = React.useState('');
  // Отправленные комментарии по кандидатам: после решения они показываются в карточке, как в настоящей верификации
  const [comments, setComments] = React.useState<Record<string, string>>({});
  const [histories, setHistories] = React.useState<Record<string, DecisionEntry[]>>({});
  const [versions, setVersions] = React.useState<Record<string, EvidenceVersionEntry[]>>({});
  const [fragments, setFragments] = React.useState<Record<string, TrainerFragment[]>>({});
  const pendingRef = React.useRef(pending);
  pendingRef.current = pending;

  // Правка доказательств и разделение
  const [editMode, setEditMode] = React.useState(false);
  const [draftAdd, setDraftAdd] = React.useState<DraftFragment[]>([]);
  const [draftRemove, setDraftRemove] = React.useState<string[]>([]);
  const [splitOpen, setSplitOpen] = React.useState(false);

  // Массовый выбор
  const [bulkSelected, setBulkSelected] = React.useState<string[]>([]);
  const [bulkClarify, setBulkClarify] = React.useState(false);
  const [bulkComment, setBulkComment] = React.useState('');

  // Гипотезы
  const [hypStatus, setHypStatus] = React.useState<Record<string, TrainerHypothesisStatus>>({});
  const [selectedHypId, setSelectedHypId] = React.useState<string | undefined>(undefined);
  const [promotingId, setPromotingId] = React.useState<string | undefined>(undefined);
  const [hypDrafts, setHypDrafts] = React.useState<DraftFragment[]>([]);
  const [pendingSelect, setPendingSelect] = React.useState<string | undefined>(undefined);
  const hypotheses = TRAINER_HYPOTHESES;
  const statusOfHyp = (h: TrainerHypothesis): TrainerHypothesisStatus => hypStatus[h.id] ?? 'PENDING';
  const selectedHyp = hypotheses.find((h) => h.id === selectedHypId);

  const current = candidates[Math.min(state.index, candidates.length - 1)];
  const fragsOf = (c: TrainerCandidate): TrainerFragment[] => fragments[c.id] ?? fragmentsOf(c);
  const versionsOf = (c: TrainerCandidate): EvidenceVersionEntry[] =>
    versions[c.id] ?? [{ version: 1, source: 'MODEL', at: '16.10.26 12:00', fragments: fragmentsOf(c).length }];

  const record = (id: string, entry: Omit<DecisionEntry, 'at'>) =>
    setHistories((prev) => ({ ...prev, [id]: [{ ...entry, at: nowText() }, ...(prev[id] ?? [])] }));

  // Нажатие там, где настоящая страница ушла бы на другую вкладку: в обучении переходов нет (об этом сказано над экраном)
  const goElsewhere = () => {
    act('other');
  };

  /** Выполняем действие экрана, только если урок его разрешил. */
  const run = React.useCallback(
    (guideAction: string, action: TrainerAction) => {
      if (act(guideAction)) dispatch(action);
    },
    [act]
  );

  const selectCandidate = (index: number) => {
    if (!act('select')) return;
    setSelectedHypId(undefined);
    dispatch({ type: 'select', index });
  };

  const confirmCurrent = () => {
    if (!act('confirm')) return;
    dispatch({ type: 'confirm' });
    record(current.id, { action: 'CONFIRM' });
  };
  const startClarify = () => {
    if (!act('clarify')) return;
    setPending({ kind: 'clarify' });
    setComment('');
  };
  const pickReason = React.useCallback(
    (reason: TrainerRejectReason) => {
      if (!act(`reject:${reason}`)) return;
      setPending({ kind: 'reject', reason });
      setComment(REJECT_TEMPLATES[reason]);
    },
    [act]
  );
  const submitPending = (): boolean => {
    const form = pending;
    const text = comment.trim();
    if (!form || !text) return false;
    if (form.kind === 'reject') {
      if (!act('send-comment')) return false;
      const keep = state.index;
      dispatch({ type: 'reject', reason: form.reason });
      // В уроке остаёмся на принятом решении, чтобы показать «Изменить решение»; обычная верификация идёт к следующему кандидату
      if (step?.id === 'comment') dispatch({ type: 'select', index: keep });
      record(current.id, { action: 'REJECT', reasonCode: form.reason, comment: text });
    } else {
      if (!act('send-clarify')) return false;
      dispatch({ type: 'clarify' });
      record(current.id, { action: 'CLARIFY', comment: text });
      // Урок: уточнение отправлено (кнопкой, Enter в поле или «Далее»), дальше разбираем отклонение у кандидата с плитами перекрытия, список причин открыт
      if (step?.id === 'clarify') {
        dispatch({ type: 'select', index: Math.max(0, candidates.findIndex((c) => c.id === 'trainer-3')) });
        dispatch({ type: 'toggle-reject-menu' });
      }
    }
    setComments((prev) => ({ ...prev, [current.id]: text }));
    setPending(null);
    setComment('');
    return true;
  };
  const cancelPending = React.useCallback(() => {
    if (!act('cancel-comment')) return;
    setPending(null);
    dispatch({ type: 'escape' });
  }, [act]);

  // Правка доказательств
  const cancelEdit = () => {
    if (!act('edit-cancel')) return;
    setEditMode(false);
    setDraftAdd([]);
    setDraftRemove([]);
  };
  const toggleEdit = () => {
    if (editMode) {
      cancelEdit();
      return;
    }
    if (!act('edit-open')) return;
    setEditMode(true);
  };
  const saveEdit = (reason: string, reference: string) => {
    if (!act('edit-save')) return;
    const kept = fragsOf(current).filter((f) => !draftRemove.includes(f.id));
    const added: TrainerFragment[] = draftAdd.map((d) => ({
      id: `${current.id}-m-${d.key}`,
      stage: d.stage,
      page: d.page,
      value: d.value,
      role: d.role,
      manual: true,
      image: d.fileId,
      bbox: d.bbox,
    }));
    const all = [...kept, ...added];
    setFragments((prev) => ({ ...prev, [current.id]: all }));
    const list = versionsOf(current);
    setVersions((prev) => ({
      ...prev,
      [current.id]: [...list, { version: list.length + 1, source: 'INSPECTOR', at: nowText(), reason, reference, fragments: all.length }],
    }));
    setEditMode(false);
    setDraftAdd([]);
    setDraftRemove([]);
  };
  const addDraft = (stage: TrainerStage, doc: TrainerDoc, box: { x: number; y: number; w: number; h: number }) =>
    setDraftAdd((prev) => [...prev, { key: `d${Date.now()}${prev.length}`, stage, fileId: doc.image, page: doc.page, bbox: box, role: stage === 'ПД' ? 'EXPECTED' : 'ACTUAL', value: '' }]);

  // Разделение составного кандидата на части
  const submitSplit = (parts: SplitPartValues[]) => {
    if (!act('split-save')) return;
    const all = fragsOf(current);
    const made: TrainerCandidate[] = parts.map((part, i) => {
      const chosen = all.filter((f) => part.fragment_ids.includes(f.id));
      const docs: TrainerCandidate['docs'] = {};
      chosen.forEach((f) => {
        const doc = current.docs[f.stage];
        if (doc && !docs[f.stage]) docs[f.stage] = doc;
      });
      return {
        ...current,
        id: `${current.id}-p${i + 1}`,
        name: `${current.name}: ${part.rule_key}`,
        values: chosen.filter((f, k) => chosen.findIndex((g) => g.stage === f.stage) === k).map((f) => ({ stage: f.stage, value: part.expected_value && f.role === 'EXPECTED' ? part.expected_value : part.actual_value && f.role === 'ACTUAL' ? part.actual_value : f.value })),
        docs,
        stageRows: [],
        rationale: part.comment || current.rationale,
      };
    });
    setFragments((prev) => {
      const next = { ...prev };
      made.forEach((c, i) => {
        next[c.id] = all.filter((f) => parts[i].fragment_ids.includes(f.id));
      });
      return next;
    });
    setCandidates((prev) => prev.flatMap((c) => (c.id === current.id ? made : [c])));
    setSplitOpen(false);
  };

  // Массовое решение
  const isPendingCandidate = (c: TrainerCandidate) => verdictOf(state, c) === 'pending';
  const bulkGroupOf = (code: string) => candidates.filter((c) => c.code === code && isPendingCandidate(c));
  const selectedCandidates = candidates.filter((c) => bulkSelected.includes(c.id));
  const bulkCode = selectedCandidates[0]?.code ?? (isPendingCandidate(current) ? current.code : undefined);
  const bulkGroup = bulkCode ? bulkGroupOf(bulkCode) : [];
  const canSelectForBulk = (c: TrainerCandidate) => isPendingCandidate(c) && (selectedCandidates.length === 0 || selectedCandidates[0].code === c.code);
  const toggleBulk = (c: TrainerCandidate) => {
    if (!act('bulk-toggle') || !canSelectForBulk(c)) return;
    setBulkSelected((prev) => (prev.includes(c.id) ? prev.filter((x) => x !== c.id) : [...prev, c.id]));
  };
  const selectAllBulk = () => {
    if (!act('bulk-select')) return;
    setBulkSelected(bulkGroup.map((c) => c.id));
  };
  const clearBulk = () => {
    if (!act('bulk-clear')) return;
    setBulkSelected([]);
    setBulkClarify(false);
    setBulkComment('');
  };
  const runBulk = (verdict: 'confirmed' | 'clarification', text?: string) => {
    if (!act('bulk-run')) return;
    dispatch({ type: 'decide-many', ids: bulkSelected, verdict });
    bulkSelected.forEach((id) => {
      record(id, verdict === 'confirmed' ? { action: 'CONFIRM' } : { action: 'CLARIFY', comment: text });
      if (text) setComments((prev) => ({ ...prev, [id]: text }));
    });
    setBulkSelected([]);
    setBulkClarify(false);
    setBulkComment('');
  };
  const confirmBulk = () => {
    if (!act('bulk-confirm')) return;
    Modal.confirm({
      title: `Подтвердить нарушений: ${bulkSelected.length}?`,
      content: `Параметр ${bulkCode}. Каждый кандидат получит решение «Подтверждено», отменить можно по одному: «Изменить решение».`,
      okText: 'Подтвердить',
      cancelText: 'Отмена',
      onOk: () => runBulk('confirmed'),
    });
  };

  // Гипотезы
  const selectHypothesis = (id: string) => {
    if (!act('hyp-select')) return;
    setSelectedHypId(id);
  };
  const startPromote = () => {
    if (!act('hyp-promote')) return;
    if (selectedHyp) setPromotingId(selectedHyp.id);
    setHypDrafts([]);
  };
  const cancelPromote = () => {
    if (!act('hyp-promote-cancel')) return;
    setPromotingId(undefined);
    setHypDrafts([]);
  };
  const promote = (input: PromoteInput) => {
    if (!selectedHyp || !act('hyp-promote-save')) return;
    const h = selectedHyp;
    const evidence = h.evidence.filter((_, i) => input.kept.includes(i));
    const docs: TrainerCandidate['docs'] = {};
    evidence.forEach((e) => {
      if (!docs[e.stage]) docs[e.stage] = e.doc;
    });
    hypDrafts.forEach((d) => {
      if (!docs[d.stage]) docs[d.stage] = { name: d.fileId, image: d.fileId, page: d.page, pages: 1, mark: d.bbox };
    });
    const values = [
      ...evidence.map((e) => ({ stage: e.stage, value: e.value })),
      ...hypDrafts.map((d) => ({ stage: d.stage, value: d.value || 'нет' })),
    ].filter((v, i, all) => all.findIndex((x) => x.stage === v.stage) === i);
    const candidate: TrainerCandidate = {
      id: `trainer-${h.id}`,
      code: input.code,
      name: input.name,
      section: input.section,
      priority: h.priority,
      values,
      docs,
      rule: `Кандидат из гипотезы: ${input.comment || h.description}`,
      rationale: h.description,
      stageRows: [],
    };
    setCandidates((prev) => [...prev, candidate]);
    setHypStatus((prev) => ({ ...prev, [h.id]: 'PROMOTED' }));
    setPromotingId(undefined);
    setHypDrafts([]);
    setSelectedHypId(undefined);
    setPendingSelect(candidate.id);
  };
  const decideHypothesis = (kind: 'DISMISS' | 'CLARIFY') => {
    if (!selectedHyp || !act('hyp-decide')) return false;
    setHypStatus((prev) => ({ ...prev, [selectedHyp.id]: kind === 'DISMISS' ? 'DISMISSED' : 'CLARIFICATION_REQUIRED' }));
    return true;
  };
  // Новый кандидат появляется в списке после перерисовки, поэтому открываем его отдельным шагом
  React.useEffect(() => {
    if (!pendingSelect) return;
    const index = candidates.findIndex((c) => c.id === pendingSelect);
    if (index < 0) return;
    dispatch({ type: 'select', index });
    setPendingSelect(undefined);
  }, [candidates, pendingSelect]);

  // Сравнение листов
  const switchMode = (mode: 'panels' | 'compare') => {
    if (centerMode === mode) return;
    if (!act(mode === 'compare' ? 'compare-open' : 'compare-close')) return;
    setCenterMode(mode);
  };

  // Esc закрывает открытое на экране (форму, правку, выбор, список причин, полный экран); по расписанию урока и только когда это ожидается
  const escapeRef = React.useRef<() => boolean>(() => false);
  escapeRef.current = () => {
    if (pending) {
      cancelPending();
      return true;
    }
    if (editMode) {
      cancelEdit();
      return true;
    }
    if (promotingId) {
      cancelPromote();
      return true;
    }
    if (bulkSelected.length > 0) {
      clearBulk();
      return true;
    }
    const open = stateRef.current;
    if (!hasOpenAction(open)) return false;
    if (open.rejectMenuOpen) {
      if (act('close-reasons')) dispatch({ type: 'escape' });
    } else if (act('fullscreen-close')) {
      dispatch({ type: 'escape' });
    }
    return true;
  };
  React.useEffect(() => {
    registerEscape(() => escapeRef.current());
    return () => registerEscape(null);
  }, [registerEscape]);

  // Enter делает то, что урок просит сейчас
  React.useEffect(() => {
    registerEnter(() => {
      switch (step?.id) {
        case 'decision':
          // Начинаем с уточнения у кандидата, где из документов не видно, какая редакция действует: открываем форму комментария
          if (act('decision-demo')) {
            dispatch({ type: 'select', index: Math.max(0, candidates.findIndex((c) => c.id === 'trainer-2')) });
            setPending({ kind: 'clarify' });
            setComment('Какая редакция фундаментной плиты действует: проектная (B30) или рабочая (B25)?');
          }
          break;
        case 'clarify':
          submitPending();
          break;
        case 'decide':
          confirmCurrent();
          break;
        case 'reasons':
          pickReason('WRONG_REVISION');
          break;
        case 'comment':
          submitPending();
          break;
        case 'open':
          run('fullscreen-open', { type: 'toggle-fullscreen' });
          break;
        case 'show-list':
          run('list-open', { type: 'toggle-list-panel' });
          break;
        case 'panel':
          run('evidence-open', { type: 'toggle-evidence-panel' });
          break;
        case 'exit':
          run('fullscreen-close', { type: 'toggle-fullscreen' });
          break;
      }
    });
    return () => registerEnter(null);
  });

  const counts = trainerCounts(state, candidates);
  const solved = counts.total - counts.pending;
  const pct = (n: number) => (counts.total ? (n / counts.total) * 100 : 0);

  // Клавиши как в верификации; в полях ввода и пока открыто окно (выход, горячие клавиши) не срабатывают
  const keysRef = React.useRef<(e: KeyboardEvent) => void>(() => undefined);
  keysRef.current = (e) => {
    const target = e.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (pendingRef.current || hotkeysOpen || splitOpen) return;
    const open = stateRef.current;
    if (e.key === '?' || (e.shiftKey && e.code === 'Slash')) {
      e.preventDefault();
      if (act('help')) setHotkeysOpen(true);
      return;
    }
    if (selectedHypId) return; // у гипотезы свои кнопки решения
    // У кандидата с решением кнопок решения нет, клавиши 1, 2, 3 молчат, пока не нажато «Изменить решение»
    if (!open.rejectMenuOpen && ['1', '2', '3'].includes(e.key) && verdictOf(open, current) !== 'pending') return;
    if (e.code === 'KeyF') {
      e.preventDefault();
      run(open.fullscreen ? 'fullscreen-close' : 'fullscreen-open', { type: 'toggle-fullscreen' });
    } else if (e.code === 'KeyE') {
      e.preventDefault();
      toggleEdit();
    } else if (e.code === 'KeyS') {
      if (fragsOf(current).length >= 2 && verdictOf(open, current) === 'pending') {
        e.preventDefault();
        if (act('split-open')) setSplitOpen(true);
      }
    } else if (open.rejectMenuOpen && /^[1-8]$/.test(e.key)) {
      e.preventDefault();
      pickReason(REJECT_KEYS[Number(e.key) - 1]);
    } else if (e.key === '1') {
      e.preventDefault();
      confirmCurrent();
    } else if (e.key === '2') {
      e.preventDefault();
      run('toggle-reject', { type: 'toggle-reject-menu' });
    } else if (e.key === '3') {
      e.preventDefault();
      startClarify();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      moveVisible(e.key === 'ArrowRight' ? 1 : -1);
    } else if (e.key === 'n' || e.key === 'N' || e.key === 'т' || e.key === 'Т') {
      e.preventDefault();
      if (act('next')) {
        setSelectedHypId(undefined);
        dispatch({ type: 'next-pending' });
      }
    }
  };
  React.useEffect(() => {
    if (paused) return;
    const onKey = (e: KeyboardEvent) => keysRef.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paused]);

  // Список: кандидаты (с учётом фильтров, раздела и «только эта страница»), затем гипотезы
  const matchesQuery = (text: string) => {
    const q = query.trim().toLowerCase();
    return !q || text.toLowerCase().includes(q);
  };
  const sharesPage = (c: TrainerCandidate) =>
    STAGES.some((st) => {
      const a = c.docs[st];
      const b = current.docs[st];
      return Boolean(a && b && a.image === b.image && a.page === b.page);
    });
  const visibleCandidates = showCandidates
    ? candidates
        .map((c, i) => ({ c, i }))
        .filter(
          ({ c }) =>
            (filter === 'all' || verdictOf(state, c) === FILTER_OF[filter]) &&
            matchesQuery(`${c.code} ${c.name}`) &&
            (!sectionFilter || c.section === sectionFilter) &&
            (!onlyThisPage || sharesPage(c))
        )
    : [];
  const visibleHypotheses = showHypotheses
    ? hypotheses.filter((h) => (hypFilter === 'all' || statusOfHyp(h) === hypFilter) && matchesQuery(`${h.method} ${h.description} ${h.refs}`))
    : [];
  const itemKeys = [...visibleCandidates.map(({ c }) => `c:${c.id}`), ...visibleHypotheses.map((h) => `h:${h.id}`)];
  const currentKey = selectedHyp ? `h:${selectedHyp.id}` : `c:${current.id}`;
  const position = itemKeys.indexOf(currentKey);
  const moveVisible = (delta: 1 | -1) => {
    const key = itemKeys[position + delta];
    if (!key) return;
    if (key.startsWith('h:')) {
      selectHypothesis(key.slice(2));
    } else {
      const index = candidates.findIndex((c) => `c:${c.id}` === key);
      if (index >= 0) selectCandidate(index);
    }
  };

  const tabCounts: Record<CandidateFilter, number> = {
    all: counts.total,
    pending: counts.pending,
    confirmed: counts.confirmed,
    rejected: counts.rejected,
    clarified: counts.clarification,
  };
  const hypCounts: Record<SuspicionFilter, number> = {
    all: hypotheses.length,
    PENDING: hypotheses.filter((h) => statusOfHyp(h) === 'PENDING').length,
    CLARIFICATION_REQUIRED: hypotheses.filter((h) => statusOfHyp(h) === 'CLARIFICATION_REQUIRED').length,
    DISMISSED: hypotheses.filter((h) => statusOfHyp(h) === 'DISMISSED').length,
    PROMOTED: hypotheses.filter((h) => statusOfHyp(h) === 'PROMOTED').length,
  };
  const sections = [...new Set(candidates.map((c) => c.section))];
  const chooseSection = (section: string) => {
    setSectionFilter(section);
    if (section && current.section !== section) {
      const first = candidates.findIndex((c) => c.section === section);
      if (first !== -1) dispatch({ type: 'select', index: first });
    }
  };
  const sectionSelect =
    sections.length > 1 ? (
      <div className={hl('sections')} data-tt="sections">
        <Select
          className="vw-section-select"
          showSearch
          allowClear
          aria-label="Раздел"
          placeholder={`Все разделы (${candidates.length})`}
          value={sectionFilter || undefined}
          onChange={(value) => {
            if (act('section')) chooseSection(value ?? '');
          }}
          optionFilterProp="label"
          options={sections.map((s) => ({ value: s, label: `${s} (${candidates.filter((c) => c.section === s).length})` }))}
          style={{ width: '100%' }}
          notFoundContent="Такого раздела нет"
        />
      </div>
    ) : null;

  const header = (
    <div className="vw-header">
      <div className="vw-header-top">
        <div className="vw-title">
          <h2>Верификация проекта «{TRAINING_PROJECT}»</h2>
        </div>
        <div className="vw-header-actions" style={{ display: 'flex', gap: 8 }}>
          <button className={`btn-white ${hl('btn-upload')}`} data-tt="btn-upload" style={WHITE_BUTTON} onClick={goElsewhere}>
            ↑︎ Дозагрузить
          </button>
          <button className={hl('btn-protocol')} data-tt="btn-protocol" style={TEAL_BUTTON} onClick={goElsewhere}>
            Перейти к протоколу
          </button>
        </div>
      </div>
      <div className={`vw-progress-wrap ${hl('progress')}`} data-tt="progress">
        <span style={{ fontSize: '11.5px', fontWeight: 700, color: '#667085', whiteSpace: 'nowrap' }}>
          {solved}/{counts.total} проверено
        </span>
        <div className="vw-progress-bar">
          <div className="seg-confirmed" style={{ width: `${pct(counts.confirmed)}%` }} />
          <div className="seg-rejected" style={{ width: `${pct(counts.rejected)}%` }} />
          <div className="seg-clarified" style={{ width: `${pct(counts.clarification)}%` }} />
        </div>
        <div className="vw-legend-mini">
          <span>
            <div className="dot dot-green" />
            Подтверждено: {counts.confirmed}
          </span>
          <span>
            <div className="dot dot-red" />
            Отклонено: {counts.rejected}
          </span>
          <span>
            <div className="dot dot-gray" />
            Уточнено: {counts.clarification}
          </span>
          <span>
            <div className="dot dot-yellow" />
            Ожидает: {counts.pending}
          </span>
        </div>
        <button
          className={`tool-btn vw-help-btn ${hl('help')}`}
          data-tt="help"
          onClick={() => {
            if (act('help')) setHotkeysOpen(true);
          }}
          title="Горячие клавиши (Shift + /)"
          aria-label="Горячие клавиши"
        >
          ?
        </button>
      </div>
    </div>
  );

  // Флажок в строке списка: нужен, где есть что решать разом (не меньше двух кандидатов параметра без решения)
  const renderBulkCheck = (c: TrainerCandidate) => {
    if (!isPendingCandidate(c)) return null;
    if (bulkGroupOf(c.code).length < 2 && !bulkSelected.includes(c.id)) return null;
    const allowed = canSelectForBulk(c);
    return (
      <input
        type="checkbox"
        className={`bulk-check ${hl('bulk-check')}`}
        data-tt="bulk-check"
        checked={bulkSelected.includes(c.id)}
        disabled={!allowed}
        onClick={(e) => e.stopPropagation()}
        onChange={() => toggleBulk(c)}
        title={allowed ? 'Отметить, чтобы подтвердить или отправить на уточнение сразу несколько кандидатов одного параметра' : 'Массовое решение: только по одному параметру'}
        aria-label={`Отметить ${c.code}`}
      />
    );
  };

  const renderListItem = ({ c, i }: { c: TrainerCandidate; i: number }) => {
    const badge = VERDICT_BADGE[verdictOf(state, c)];
    return (
      <div key={c.id} className={`finding-item ${!selectedHyp && i === state.index ? 'selected' : ''}`} onClick={() => selectCandidate(i)}>
        <div className="row1">
          {renderBulkCheck(c)}
          <span className="code">{c.code}</span>
          <span className={`badge ${badge.cls}`}>{badge.label}</span>
        </div>
        <div className="pname">{c.name}</div>
        <div className="vals">
          {c.values.map((v) => (
            <span key={v.stage}>
              <b>{v.stage}:</b> {v.value}
            </span>
          ))}
        </div>
      </div>
    );
  };

  const renderHypothesisItem = (h: TrainerHypothesis) => {
    const badge = HYPOTHESIS_BADGE[statusOfHyp(h)];
    return (
      <div key={h.id} className={`finding-item is-hypothesis ${selectedHypId === h.id ? 'selected' : ''} ${h.id === hypotheses[0].id ? hl('hyp-item') : ''}`} data-tt={h.id === hypotheses[0].id ? 'hyp-item' : undefined} onClick={() => selectHypothesis(h.id)}>
        <div className="row1">
          <span className="code">Гипотеза: {h.method}</span>
          <span className={`badge ${badge.cls}`}>{badge.label}</span>
        </div>
        <div className="pname">{h.description}</div>
        <div className="vals">
          <span>{h.refs}</span>
        </div>
      </div>
    );
  };

  // Панель массового решения над списком: только подтверждение и уточнение, отклонять можно лишь по одному
  const renderBulkBar = () => {
    if (!bulkCode) return null;
    if (selectedCandidates.length === 0) {
      if (bulkGroup.length < 2) return null;
      return (
        <div className={`bulk-bar ${hl('bulk-bar')}`} data-tt="bulk-bar">
          <button className="bulk-link" onClick={selectAllBulk}>
            ☐ Выбрать все по {bulkCode}: {bulkGroup.length} шт. и решить сразу
          </button>
        </div>
      );
    }
    return (
      <div className={`bulk-bar bulk-bar-active ${hl('bulk-bar')}`} data-tt="bulk-bar">
        <div className="bulk-title">
          Выбрано: {selectedCandidates.length} по {bulkCode}
        </div>
        <div className="bulk-actions">
          <button className="btn btn-success" onClick={confirmBulk}>
            ✓ Подтвердить: {selectedCandidates.length} шт.
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              if (act('bulk-clarify')) setBulkClarify((v) => !v);
            }}
          >
            ? Уточнить: {selectedCandidates.length} шт.
          </button>
          <button className="btn btn-ghost negative-action" onClick={clearBulk}>
            Сбросить
          </button>
        </div>
        {bulkGroup.length > selectedCandidates.length && (
          <button className="bulk-link" onClick={selectAllBulk}>
            ☐ Выбрать все по {bulkCode}: {bulkGroup.length} шт.
          </button>
        )}
        {bulkClarify && (
          <div className="bulk-clarify">
            <textarea value={bulkComment} onChange={(e) => setBulkComment(e.target.value)} rows={2} placeholder="Что нужно уточнить (обязательно)" />
            <button className="btn btn-primary" disabled={!bulkComment.trim()} onClick={() => runBulk('clarification', bulkComment.trim())}>
              Отправить на уточнение
            </button>
          </div>
        )}
        <div className="bulk-hint">Массового отклонения нет: каждое отклонение - по отдельности, с причиной.</div>
      </div>
    );
  };

  const leftColumn = (
    <div className="vw-col-findings">
      <div className={hl('filters')} data-tt="filters">
        <ListFilters
          candidates={{ open: showCandidates, onToggle: () => setShowCandidates((v) => !v), counts: tabCounts, value: filter, onChange: (key) => {
              if (act('filter')) setFilter(key);
            } }}
          hypotheses={{ open: showHypotheses, onToggle: () => setShowHypotheses((v) => !v), counts: hypCounts, value: hypFilter, onChange: setHypFilter }}
          query={query}
          onQuery={setQuery}
          extra={sectionSelect}
        />
      </div>
      <div className={`vw-nav ${hl('nav')}`} data-tt="nav">
        <button className="tool-btn" onClick={() => moveVisible(-1)} disabled={position <= 0} title="Предыдущее (←)" aria-label="Предыдущий кандидат">
          ←
        </button>
        <span className="vw-nav-pos">{itemKeys.length === 0 ? 'Ничего не найдено' : `${position + 1} из ${itemKeys.length}`}</span>
        <button className="tool-btn" onClick={() => moveVisible(1)} disabled={position < 0 || position >= itemKeys.length - 1} title="Следующее (→)" aria-label="Следующий кандидат">
          →
        </button>
        <label className="vw-nav-page" title="Показать только кандидатов с доказательством на страницах, которые открыты сейчас">
          <input type="checkbox" checked={onlyThisPage} onChange={(e) => {
              if (act('only-page')) setOnlyThisPage(e.target.checked);
            }} /> Только эта страница
        </label>
      </div>
      {renderBulkBar()}
      <div className={`vw-findings-list ${hl('list')}`} data-tt="list">
        {visibleCandidates.map(renderListItem)}
        {visibleHypotheses.map(renderHypothesisItem)}
        {itemKeys.length === 0 && (
          <div className="sus-empty" style={{ padding: 16 }}>
            Ничего не найдено
          </div>
        )}
      </div>
    </div>
  );

  // Рамки доказательств на странице: фрагменты этой страницы, в правке без убранных, плюс нарисованные
  const panelMarks = (stage: TrainerStage, doc: TrainerDoc) => (
    <>
      {showMarks &&
        fragsOf(current)
          .filter((f) => f.stage === stage && f.page === doc.page && f.image === doc.image && !(editMode && draftRemove.includes(f.id)))
          .map((f) => <MarkBox key={f.id} mark={{ bbox: f.bbox, label: f.value, color: ROLE_COLORS[f.role] }} />)}
      {editMode &&
        draftAdd
          .filter((d) => d.stage === stage && d.page === doc.page && d.fileId === doc.image)
          .map((d) => <MarkBox key={d.key} mark={{ bbox: d.bbox, label: `новая${d.value ? `: ${d.value}` : ''}`, color: ROLE_COLORS[d.role] }} />)}
    </>
  );

  const docHead = (stage: TrainerStage, doc: TrainerDoc) => (
    <div className="doc-panel-head">
      <span className="stage" style={{ background: STAGE_COLORS[stage] }}>
        {stage}
      </span>
      <span className="dname">{doc.name}</span>
      <span style={{ fontSize: '11px', color: '#667085', marginLeft: 'auto', whiteSpace: 'nowrap' }}>стр. {doc.page}</span>
    </div>
  );

  const docTools = (doc: TrainerDoc) => (
    <div className="doc-panel-tools">
      <div className="grp">
        <button className="tool-btn" disabled title="Предыдущая страница (PgUp, во всех панелях)">
          ←
        </button>
        <span style={{ fontSize: '11px', padding: '0 8px' }}>
          {doc.page} / {doc.pages}
        </span>
        <button className="tool-btn" disabled title="Следующая страница (PgDn, во всех панелях)">
          →
        </button>
      </div>
      <div className="grp">
        <button className="tool-btn" title="Уменьшить" disabled={zoom <= 1} onClick={() => setZoom((z) => Math.max(1, z / 1.5))}>
          −
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button className="tool-btn" title="Увеличить" disabled={zoom >= 6} onClick={() => setZoom((z) => Math.min(6, z * 1.5))}>
          +
        </button>
        <button className="tool-btn tool-btn-text" title="Вписать страницу" onClick={() => setZoom(1)}>
          Вписать
        </button>
      </div>
    </div>
  );

  // Панель стадии без доказательств: «Документы стадии загружены, но значения не нашли», как в настоящей
  const renderEmptyPanel = (stage: TrainerStage, forHypothesis = false) => (
    <div key={stage} className="doc-panel doc-panel-empty">
      <div className="doc-panel-head">
        <span className="stage" style={{ background: STAGE_COLORS[stage] }}>
          {stage}
        </span>
        <span className="dname">Нет доказательств</span>
      </div>
      <div className="doc-panel-empty-body">
        <div>{forHypothesis ? `Документы стадии ${stage} загружены, но у гипотезы нет области на этой стадии.` : `Документы стадии ${stage} загружены, но система не нашла в них значение для этого параметра.`}</div>
        <button className="btn-white" style={WHITE_BUTTON} onClick={goElsewhere}>
          ↑︎ Дозагрузить
        </button>
      </div>
    </div>
  );

  const renderDocPanel = (stage: TrainerStage) => {
    const doc = current.docs[stage];
    if (!doc) return renderEmptyPanel(stage);
    return (
      <div key={stage} className="doc-panel">
        {docHead(stage, doc)}
        <div className="doc-panel-canvas">
          <div className="blueprint-page pdf-stage" style={{ cursor: editMode ? 'crosshair' : 'grab', overflow: 'hidden' }}>
            <PageImage doc={doc} zoom={zoom} onDraw={editMode ? (box) => addDraft(stage, doc, box) : undefined}>
              {panelMarks(stage, doc)}
            </PageImage>
          </div>
        </div>
        {docTools(doc)}
      </div>
    );
  };

  // Центр для гипотезы: две страницы с областью гипотезы; при «Сделать кандидатом» на них рисуются рамки
  const renderHypothesisPanel = (e: TrainerHypothesis['evidence'][number], i: number) => (
    <div key={i} className="doc-panel">
      {docHead(e.stage, e.doc)}
      <div className="doc-panel-canvas">
        <div className="blueprint-page pdf-stage" style={{ cursor: promotingId ? 'crosshair' : 'grab', overflow: 'hidden' }}>
          <PageImage
            doc={e.doc}
            zoom={zoom}
            onDraw={promotingId ? (box) => setHypDrafts((prev) => [...prev, { key: `h${Date.now()}${prev.length}`, stage: e.stage, fileId: e.doc.image, page: e.doc.page, bbox: box, role: e.stage === 'ПД' ? 'EXPECTED' : 'ACTUAL', value: '' }]) : undefined}
          >
            {showMarks && <MarkBox mark={{ bbox: e.doc.mark, label: e.value, color: HYP_COLOR }} />}
            {hypDrafts
              .filter((d) => d.fileId === e.doc.image && d.page === e.doc.page)
              .map((d) => (
                <MarkBox key={d.key} mark={{ bbox: d.bbox, label: `новая${d.value ? `: ${d.value}` : ''}`, color: ROLE_COLORS[d.role] }} />
              ))}
          </PageImage>
        </div>
      </div>
      {docTools(e.doc)}
    </div>
  );

  const centerSwitch = (
    <div className={`cmp-seg ${hl('modes')}`} data-tt="modes" role="group" aria-label="Режим центра">
      <button className={centerMode === 'panels' ? 'is-on' : ''} onClick={() => switchMode('panels')} title="Документы трёх стадий рядом: доказательства выбранного кандидата">
        <span className="lbl-full">Панели ПД / РД / ИД</span>
        <span className="lbl-short">Панели</span>
      </button>
      <button className={centerMode === 'compare' ? 'is-on' : ''} onClick={() => switchMode('compare')} title="Листы разных стадий, наложенные друг на друга: видно, что изменилось">
        <span className="lbl-full">Сравнение листов</span>
        <span className="lbl-short">Листы</span>
      </button>
    </div>
  );
  const syncToggle = (
    <button
      className={`btn btn-ghost sync-toggle-btn ${hl('sync')}`}
      data-tt="sync"
      onClick={() => {
        if (act('sync')) setSync((v) => !v);
      }}
      title="Масштаб и сдвиг меняются во всех панелях сразу"
    >
      {sync ? '🔗 Панели синхронны' : 'Панели независимы'}
    </button>
  );
  const marksToggle = (
    <button
      className={`btn btn-ghost sync-toggle-btn ${hl('marks')}`}
      data-tt="marks"
      onClick={() => {
        if (act('marks')) setShowMarks((v) => !v);
      }}
      title="Скрыть или показать рамки доказательства поверх документа"
    >
      {showMarks ? '▢ Скрыть рамки' : '▢ Показать рамки'}
    </button>
  );
  const fullscreenButton = (
    <button className={`btn btn-ghost fullscreen-toggle-btn ${hl('fs-open')}`} data-tt="fs-open" onClick={() => run('fullscreen-open', { type: 'toggle-fullscreen' })}>
      ⛶ Во весь экран <span className="key-hint">F</span>
    </button>
  );

  const renderDecisionBar = () => (
    <>
      {fragsOf(current).length >= 2 && (
        <button
          className={`btn btn-ghost btn-block split-btn ${hl('split')}`}
          data-tt="split"
          onClick={() => {
            if (act('split-open')) setSplitOpen(true);
          }}
          title="Горячая клавиша S"
        >
          ✂ Разделить на части <span className="key-hint">S</span>
        </button>
      )}
      <div className="decision-btns">
        <button className={`btn btn-success btn-block ${hl('btn-confirm')}`} data-tt="btn-confirm" onClick={confirmCurrent}>
          ✓ Подтвердить нарушение <span className="key-hint">1</span>
        </button>
        <button
          className={`btn btn-danger btn-block negative-action ${hl('btn-reject')}`}
          data-tt="btn-reject"
          onClick={() => run('toggle-reject', { type: 'toggle-reject-menu' })}
          aria-expanded={state.rejectMenuOpen}
        >
          ✕ Отклонить {state.rejectMenuOpen ? '▴' : '▾'} <span className="key-hint">2</span>
        </button>
        {state.rejectMenuOpen && !pending && (
          <div className={`reject-reasons ${hl('reasons')}`} data-tt="reasons">
            {REJECT_KEYS.map((key, i) => (
              <button key={key} className="btn btn-ghost btn-block reject-reason" onClick={() => pickReason(key)}>
                <span className="key-hint">{i + 1}</span>
                <span>{REJECT_REASON[key].label}</span>
              </button>
            ))}
          </div>
        )}
        <button className={`btn btn-primary btn-block ${hl('btn-clarify')}`} data-tt="btn-clarify" onClick={startClarify}>
          ? Уточнить <span className="key-hint">3</span>
        </button>
        {pending && (
          <div className={`decision-form decision-comment ${hl('comment-form')}`} data-tt="comment-form">
            <div style={{ fontSize: '12.5px', fontWeight: 700, marginBottom: 8 }}>
              {pending.kind === 'reject' ? `Причина: ${REJECT_REASON[pending.reason].label.charAt(0).toLowerCase() + REJECT_REASON[pending.reason].label.slice(1)}` : 'Уточнение'}
            </div>
            <label style={{ display: 'block', fontSize: '12px', marginBottom: 6 }}>{pending.kind === 'reject' ? 'Комментарий для дообучения ИИ *' : 'Что нужно уточнить *'}</label>
            <textarea
              autoFocus
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submitPending();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelPending();
                }
              }}
              placeholder={pending.kind === 'reject' ? 'Обоснование решения…' : 'Опишите, что нужно уточнить…'}
              style={{ width: '100%', minHeight: 80, resize: 'vertical', fontSize: '13px', border: '1px solid #CBD3DE', borderRadius: '5px', padding: '8px 10px', fontFamily: 'inherit', marginBottom: 8, boxSizing: 'border-box' }}
            />
            <div className="hint" style={{ fontSize: '11px', color: '#667085', marginBottom: 10 }}>
              {pending.kind === 'reject'
                ? 'Комментарий обязателен: он станет примером для дообучения под контролем администратора. Текст подставлен по шаблону причины, его можно править.'
                : 'Комментарий обязателен: он попадёт в протокол и в запрос на уточнение.'}
            </div>
            <div className="decision-actions">
              <button className="btn btn-primary" onClick={submitPending} disabled={!comment.trim()} title="Enter">
                {pending.kind === 'reject' ? 'Отправить на дообучение' : 'Отправить на уточнение'}
              </button>
              <button className="btn btn-ghost negative-action" onClick={cancelPending} title="Esc">
                Отмена
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );

  const renderCard = () => {
    const verdict = verdictOf(state, current);
    const reason = state.reasons[current.id];
    const rows = current.stageRows;
    const history = histories[current.id] ?? [];
    const versionList = versionsOf(current);
    const actionLabel = { CONFIRM: 'Подтверждено', REJECT: 'Отклонено', CLARIFY: 'Уточнение' } as const;
    return (
      <>
        <div className="ev-block">
          <div className={`prio prio-${current.priority}`}>
            <span className="flag"></span>
            {current.priority === 'HIGH' ? 'ВЫСОКИЙ' : current.priority === 'MEDIUM' ? 'СРЕДНИЙ' : 'НИЗКИЙ'}
          </div>
        </div>
        <div className="ev-block">
          <div className="code" style={{ fontWeight: 800, fontSize: 14, marginBottom: 4, fontFamily: 'IBM Plex Mono, monospace' }}>
            {current.code}
          </div>
          <div style={{ fontSize: 13, color: '#667085', marginBottom: 16 }}>{current.name}</div>
        </div>
        <div className="ev-block">
          <div className="ev-lbl">Раздел</div>
          <div className="ev-field" style={{ fontSize: '12.5px' }}>
            {current.section}
          </div>
        </div>
        <div className={`ev-block ${hl('sources')}`} data-tt="sources">
          <div className="ev-lbl">Источники</div>
          {current.values.map((v) => (
            <div key={v.stage} className="src-row">
              <div className="stagechip" style={{ background: STAGE_COLORS[v.stage] }}>
                {v.stage}
              </div>
              <div className="d">
                <div className="fn">{v.value}</div>
                <div className="meta">стр. {current.docs[v.stage]?.page}</div>
              </div>
            </div>
          ))}
        </div>
        {current.gost && (
          <div className={`ev-block ${hl('gost')}`} data-tt="gost">
            <div className="ev-lbl">Нормативное основание</div>
            <div style={{ fontSize: '12px', lineHeight: 1.6 }}>{current.gost}</div>
          </div>
        )}
        {rows.length > 0 ? (
          <div className={`ev-block ${hl('rule')}`} data-tt="rule">
            <div className="ev-lbl">Правило срабатывания</div>
            <div style={{ fontSize: '12.5px', lineHeight: 1.6 }}>{current.rule}</div>
            <details style={{ marginTop: 6, fontSize: '12.5px', lineHeight: 1.6 }}>
              <summary style={{ cursor: 'pointer', color: '#64748B' }}>Подробнее</summary>
              <div style={{ marginTop: 4 }}>{current.rationale}</div>
            </details>
          </div>
        ) : (
          <div className={`ev-block ${hl('rule')}`} data-tt="rule">
            <div className="ev-lbl">Описание</div>
            <div style={{ fontSize: '12.5px', lineHeight: 1.6 }}>{current.rationale}</div>
          </div>
        )}
        {!editMode ? (
          <div className={`ev-block ${hl('edit-evidence')}`} data-tt="edit-evidence">
            <button className="btn btn-ghost btn-block" style={{ fontSize: '13px' }} onClick={toggleEdit}>
              ✎ Править доказательства <span className="key-hint">E</span>
            </button>
          </div>
        ) : (
          <div className={`ev-block ${hl('editor')}`} data-tt="editor">
            <EvidenceEditor
              fragments={fragsOf(current)}
              removedIds={draftRemove}
              drafts={draftAdd}
              saving={false}
              onToggleRemove={(id) => setDraftRemove((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))}
              onChangeDraft={(key, patch) => setDraftAdd((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)))}
              onRemoveDraft={(key) => setDraftAdd((prev) => prev.filter((d) => d.key !== key))}
              onSave={saveEdit}
              onCancel={cancelEdit}
            />
          </div>
        )}
        {rows.length > 0 && (
          <div className={`ev-block ${hl('stages')}`} data-tt="stages">
            <div className="ev-lbl">Сравнение по стадиям</div>
            <StageComparisonTable rows={rows} />
          </div>
        )}
        <div className={`ev-block ${hl('basis')}`} data-tt="basis">
          <div className="ev-lbl">Основание</div>
          <div className="card-facts">
            <div>
              <span>Обоснование</span>
              <b>правила проверки</b>
            </div>
          </div>
        </div>
        {history.length > 0 && (
          <div className={`ev-block ${hl('history')}`} data-tt="history">
            <details className="card-history" open={step?.id === 'history'}>
              <summary>История решений ({history.length})</summary>
              <ul>
                {history.map((d, i) => (
                  <li key={i}>
                    <b>{actionLabel[d.action]}</b>
                    {d.reasonCode ? `: ${REJECT_REASON[d.reasonCode].label.charAt(0).toLowerCase()}${REJECT_REASON[d.reasonCode].label.slice(1)}` : ''}
                    <span className="meta">{d.at}</span>
                    {d.comment && <div className="note">{d.comment}</div>}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}
        <div className={`ev-block ${hl('versions')}`} data-tt="versions">
          <details className="card-history" open={step?.id === 'versions'}>
            <summary>Версии доказательств ({versionList.length})</summary>
            <ul>
              {[...versionList].reverse().map((v) => (
                <li key={v.version}>
                  <b>v{v.version}</b>, {v.source === 'MODEL' ? 'машинная' : 'правка инспектора'}
                  {v.version === versionList[versionList.length - 1].version ? ', текущая' : ''}
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
        <div className={`ev-block ev-block-sep ${hl('decision')}`} data-tt="decision" style={{ paddingTop: 16 }}>
          <div className="ev-lbl">Решение инспектора</div>
          {verdict !== 'pending' ? (
            <div className="ev-card" style={{ marginBottom: 12 }}>
              <div style={{ fontSize: '11px', fontWeight: 700, color: '#667085', marginBottom: 6 }}>Комментарий</div>
              <div style={{ fontSize: '13px', lineHeight: 1.6, marginBottom: 8 }}>
                {comments[current.id] || (verdict === 'confirmed' ? 'Подтверждено' : verdict === 'clarification' ? 'Требует уточнения' : 'Отклонено')}
              </div>
              {verdict === 'rejected' && reason && (
                <>
                  <div style={{ fontSize: '11px', fontWeight: 700, color: '#667085', marginBottom: 4 }}>Причина:</div>
                  <div style={{ fontSize: '13px' }}>{REJECT_REASON[reason].label}</div>
                </>
              )}
              <button
                className="btn btn-ghost btn-block"
                style={{ marginTop: 10, fontSize: '13px' }}
                onClick={() => {
                  if (!act('reopen')) return;
                  dispatch({ type: 'reopen' });
                  setComments(({ [current.id]: _removed, ...rest }) => rest);
                }}
              >
                ✎ Изменить решение
              </button>
            </div>
          ) : (
            renderDecisionBar()
          )}
        </div>
      </>
    );
  };

  // Правая колонка: гипотеза или кандидат
  const renderEvidenceColumn = () =>
    selectedHyp ? (
      <HypothesisCard
        h={selectedHyp}
        status={statusOfHyp(selectedHyp)}
        hl={hl}
        promoting={promotingId === selectedHyp.id}
        drafts={hypDrafts}
        onStartPromote={startPromote}
        onCancelPromote={cancelPromote}
        onChangeDraft={(key, patch) => setHypDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)))}
        onRemoveDraft={(key) => setHypDrafts((prev) => prev.filter((d) => d.key !== key))}
        onPromote={promote}
        onDecide={(kind) => decideHypothesis(kind)}
        onOpenCandidate={() => {
          if (!act('hyp-open')) return;
          setSelectedHypId(undefined);
          setPendingSelect(`trainer-${selectedHyp.id}`);
        }}
      />
    ) : (
      renderCard()
    );

  const centerContent = (fullscreen: boolean) => {
    if (centerMode === 'compare') {
      return (
        <div className={`compare-workspace ${hl('panels')}`} data-tt="panels" style={fullscreen ? { height: '100%', flex: 1 } : undefined}>
          <CompareSheets
            candidates={candidates}
            hypotheses={hypotheses}
            currentId={current.id}
            selectedHypothesisId={selectedHypId}
            onSelectCandidate={(id) => {
              const index = candidates.findIndex((c) => c.id === id);
              if (index >= 0) selectCandidate(index);
            }}
            onSelectHypothesis={selectHypothesis}
            hl={hl}
            leading={centerSwitch}
            trailing={fullscreen ? null : fullscreenButton}
          />
        </div>
      );
    }
    if (selectedHyp) {
      // Как у кандидата три панели ПД / РД / ИД: у стадии без области пустая панель с пояснением
      return (
        <div
          className={`hyp-docs ${fullscreen ? '' : hl('panels')}`}
          data-tt={fullscreen ? undefined : 'panels'}
          style={{
            gridTemplateColumns: STAGES.map((st) => (selectedHyp.evidence.some((e) => e.stage === st) ? 'minmax(0, 1fr)' : 'minmax(170px, 0.45fr)')).join(' '),
            height: fullscreen ? '100%' : undefined,
            flex: fullscreen ? 1 : undefined,
          }}
        >
          {STAGES.map((st) => {
            const i = selectedHyp.evidence.findIndex((e) => e.stage === st);
            return i < 0 ? renderEmptyPanel(st, true) : renderHypothesisPanel(selectedHyp.evidence[i], i);
          })}
        </div>
      );
    }
    return (
      <div
        className={`compare-panels ${fullscreen ? '' : hl('panels')}`}
        data-tt={fullscreen ? undefined : 'panels'}
        style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', height: fullscreen ? '100%' : undefined, flex: fullscreen ? 1 : undefined }}
      >
        {STAGES.map(renderDocPanel)}
      </div>
    );
  };

  const hotkeysModal = (
    <Modal open={hotkeysOpen} title="Горячие клавиши верификации" okText="Закрыть" cancelButtonProps={{ style: { display: 'none' } }} onOk={() => setHotkeysOpen(false)} onCancel={() => setHotkeysOpen(false)} destroyOnClose>
      <table className="vw-hotkeys">
        <tbody>
          {HOTKEYS.map(([keys, action]) => (
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
    </Modal>
  );

  const splitModal = (
    <SplitFindingModal
      open={splitOpen}
      title={`${current.code}, ${current.name}`}
      baseRuleKey={current.code}
      fragments={fragsOf(current)}
      saving={false}
      onCancel={() => setSplitOpen(false)}
      onSubmit={submitSplit}
    />
  );

  // Полный экран, как в настоящей верификации: панель инструментов, три документа и сворачиваемые панели «Список» и «Проверка»
  if (state.fullscreen) {
    return (
      <div
        className="verification-fullscreen-wrapper"
        style={{ position: 'fixed', inset: 0, zIndex: 1000, background: token.colorBgContainer, display: 'flex', flexDirection: 'column' }}
      >
        <div className="compare-toolbar" style={{ padding: '10px 24px', borderBottom: `1px solid ${token.colorBorder}` }}>
          <div className="fs-toolbar-row">
            <button
              className={`btn btn-ghost fs-toolbar-btn ${hl('show-list')}`}
              data-tt="show-list"
              onClick={() => run(state.listPanelOpen ? 'list-close' : 'list-open', { type: 'toggle-list-panel' })}
            >
              📋 {state.listPanelOpen ? 'Свернуть список' : 'Показать список'}
            </button>
            <button
              className={`btn btn-ghost fs-toolbar-btn ${hl('show-evidence')}`}
              data-tt="show-evidence"
              onClick={() => run(state.evidencePanelOpen ? 'evidence-close' : 'evidence-open', { type: 'toggle-evidence-panel' })}
            >
              ✓ {state.evidencePanelOpen ? 'Свернуть проверку' : 'Показать проверку'}
            </button>
            {centerSwitch}
            {syncToggle}
            {marksToggle}
            <button className={`fullscreen-exit-btn-bottom fs-toolbar-btn ${hl('fs-exit')}`} data-tt="fs-exit" onClick={() => run('fullscreen-close', { type: 'toggle-fullscreen' })}>
              ✕ Свернуть (ESC)
            </button>
          </div>
        </div>
        <div style={{ padding: '12px 24px 0' }}>{coach}</div>
        <div style={{ flex: 1, minHeight: 0, padding: '8px 24px 16px', display: 'flex' }}>
          <div style={{ flex: 1, minWidth: 0, overflow: 'auto', display: 'flex' }}>{centerContent(true)}</div>
        </div>
        {state.listPanelOpen && (
          <FloatingPanel title="Кандидаты" side="left" width={320} height={500} tt="fs-list-panel" className={hl('fs-list-panel')}>
            <div className="vw-findings-list" style={{ flex: 1, overflow: 'auto' }}>
              {candidates.map((c, i) => renderListItem({ c, i }))}
              {hypotheses.map(renderHypothesisItem)}
            </div>
          </FloatingPanel>
        )}
        {state.evidencePanelOpen && (
          <FloatingPanel title="Проверка" side="right" width={360} height={600} tt="fs-evidence-panel" className={hl('fs-evidence-panel')}>
            <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>{renderEvidenceColumn()}</div>
          </FloatingPanel>
        )}
        {hotkeysModal}
        {splitModal}
      </div>
    );
  }

  return (
    <>
      {coach}
      <SceneFrame height={780}>
        <div className="vw-container">
          {header}
          <div className="vw-body">
            {leftColumn}
            <div className="vw-col-center" style={{ overflowX: 'auto' }}>
              {centerMode === 'panels' && (
                <div className={`compare-toolbar ${hl('toolbar')}`} data-tt="toolbar">
                  <div className="compare-actions">
                    {centerSwitch}
                    {fullscreenButton}
                    {syncToggle}
                    {marksToggle}
                  </div>
                </div>
              )}
              {centerContent(false)}
            </div>
            <div className="vw-col-evidence">
              <div className="vw-col-evidence-scroll">{renderEvidenceColumn()}</div>
            </div>
          </div>
        </div>
      </SceneFrame>
      {hotkeysModal}
      {splitModal}
    </>
  );
};
