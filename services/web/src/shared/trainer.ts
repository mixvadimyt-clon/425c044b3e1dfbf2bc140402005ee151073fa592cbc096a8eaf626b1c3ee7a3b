import type { REJECT_REASON } from './statuses';

export type TrainerStage = 'ПД' | 'РД' | 'ИД';
export type TrainerVerdict = 'pending' | 'confirmed' | 'rejected' | 'clarification';
export type TrainerRejectReason = keyof typeof REJECT_REASON;

/** Где на учебной странице документа лежит значение: имя файла, страницы и рамка в процентах страницы. */
export interface TrainerDoc {
  name: string;
  /** Снимок страницы настоящего документа комплекта (public/training-docs). */
  image: string;
  page: number;
  pages: number;
  mark: { x: number; y: number; w: number; h: number };
}

export interface TrainerCandidate {
  id: string;
  code: string;
  name: string;
  /** Раздел документации, к которому относится параметр. */
  section: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  values: Array<{ stage: TrainerStage; value: string }>;
  /** Документы стадий, где система нашла значение; у остальных стадий панель пустая. */
  docs: Partial<Record<TrainerStage, TrainerDoc>>;
  /** Правило срабатывания: почему система предложила этого кандидата. */
  rule: string;
  /** Полное обоснование: прячется под «Подробнее». */
  rationale: string;
  /** Нормативное основание. */
  gost?: string;
  /** Сравнение по стадиям: у каждой стадии своя строка. */
  stageRows: TrainerStageRow[];
}

/** Строка сравнения по стадиям (та же, что в карточке настоящей верификации). */
export interface TrainerStageRow {
  stage: TrainerStage;
  value: string;
  delta?: string;
  triggered: boolean;
  verdict?: string;
}

/** Фрагмент доказательства: что система нашла на странице (для правки доказательств и разделения). */
export interface TrainerFragment {
  id: string;
  stage: TrainerStage;
  page: number;
  value: string;
  role: 'EXPECTED' | 'ACTUAL' | 'CONTEXT';
  /** Нарисован инспектором. */
  manual: boolean;
  /** Страница (снимок) и рамка на ней в процентах страницы. */
  image: string;
  bbox: { x: number; y: number; w: number; h: number };
}

/** Фрагменты кандидата: по одному на стадию, где система нашла значение; проектное значение ожидаемое, остальные фактические. */
export const fragmentsOf = (candidate: TrainerCandidate): TrainerFragment[] =>
  candidate.values.flatMap((v) => {
    const doc = candidate.docs[v.stage];
    return doc ? [{ id: `${candidate.id}-${v.stage}`, stage: v.stage, page: doc.page, value: v.value, role: v.stage === 'ПД' ? ('EXPECTED' as const) : ('ACTUAL' as const), manual: false, image: doc.image, bbox: doc.mark }] : [];
  });

/** Учебный проект «Комплект 1»: настоящий контрольный комплект из шести PDF (ПД: ПЗ и КР, РД: АР и КЖ, ИД: два акта АОСР). */
export const TRAINER_CANDIDATES: TrainerCandidate[] = [
  {
    id: 'trainer-1',
    code: 'M-002',
    name: 'Общая площадь здания',
    section: 'ПЗ',
    priority: 'HIGH',
    values: [
      { stage: 'ПД', value: '12 480,6' },
      { stage: 'РД', value: '11 905,3' },
    ],
    docs: {
      ПД: { name: '2026-СК2-П-ПЗ.pdf, ред. 0', image: 'pd-pz-2', page: 2, pages: 2, mark: { x: 72, y: 17, w: 6.9, h: 1.7 } },
      РД: { name: '2026-СК2-РД-АР.pdf, ред. 0', image: 'rd-ar-1', page: 1, pages: 1, mark: { x: 72, y: 31.8, w: 6.9, h: 1.7 } },
    },
    rule: 'Дельта общей площади между ПД и РД больше порога 1 %. Здесь расхождение −4,6 %.',
    rationale: 'Площадь определена по поэтажным планам раздела «Архитектурные решения»: в пояснительной записке ПД она 12 480,6 м², а в общих данных АР РД 11 905,3 м². Разница 575,3 м² больше допустимого порога 1 %, поэтому расхождение предложено инспектору.',
    gost: 'Приказ Минстроя России № 740/пр',
    stageRows: [
      { stage: 'ПД', value: '12 480,6 м²', triggered: false, verdict: 'Эталон' },
      { stage: 'РД', value: '11 905,3 м²', delta: '−575,3 м² (−4,6 %)', triggered: true, verdict: 'Больше порога 1 %' },
    ],
  },
  {
    id: 'trainer-2',
    code: 'M-055',
    name: 'Класс прочности бетона, фундаментная плита',
    section: 'КР',
    priority: 'HIGH',
    values: [
      { stage: 'ПД', value: 'B30' },
      { stage: 'РД', value: 'B25' },
      { stage: 'ИД', value: 'B25' },
    ],
    docs: {
      ПД: { name: '2026-СК2-П-КР.pdf, ред. 0', image: 'pd-kr-2', page: 2, pages: 2, mark: { x: 45.2, y: 17, w: 3.5, h: 1.7 } },
      РД: { name: '2026-СК2-РД-КЖ.pdf, ред. 0', image: 'rd-kzh-1', page: 1, pages: 1, mark: { x: 45.2, y: 17.5, w: 3.5, h: 1.7 } },
      ИД: { name: 'АОСР №14 от 14.05.2026.pdf', image: 'id-aosr14', page: 1, pages: 1, mark: { x: 80.7, y: 25.8, w: 3.7, h: 1.8 } },
    },
    rule: 'Класс бетона в рабочей документации и в акте (B25) ниже проектного (B30). Какая редакция действует, из документов не видно.',
    rationale: 'Фундаментная плита: проект требует бетон B30, а рабочая документация (КЖ) и акт скрытых работ № 14 указывают B25. Из документов не видно, какая редакция действует, поэтому решение за инспектором.',
    gost: 'ГОСТ 26633-2015',
    stageRows: [
      { stage: 'ПД', value: 'B30', triggered: false, verdict: 'Эталон' },
      { stage: 'РД', value: 'B25', delta: 'ниже проектного', triggered: true, verdict: 'Не совпадает с проектом' },
      { stage: 'ИД', value: 'B25', delta: 'ниже проектного', triggered: true, verdict: 'Не совпадает с проектом' },
    ],
  },
  {
    id: 'trainer-3',
    code: 'M-055',
    name: 'Класс прочности бетона, плиты перекрытия',
    section: 'КР',
    priority: 'MEDIUM',
    values: [
      { stage: 'ПД', value: 'B25' },
      { stage: 'РД', value: 'B30' },
      { stage: 'ИД', value: 'B22,5' },
    ],
    docs: {
      ПД: { name: '2026-СК2-П-КР.pdf, ред. 0', image: 'pd-kr-2', page: 2, pages: 2, mark: { x: 45.2, y: 12.2, w: 3.5, h: 1.7 } },
      РД: { name: '2026-СК2-РД-КЖ.pdf, ред. 0', image: 'rd-kzh-1', page: 1, pages: 1, mark: { x: 45.2, y: 12.8, w: 3.5, h: 1.7 } },
      ИД: { name: 'АОСР №27 от 18.06.2026.pdf', image: 'id-aosr27', page: 1, pages: 1, mark: { x: 78.2, y: 25.8, w: 5.1, h: 1.8 } },
    },
    rule: 'Класс бетона плит перекрытия в проекте (B25), рабочей документации (B30) и акте (B22,5) не совпадает.',
    rationale: 'Плиты перекрытия: в проекте бетон B25, в рабочей документации B30, а в акте скрытых работ № 27 применена смесь B22,5. Значения не совпадают ни в одной паре документов.',
    gost: 'ГОСТ 26633-2015',
    stageRows: [
      { stage: 'ПД', value: 'B25', triggered: false, verdict: 'Эталон' },
      { stage: 'РД', value: 'B30', delta: 'выше проектного', triggered: true, verdict: 'Не совпадает с проектом' },
      { stage: 'ИД', value: 'B22,5', delta: 'ниже проектного', triggered: true, verdict: 'Не совпадает с проектом' },
    ],
  },
];

export interface TrainerState {
  index: number;
  verdicts: Record<string, TrainerVerdict>;
  reasons: Record<string, TrainerRejectReason>;
  rejectMenuOpen: boolean;
  fullscreen: boolean;
  /** В полном экране панели «Список» и «Проверка» при входе свёрнуты, чтобы документы занимали всё место. */
  listPanelOpen: boolean;
  evidencePanelOpen: boolean;
}

export const initialTrainerState = (): TrainerState => ({ index: 0, verdicts: {}, reasons: {}, rejectMenuOpen: false, fullscreen: false, listPanelOpen: false, evidencePanelOpen: false });

export type TrainerAction =
  | { type: 'select'; index: number }
  | { type: 'move'; delta: 1 | -1 }
  | { type: 'next-pending' }
  | { type: 'confirm' }
  | { type: 'clarify' }
  | { type: 'toggle-reject-menu' }
  | { type: 'reject'; reason: TrainerRejectReason }
  | { type: 'toggle-fullscreen' }
  | { type: 'toggle-list-panel' }
  | { type: 'toggle-evidence-panel' }
  | { type: 'reopen' }
  | { type: 'decide-many'; ids: string[]; verdict: 'confirmed' | 'clarification' }
  | { type: 'escape' }
  | { type: 'reset' };

export const verdictOf = (state: TrainerState, candidate: TrainerCandidate): TrainerVerdict => state.verdicts[candidate.id] ?? 'pending';

/** Индекс ближайшего кандидата без решения после `from` (по кругу); `-1`, если решены все. */
export const nextPendingIndex = (state: TrainerState, candidates: TrainerCandidate[], from: number): number => {
  for (let step = 1; step <= candidates.length; step++) {
    const index = (from + step) % candidates.length;
    if (verdictOf(state, candidates[index]) === 'pending') return index;
  }
  return -1;
};

export const trainerCounts = (state: TrainerState, candidates: TrainerCandidate[]) => {
  const count = (verdict: TrainerVerdict) => candidates.filter((c) => verdictOf(state, c) === verdict).length;
  return { total: candidates.length, pending: count('pending'), confirmed: count('confirmed'), rejected: count('rejected'), clarification: count('clarification') };
};

/** Открыто ли в тренажёре что-то, что закрывает Esc: тогда Esc закрывает это, а не предлагает выйти из обучения. */
export const hasOpenAction = (state: TrainerState): boolean => state.rejectMenuOpen || state.fullscreen;

/** Решение принято: показываем следующий кандидат без решения, как в верификации; если решены все, остаёмся на месте. */
const decided = (state: TrainerState, candidates: TrainerCandidate[], verdicts: TrainerState['verdicts']): TrainerState => {
  const next = { ...state, verdicts, rejectMenuOpen: false };
  const index = nextPendingIndex(next, candidates, state.index);
  return index >= 0 ? { ...next, index } : next;
};

export const trainerReducer = (candidates: TrainerCandidate[]) => (state: TrainerState, action: TrainerAction): TrainerState => {
  const current = candidates[state.index];
  switch (action.type) {
    case 'select':
      return action.index >= 0 && action.index < candidates.length ? { ...state, index: action.index, rejectMenuOpen: false } : state;
    case 'move':
      return { ...state, index: (state.index + action.delta + candidates.length) % candidates.length, rejectMenuOpen: false };
    case 'next-pending': {
      const index = nextPendingIndex(state, candidates, state.index);
      return index >= 0 ? { ...state, index, rejectMenuOpen: false } : state;
    }
    case 'confirm':
      return decided(state, candidates, { ...state.verdicts, [current.id]: 'confirmed' });
    case 'clarify':
      return decided(state, candidates, { ...state.verdicts, [current.id]: 'clarification' });
    case 'toggle-reject-menu':
      return { ...state, rejectMenuOpen: !state.rejectMenuOpen };
    case 'reject':
      return { ...decided(state, candidates, { ...state.verdicts, [current.id]: 'rejected' }), reasons: { ...state.reasons, [current.id]: action.reason } };
    case 'reopen': {
      // «Изменить решение»: кандидат снова без решения, кнопки решения возвращаются
      const verdicts = { ...state.verdicts };
      const reasons = { ...state.reasons };
      delete verdicts[current.id];
      delete reasons[current.id];
      return { ...state, verdicts, reasons, rejectMenuOpen: false };
    }
    case 'decide-many': {
      // Массовое решение: кандидаты получают решение, открытый кандидат остаётся на месте
      const verdicts = { ...state.verdicts };
      action.ids.forEach((id) => {
        verdicts[id] = action.verdict;
      });
      return { ...state, verdicts, rejectMenuOpen: false };
    }
    case 'toggle-fullscreen':
      // При входе обе панели свёрнуты; при выходе сбрасывать нечего
      return state.fullscreen
        ? { ...state, fullscreen: false, rejectMenuOpen: false }
        : { ...state, fullscreen: true, listPanelOpen: false, evidencePanelOpen: false, rejectMenuOpen: false };
    case 'toggle-list-panel':
      return { ...state, listPanelOpen: !state.listPanelOpen };
    case 'toggle-evidence-panel':
      return { ...state, evidencePanelOpen: !state.evidencePanelOpen, rejectMenuOpen: false };
    case 'escape':
      if (state.rejectMenuOpen) return { ...state, rejectMenuOpen: false };
      if (state.fullscreen) return { ...state, fullscreen: false };
      return state;
    case 'reset':
      return initialTrainerState();
  }
};

export type TrainerHypothesisStatus = 'PENDING' | 'CLARIFICATION_REQUIRED' | 'DISMISSED' | 'PROMOTED';

/** Гипотеза свободного поиска: подозрение вне матрицы, не нарушение, пока инспектор не сделает её кандидатом. */
export interface TrainerHypothesis {
  id: string;
  /** Способ поиска (подпись как в настоящей верификации). */
  method: string;
  /** Уверенность модели, 0–1. */
  confidence: number;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  description: string;
  /** Документы одной строкой для списка. */
  refs: string;
  /** Где в документах лежит область гипотезы: по странице на каждый документ. */
  evidence: Array<{ stage: TrainerStage; value: string; doc: TrainerDoc }>;
}

/** Две гипотезы по тем же документам комплекта «Комплект 1». */
export const TRAINER_HYPOTHESES: TrainerHypothesis[] = [
  {
    id: 'trainer-h1',
    method: 'Логика',
    confidence: 0.72,
    priority: 'MEDIUM',
    description: 'В пояснительной записке ПД приведено количество квартир (144), а в общих данных РД такого показателя нет: возможно, он пропущен.',
    refs: 'ПД 2026-СК2-П-ПЗ, стр. 2 · РД 2026-СК2-РД-АР, стр. 1',
    evidence: [
      { stage: 'ПД', value: '144', doc: { name: '2026-СК2-П-ПЗ.pdf, ред. 0', image: 'pd-pz-2', page: 2, pages: 2, mark: { x: 73.1, y: 24.3, w: 3.4, h: 1.9 } } },
      { stage: 'РД', value: 'нет', doc: { name: '2026-СК2-РД-АР.pdf, ред. 0', image: 'rd-ar-1', page: 1, pages: 1, mark: { x: 13, y: 27, w: 78, h: 12.5 } } },
    ],
  },
  {
    id: 'trainer-h2',
    method: 'Нормы',
    confidence: 0.64,
    priority: 'MEDIUM',
    description: 'В пояснительной записке ПД (раздел КР) указана арматура класса A500C, а в общих указаниях РД (КЖ) к ней добавлена арматура A240. В проекте и в актах скрытых работ класса A240 нет.',
    refs: 'ПД 2026-СК2-П-КР, стр. 2 · РД 2026-СК2-РД-КЖ, стр. 1',
    evidence: [
      { stage: 'ПД', value: 'A500C', doc: { name: '2026-СК2-П-КР.pdf, ред. 0', image: 'pd-kr-2', page: 2, pages: 2, mark: { x: 43, y: 21.6, w: 38, h: 2 } } },
      { stage: 'РД', value: 'A500C, A240', doc: { name: '2026-СК2-РД-КЖ.pdf, ред. 0', image: 'rd-kzh-1', page: 1, pages: 1, mark: { x: 13, y: 24.4, w: 60, h: 2.2 } } },
    ],
  },
];
