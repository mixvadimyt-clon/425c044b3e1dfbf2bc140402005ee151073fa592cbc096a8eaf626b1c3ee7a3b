export interface ProjectDoc {
  stage: 'ПД' | 'РД' | 'ИД';
  loaded: boolean;
  /** Стадия загружена не полностью (`PD_PARTIAL`). */
  partial?: boolean;
}

/** Счётчики последней проверки объекта (`FindingCounts` из api). */
export interface ProjectCounts {
  /** Кандидаты без решения инспектора. */
  candidatesPending: number;
  confirmedViolations: number;
  clarificationRequired: number;
  missingEvidence: number;
  suspicions: number;
  /** «Соответствие»: доля сопоставимых проверок без расхождения; `null` — сопоставимых проверок нет. */
  compliancePercent: number | null;
}

export interface Project {
  id: string;
  name: string;
  address: string;
  developer: string;
  contractor: string;
  permit: string;
  docs: ProjectDoc[];
  updatedAt: string;
  /** Протокол финализирован: проект показывается в таблице «Финализированные проекты». */
  finalized?: boolean;
  /** Последняя проверка объекта в api; у демо-проектов нет. */
  processId?: string | null;
  processStatus?: string | null;
  /** Светофор объекта из api (`ObjectIndicator`). */
  indicator?: 'GREEN' | 'YELLOW' | 'RED';
  /** Счётчики последней проверки; у демо-проектов нет. */
  counts?: ProjectCounts;
}

// Запасной режим: показываем, если api недоступен. Основной источник — GET /objects (src/api/projects.ts).
export const INITIAL_PROJECTS: Project[] = [
  {
    id: 'obj-1',
    name: 'Жилой комплекс "Алтуфьево"',
    address: 'г. Москва, СВАО, р-н Лианозово, Алтуфьевское шоссе, д. 79Б',
    developer: 'ООО «Алтуфьево-Девелопмент»',
    contractor: 'ООО «СтройМонтаж»',
    permit: '77-2025-0412',
    docs: [
      { stage: 'ПД', loaded: true },
      { stage: 'РД', loaded: true },
      { stage: 'ИД', loaded: false },
    ],
    updatedAt: '17.09.26 14:23',
  },
  {
    id: 'obj-2',
    name: 'ЖК «Набережный», Корпус 3',
    address: 'г. Москва, Причальный проезд, вл. 11',
    developer: 'АО «Набережный Девелопмент»',
    contractor: 'ООО «МонолитСтрой»',
    permit: '77-2025-0287',
    docs: [
      { stage: 'ПД', loaded: true },
      { stage: 'РД', loaded: true },
      { stage: 'ИД', loaded: true },
    ],
    updatedAt: '15.09.26 17:05',
    finalized: true,
  },
];

/** «24.09.26 22:53» → метка времени для сортировки; нераспознанная дата считается самой ранней. */
export const updatedAtMs = (text: string): number => {
  const m = /^(\d{2})\.(\d{2})\.(\d{2})(?: (\d{2}):(\d{2}))?/.exec(text ?? '');
  if (!m) return 0;
  return new Date(2000 + Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0)).getTime();
};

/** Проекты для выбора у администратора на странице протокола: откатить финализацию можно только у уже финализированных. */
export const finalizedProjects = (projects: Project[]): Project[] => projects.filter((p) => p.finalized);

/**
 * Проекты для выбора у администратора в протоколе: только финализированные, где инспектор попросил откат.
 * Остальные финализированные проекты сюда не попадают — так список короткий и в нём нельзя откатить не тот проект по ошибке.
 */
export const projectsWithOpenRollbackRequest = (projects: Project[], openRequestProjectIds: ReadonlySet<string>): Project[] =>
  finalizedProjects(projects).filter((p) => openRequestProjectIds.has(p.id));
