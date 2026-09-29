import type { Project } from './projects';

export type NextActionTarget = 'upload' | 'verification' | 'protocol';

export interface NextAction {
  target: NextActionTarget;
  label: string;
  /** Пояснение под названием проекта: почему предлагается именно это. */
  hint: string;
  /** Чем меньше, тем раньше проект в таблице «Проекты на проверке»; `null`: действий нет. */
  priority: number | null;
}

/** Самое полезное следующее действие по проекту: одна главная кнопка вместо трёх равнозначных. */
export const nextAction = (project: Project): NextAction => {
  if (project.finalized || project.processStatus === 'FINALIZED') {
    return { target: 'protocol', label: 'Открыть протокол', hint: 'Проверка завершена', priority: null };
  }
  const status = project.processStatus;
  if (status === 'FAILED') {
    return { target: 'upload', label: 'Разобраться с ошибкой', hint: 'Разбор документов завершился ошибкой', priority: 0 };
  }
  if (status === 'PENDING' || status === 'PARSING') {
    return { target: 'upload', label: 'Смотреть разбор', hint: 'Документы разбираются', priority: 4 };
  }
  if (!status) {
    return { target: 'upload', label: 'Загрузить документы', hint: 'Проверки ещё не было', priority: 2 };
  }
  const pending = project.counts?.candidatesPending ?? 0;
  if (pending > 0) {
    return { target: 'verification', label: `Продолжить верификацию (${pending})`, hint: `Ждут решения: ${pending}`, priority: 1 };
  }
  return { target: 'protocol', label: 'Завершить проверку', hint: 'Все решения приняты, осталось завершить проверку', priority: 3 };
};

export type CheckGroup = 'pending' | 'failed' | 'ready' | 'parsing' | 'none';

/** Подписи для фильтра по колонке «Проверка»: где инспектору нужно что-то сделать. */
export const CHECK_GROUPS: Array<{ value: CheckGroup; text: string }> = [
  { value: 'pending', text: 'Ждут решения' },
  { value: 'ready', text: 'Готово к завершению' },
  { value: 'failed', text: 'Ошибка' },
  { value: 'parsing', text: 'Разбор идёт' },
  { value: 'none', text: 'Проверки не было' },
];

/** К какой группе относится проект в колонке «Проверка». */
export const checkGroupOf = (project: Project): CheckGroup => {
  const status = project.processStatus;
  if (status === 'FAILED') return 'failed';
  if (status === 'PENDING' || status === 'PARSING') return 'parsing';
  if (!status) return 'none';
  return (project.counts?.candidatesPending ?? 0) > 0 ? 'pending' : 'ready';
};
