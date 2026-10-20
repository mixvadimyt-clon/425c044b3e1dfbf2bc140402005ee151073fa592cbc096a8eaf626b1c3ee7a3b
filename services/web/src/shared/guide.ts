/**
 * Шаг обучения «за руку»: подсвечиваем элемент учебного экрана, объясняем и ждём, пока человек сам сделает действие.
 */
export interface GuideStep {
  id: string;
  /** Короткий заголовок шага (до 28 знаков): жирным над текстом. */
  title?: string;
  /** С какой стороны от подсвеченного лучше стоять подписи (если там есть место). */
  side?: 'left' | 'right' | 'top' | 'bottom';
  /** Что подсвечено на экране (`data-tt` элемента). */
  target: string;
  /** Другие элементы экрана, названные в тексте шага: они подсвечены вместе с главным. */
  also?: string[];
  text: string;
  /**
   * Какое действие засчитывает шаг (клик по кнопке или клавиша дают одно и то же действие).
   * Без `expect` это шаг-пояснение: он завершается кнопкой «Далее».
   */
  expect?: string;
}

/** Действие допустимо, если оно именно то, которого ждёт шаг. На шагах-пояснениях действия на экране не работают. */
export const stepAllows = (step: GuideStep | undefined, action: string): boolean => Boolean(step?.expect) && step?.expect === action;

/** Номер шага для подписи «Шаг 2 из 5»; после последнего шага урок считается пройденным. */
export const guideProgress = (steps: GuideStep[], index: number): { done: boolean; current: number; total: number } => ({
  done: index >= steps.length,
  current: Math.min(index + 1, steps.length),
  total: steps.length,
});

/** Класс подсветки для элемента учебного экрана: он у того, на что указывает текущий шаг. */
export const highlight = (step: GuideStep | undefined, target: string): string =>
  step && (step.target === target || step.also?.includes(target)) ? 'training-target' : '';
