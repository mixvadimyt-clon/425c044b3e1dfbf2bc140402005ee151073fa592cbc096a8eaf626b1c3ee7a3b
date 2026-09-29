import { REJECT_REASON } from './statuses';

// Запись разбора для дообучения. В режиме api она строится из записей GOLD-набора (`api/retrain.ts`);
// очередь в localStorage ниже — макет для демонстрационного режима без сервера.

export type RetrainStatus = 'pending' | 'sent' | 'skipped';

export interface RetrainItem {
  id: string;
  findingId: string;
  projectId: string;
  projectName: string;
  parameter: string;
  inspector: string;
  timestamp: string;
  /** Причина отклонения; у подтверждённого нарушения её нет. */
  reasonCode?: keyof typeof REJECT_REASON;
  /** Что решил инспектор: подтвердил нарушение или отклонил кандидата. */
  verdict?: 'confirmed' | 'rejected';
  inspectorComment: string;
  status: RetrainStatus;
  modelComment?: string;
  decidedAt?: string;
  /** Версия набора, в которую запись уже выпущена: после этого решение по ней не меняется. */
  datasetVersion?: string;
}

export const RETRAIN_STATUS_LABEL: Record<RetrainStatus, string> = {
  pending: 'Ожидает решения',
  sent: 'Отправлено на дообучение',
  skipped: 'Не отправлено',
};

const STORAGE_KEY = 'inspector.retrainQueue.v1';

const SEED: RetrainItem[] = [
  {
    id: 'rt-1',
    findingId: 'F-ALT79B-002',
    projectId: 'obj-1',
    projectName: 'ЖК "Алтуфьево"',
    parameter: 'M-002: Общая площадь и экспликация помещений',
    inspector: 'Иванов И.И.',
    timestamp: '2026-09-19 14:30',
    reasonCode: 'EXTRACTION_ERROR',
    inspectorComment:
      'Модель неправильно определила площадь помещения: 7.2 м² относится к другой комнате экспликации.',
    status: 'pending',
  },
  {
    id: 'rt-2',
    findingId: 'F-ALT79B-055',
    projectId: 'obj-1',
    projectName: 'ЖК "Алтуфьево"',
    parameter: 'M-055: Класс бетона',
    inspector: 'Петров П.П.',
    timestamp: '2026-09-19 13:20',
    reasonCode: 'APPROVED_CHANGE',
    inspectorComment: 'Замена класса бетона B30 на B25 согласована в письме заказчика, расхождением не является.',
    status: 'pending',
  },
];

export function loadRetrainQueue(): RetrainItem[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as RetrainItem[];
  } catch {
    // localStorage недоступен или повреждён — работаем с исходными данными
  }
  return SEED;
}

function saveRetrainQueue(items: RetrainItem[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // без сохранения очередь просто вернётся к исходному состоянию после перезагрузки
  }
}

export function updateRetrainItem(id: string, patch: Partial<RetrainItem>): RetrainItem[] {
  const next = loadRetrainQueue().map((item) => (item.id === id ? { ...item, ...patch } : item));
  saveRetrainQueue(next);
  return next;
}

/**
 * Проекты для выбора у администратора в разборе дообучения: только те, где есть записи набора (отклонённые
 * инспектором и подтверждённые нарушения — оба вида нужно одобрить или исключить), ждущие решения
 * (сначала с бо́льшим числом ждущих — там работы больше).
 */
export const retrainProjectIds = (items: Pick<RetrainItem, 'projectId' | 'verdict' | 'status'>[]): string[] => {
  const counts = new Map<string, number>();
  for (const item of items) {
    // Уже решённые записи («отправить на дообучение» / «не отправлять») в список выбора не попадают, иначе
    // проект выглядел бы как ждущий работы, хотя работы там больше нет
    if (item.status !== 'pending') continue;
    counts.set(item.projectId, (counts.get(item.projectId) ?? 0) + 1);
  }
  return [...counts.keys()].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
};
