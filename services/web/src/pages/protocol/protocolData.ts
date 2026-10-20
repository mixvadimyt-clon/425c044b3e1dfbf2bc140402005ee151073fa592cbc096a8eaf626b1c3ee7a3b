import type { StageComparisonRow } from '@/shared/stageComparisons';
import type { APPROVAL_STATUS, CHECK_PRIORITY, FINDING_STATUS, REJECT_REASON } from '@/shared/statuses';

// Макет протокола по REQ-CMP-08 и REQ-CMP-09 (docs/domain/protocol.md).
// Данные приходят из GET /protocols/{id}; поля названы так же, как в контракте.

export type FindingStatusKey = keyof typeof FINDING_STATUS;
export type PriorityKey = keyof typeof CHECK_PRIORITY;
export type ApprovalKey = keyof typeof APPROVAL_STATUS;
export type RejectReasonKey = keyof typeof REJECT_REASON;
export type StageLabel = 'ПД' | 'РД' | 'ИД';

export interface EvidenceSource {
  role: 'EXPECTED' | 'ACTUAL';
  stage: StageLabel;
  value: string;
  fileId: string;
  fileName: string;
  sha256: string;
  cipher: string;
  revision: string;
  approval: ApprovalKey;
  sheet: string;
  page: number;
  /** Область на странице в долях [x, y, w, h] */
  bbox?: [number, number, number, number];
}

export interface InspectorDecision {
  action: 'CONFIRM' | 'REJECT' | 'CLARIFY';
  reasonCode?: RejectReasonKey;
  comment: string;
  by: string;
  at: string;
}

export interface ProtocolFinding {
  id: string;
  paramCode: string;
  ruleKey: string;
  paramName: string;
  section?: string;
  status: FindingStatusKey;
  priority?: PriorityKey;
  expected?: string;
  actual?: string;
  delta?: string;
  stageComparisons?: StageComparisonRow[];
  /** Правило срабатывания из матрицы (контракт 0.18.0). */
  triggerLogic?: string;
  rationale: string;
  rationaleSource: 'RULES' | 'AI';
  normative?: string;
  sources: EvidenceSource[];
  decision?: InspectorDecision;
  approvedChangeRef?: string;
  evidenceVersion: string;
  /** Для комплектности: на какой стадии проблема */
  stage?: StageLabel;
  /** Для комплектности: что запросить или сделать */
  request?: string;
}

export interface Suspicion {
  id: string;
  code: string;
  topic: string;
  description: string;
  confidence: number;
  stage: StageLabel;
  fileName: string;
  page: number;
}

export interface RegistryFile {
  fileId: string;
  fileName: string;
  stage: StageLabel;
  cipher: string;
  revision: string;
  approval: ApprovalKey;
  sha256: string;
  pages: string;
  /** Заголовок документа (из реестра комплекта). */
  title?: string;
  /** Кто и когда загрузил: «Загрузил Иванов Иван, 24.09.2026 11:45». */
  uploaded?: string;
}

export const SCENARIO_LABEL: Record<string, string> = {
  FULL: 'Полный комплект (ПД + РД + ИД)',
  PD_RD_ONLY: 'ПД + РД',
  PD_ID_ONLY: 'ПД + ИД',
  RD_ID_ONLY: 'РД + ИД',
  SINGLE_ONLY: 'Одна стадия',
  PARTIALLY_LOADED: 'Частично загружен',
};

const REGISTRY_FULL: RegistryFile[] = [
  {
    fileId: 'file-pd-01',
    fileName: '25-014-ПД.pdf',
    stage: 'ПД',
    cipher: 'П-2025-04-266-КР',
    revision: 'изм. 3',
    approval: 'APPROVED',
    sha256: 'a3f8e9c2b1d47e60c5f18a92d3b4e7f0165c9a8b2d4e6f1037a5c8e9b0d2f491',
    pages: '20 / 20',
  },
  {
    fileId: 'file-rd-01',
    fileName: '25-014-РД.pdf',
    stage: 'РД',
    cipher: 'П-2025-04-266-КЖ01',
    revision: 'РД-2',
    approval: 'FOR_CONSTRUCTION',
    sha256: '7c01d5aa3e8f92b4d6e0f3175a9c28be4d1f6037e5a8c9b2140d3f6e7a9b58c1',
    pages: '15 / 15',
  },
];

const PD_SRC = {
  stage: 'ПД' as const,
  fileId: 'file-pd-01',
  fileName: '25-014-ПД.pdf',
  sha256: REGISTRY_FULL[0].sha256,
  cipher: REGISTRY_FULL[0].cipher,
  revision: REGISTRY_FULL[0].revision,
  approval: REGISTRY_FULL[0].approval,
};

const RD_SRC = {
  stage: 'РД' as const,
  fileId: 'file-rd-01',
  fileName: '25-014-РД.pdf',
  sha256: REGISTRY_FULL[1].sha256,
  cipher: REGISTRY_FULL[1].cipher,
  revision: REGISTRY_FULL[1].revision,
  approval: REGISTRY_FULL[1].approval,
};

const FINDINGS_CURRENT: ProtocolFinding[] = [
  // (1) Комплектность и сопоставимость
  {
    id: 'F-ALT79B-055-ID',
    paramCode: 'M-055',
    ruleKey: 'concrete_class_pd_id',
    paramName: 'Класс бетона',
    status: 'MISSING_EVIDENCE',
    stage: 'ИД',
    rationale: 'Для сверки фактического класса бетона нужен документ исполнительной стадии, ИД не загружена.',
    rationaleSource: 'RULES',
    evidenceVersion: 'v1 (машинная)',
    sources: [],
    request: 'Запросить акт освидетельствования скрытых работ и паспорта бетонной смеси на плиту фундамента.',
  },
  {
    id: 'F-ALT79B-002-RD',
    paramCode: 'M-002',
    ruleKey: 'total_area_pd_rd',
    paramName: 'Общая площадь и экспликация помещений',
    status: 'CLARIFICATION_REQUIRED',
    stage: 'РД',
    rationale: 'В цепочке РД две редакции (РД-1 и РД-2) без указанного предшественника: эталон не определён.',
    rationaleSource: 'RULES',
    evidenceVersion: 'v1 (машинная)',
    sources: [{ ...RD_SRC, role: 'ACTUAL', value: '7.2 м²', sheet: 'Лист 4', page: 4 }],
    request: 'Выбрать авторитетную редакцию РД с указанием основания (меню файла «⋮»).',
    decision: {
      action: 'CLARIFY',
      comment: 'Нужно подтвердить, какая редакция РД действует.',
      by: 'Петров И.С.',
      at: '18.09.2026 14:35',
    },
  },
  {
    id: 'F-ALT79B-002-P12',
    paramCode: 'M-002',
    ruleKey: 'total_area_pd_rd',
    paramName: 'Общая площадь и экспликация помещений',
    status: 'NOT_COMPARABLE',
    stage: 'РД',
    rationale: 'Лист 12 РД - скан без текстового слоя, уверенность распознавания ниже порога: значения не сопоставимы.',
    rationaleSource: 'RULES',
    evidenceVersion: 'v1 (машинная)',
    sources: [{ ...RD_SRC, role: 'ACTUAL', value: 'не распознано', sheet: 'Лист 12', page: 12 }],
    request: 'Запросить у проектировщика файл листа 12 в векторном виде.',
  },

  // (2) Кандидаты
  {
    id: 'F-ALT79B-055',
    paramCode: 'M-055',
    ruleKey: 'concrete_class_pd_rd',
    paramName: 'Класс бетона',
    status: 'CANDIDATE',
    priority: 'MEDIUM',
    expected: 'B30',
    actual: 'B25',
    delta: 'понижение класса',
    rationale: 'Класс бетона фундаментной плиты изменён с B30 (ПД КР) на B25 (РД КЖ01): понижение класса прочности.',
    rationaleSource: 'RULES',
    normative: 'ГОСТ 26633-2015',
    evidenceVersion: 'v1 (машинная)',
    sources: [
      { ...PD_SRC, role: 'EXPECTED', value: 'B30', sheet: 'Лист 7', page: 8, bbox: [0.45, 0.5, 0.2, 0.08] },
      { ...RD_SRC, role: 'ACTUAL', value: 'B25', sheet: 'Лист 3', page: 8, bbox: [0.45, 0.5, 0.2, 0.08] },
    ],
  },

  // (3) Подтверждённые нарушения
  {
    id: 'F-ALT79B-002',
    paramCode: 'M-002',
    ruleKey: 'total_area_pd_rd',
    paramName: 'Общая площадь и экспликация помещений',
    status: 'CONFIRMED_VIOLATION',
    priority: 'HIGH',
    expected: '8.0 м²',
    actual: '7.2 м²',
    delta: '−0.8 м² (−10 %)',
    rationale: 'Площадь помещения по экспликации ПД (лист АР, стр. 19) отличается от РД (стр. 4) более чем на 1 %.',
    rationaleSource: 'RULES',
    evidenceVersion: 'v2 (инспектор)',
    sources: [
      { ...PD_SRC, role: 'EXPECTED', value: '8.0 м²', sheet: 'Лист 19', page: 19, bbox: [0.15, 0.25, 0.3, 0.15] },
      { ...RD_SRC, role: 'ACTUAL', value: '7.2 м²', sheet: 'Лист 4', page: 4, bbox: [0.2, 0.3, 0.28, 0.14] },
    ],
    decision: {
      action: 'CONFIRM',
      comment: 'Расхождение подтверждено по экспликации, согласованного изменения нет.',
      by: 'Петров И.С.',
      at: '18.09.2026 14:25',
    },
  },

  // (4) Проверенные отрицательные
  {
    id: 'F-ALT79B-056',
    paramCode: 'M-055',
    ruleKey: 'concrete_class_pd_rd',
    paramName: 'Класс бетона (блок Б)',
    status: 'NEGATIVE_VERIFIED',
    priority: 'MEDIUM',
    expected: 'B30',
    actual: 'B25',
    delta: 'понижение класса',
    rationale: 'Класс бетона плиты блока Б в РД ниже, чем в ПД.',
    rationaleSource: 'RULES',
    normative: 'ГОСТ 26633-2015',
    evidenceVersion: 'v1 (машинная)',
    approvedChangeRef: 'Письмо заказчика № 14 от 12.09.2026',
    sources: [
      { ...PD_SRC, role: 'EXPECTED', value: 'B30', sheet: 'Лист 9', page: 9, bbox: [0.4, 0.42, 0.2, 0.08] },
      { ...RD_SRC, role: 'ACTUAL', value: 'B25', sheet: 'Лист 5', page: 9, bbox: [0.4, 0.42, 0.2, 0.08] },
    ],
    decision: {
      action: 'REJECT',
      reasonCode: 'APPROVED_CHANGE',
      comment: 'Замена согласована письмом заказчика, расхождением не является.',
      by: 'Петров И.С.',
      at: '18.09.2026 14:30',
    },
  },
];

// (5) Гипотезы свободного поиска
const SUSPICIONS_CURRENT: Suspicion[] = [
  {
    id: 'S-001',
    code: 'FREE-STRUCT-001',
    topic: 'Конструктивные решения',
    description: 'Толщина фундаментной плиты: ПД: 600 мм, РД: 500 мм. Параметра в матрице нет.',
    confidence: 0.62,
    stage: 'РД',
    fileName: '25-014-РД.pdf',
    page: 6,
  },
];

// ---- Версии протокола (REQ-CMP-11): прежние версии остаются в истории и не меняются ----

export interface ProtocolVersion {
  /** Ключ версии: у демо-версий номер, у версий из api — id протокола. */
  value: string;
  /** Номер версии для показа (у демо-версий совпадает с `value`). */
  number?: string;
  label: string;
  createdAt: string;
  current: boolean;
  matrixVersion: string;
  modelVersion: string;
  datasetVersion: string;
  manifestHash: string;
  scenario: keyof typeof SCENARIO_LABEL;
  uploadStatus: { pd: string; rd: string; id: string };
  completeness: string;
  registry: RegistryFile[];
  findings: ProtocolFinding[];
  suspicions: Suspicion[];
}

export const PROCESS_ID = 'proc_2026091814401';
export const INSPECTOR_NAME = 'Петров И.С.';

// Версия 0.9: загружены ПД и РД, решений инспектора ещё нет — все расхождения были кандидатами
const asCandidate = (f: ProtocolFinding): ProtocolFinding => ({
  ...f,
  status: 'CANDIDATE',
  decision: undefined,
  approvedChangeRef: undefined,
  evidenceVersion: 'v1 (машинная)',
});

const FINDINGS_V09: ProtocolFinding[] = FINDINGS_CURRENT.map((f) =>
  f.status === 'CONFIRMED_VIOLATION' || f.status === 'NEGATIVE_VERIFIED' ? asCandidate(f) : f.status === 'CLARIFICATION_REQUIRED' ? { ...f, decision: undefined } : f
).filter((f) => f.id !== 'F-ALT79B-002-RD');

// Версия 0.8: загружена только ПД, сверять не с чем
const missingRd = (id: string, paramCode: string, paramName: string, ruleKey: string): ProtocolFinding => ({
  id,
  paramCode,
  ruleKey,
  paramName,
  status: 'MISSING_EVIDENCE',
  stage: 'РД',
  rationale: 'Для сверки нужен документ рабочей стадии, РД не загружена.',
  rationaleSource: 'RULES',
  evidenceVersion: 'v1 (машинная)',
  sources: [],
  request: 'Загрузить рабочую документацию (КЖ) с реестром файлов.',
});

const FINDINGS_V08: ProtocolFinding[] = [
  missingRd('F-ALT79B-002-RD0', 'M-002', 'Общая площадь и экспликация помещений', 'total_area_pd_rd'),
  missingRd('F-ALT79B-055-RD0', 'M-055', 'Класс бетона', 'concrete_class_pd_rd'),
  FINDINGS_CURRENT.find((f) => f.id === 'F-ALT79B-055-ID') as ProtocolFinding,
];

export const PROTOCOL_VERSIONS: ProtocolVersion[] = [
  {
    value: '1.0',
    label: 'Версия 1.0 (18.09.2026 14:40)',
    createdAt: '18.09.2026 14:40',
    current: true,
    matrixVersion: '1.1',
    modelVersion: 'inspector-ml-v0.5.2',
    datasetVersion: 'dataset-v2.3',
    manifestHash: 'a3f8e9c2b1d47e60c5f18a92d3b4e7f0165c9a8b2d4e6f1037a5c8e9b0d2f491',
    scenario: 'PD_RD_ONLY',
    uploadStatus: { pd: 'PD_UPLOADED', rd: 'RD_UPLOADED', id: 'ID_MISSING' },
    completeness: 'MISSING_EVIDENCE',
    registry: REGISTRY_FULL,
    findings: FINDINGS_CURRENT,
    suspicions: SUSPICIONS_CURRENT,
  },
  {
    value: '0.9',
    label: 'Версия 0.9 (17.09.2026 10:15)',
    createdAt: '17.09.2026 10:15',
    current: false,
    matrixVersion: '1.1',
    modelVersion: 'inspector-ml-v0.5.1',
    datasetVersion: 'dataset-v2.3',
    manifestHash: '5d21b9e07a4c83f6e1029b7c5a3d84f0126e9b5c7a08d4f3e61b29c05a7d8e13',
    scenario: 'PD_RD_ONLY',
    uploadStatus: { pd: 'PD_UPLOADED', rd: 'RD_UPLOADED', id: 'ID_MISSING' },
    completeness: 'MISSING_EVIDENCE',
    registry: REGISTRY_FULL,
    findings: FINDINGS_V09,
    suspicions: SUSPICIONS_CURRENT,
  },
  {
    value: '0.8',
    label: 'Версия 0.8 (16.09.2026 16:30)',
    createdAt: '16.09.2026 16:30',
    current: false,
    matrixVersion: '1.0',
    modelVersion: 'inspector-ml-v0.4.9',
    datasetVersion: 'dataset-v2.2',
    manifestHash: '91c4e7a20b5d3f68e4a1c9d07b2e5f8a3c60d19b4e7f2a58c3d1e60b9a4f7d25',
    scenario: 'SINGLE_ONLY',
    uploadStatus: { pd: 'PD_UPLOADED', rd: 'RD_MISSING', id: 'ID_MISSING' },
    completeness: 'MISSING_EVIDENCE',
    registry: [REGISTRY_FULL[0]],
    findings: FINDINGS_V08,
    suspicions: [],
  },
];
