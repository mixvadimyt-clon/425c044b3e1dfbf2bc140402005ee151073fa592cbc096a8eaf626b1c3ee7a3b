import { describe, expect, it } from 'vitest';
import { TRAINER_CANDIDATES, hasOpenAction, initialTrainerState, nextPendingIndex, trainerCounts, trainerReducer, verdictOf } from './trainer';
import type { TrainerAction, TrainerState } from './trainer';

const reduce = trainerReducer(TRAINER_CANDIDATES);
const run = (actions: TrainerAction[], from: TrainerState = initialTrainerState()) => actions.reduce(reduce, from);

describe('тренажёр: решения', () => {
  it('подтверждение и уточнение ставят вердикт и переходят к следующему кандидату без решения', () => {
    const state = run([{ type: 'confirm' }]);
    expect(verdictOf(state, TRAINER_CANDIDATES[0])).toBe('confirmed');
    expect(state.index).toBe(1);
    const after = run([{ type: 'clarify' }], state);
    expect(verdictOf(after, TRAINER_CANDIDATES[1])).toBe('clarification');
    expect(after.index).toBe(2);
  });

  it('отклонение требует причину и закрывает список причин', () => {
    const opened = run([{ type: 'toggle-reject-menu' }]);
    expect(opened.rejectMenuOpen).toBe(true);
    const state = run([{ type: 'reject', reason: 'OCR_ERROR' }], opened);
    expect(verdictOf(state, TRAINER_CANDIDATES[0])).toBe('rejected');
    expect(state.reasons[TRAINER_CANDIDATES[0].id]).toBe('OCR_ERROR');
    expect(state.rejectMenuOpen).toBe(false);
  });

  it('когда решены все, остаёмся на последнем кандидате; счётчики сходятся', () => {
    const state = run([{ type: 'confirm' }, { type: 'clarify' }, { type: 'confirm' }]);
    expect(trainerCounts(state, TRAINER_CANDIDATES)).toEqual({ total: 3, pending: 0, confirmed: 2, rejected: 0, clarification: 1 });
    expect(state.index).toBe(2);
    expect(nextPendingIndex(state, TRAINER_CANDIDATES, 2)).toBe(-1);
  });

  it('N переходит к следующему без решения, пропуская решённых', () => {
    const state = run([{ type: 'select', index: 1 }, { type: 'confirm' }, { type: 'select', index: 0 }, { type: 'next-pending' }]);
    expect(state.index).toBe(2);
  });

  it('стрелки ходят по кругу', () => {
    expect(run([{ type: 'move', delta: -1 }]).index).toBe(TRAINER_CANDIDATES.length - 1);
    expect(run([{ type: 'move', delta: 1 }, { type: 'move', delta: 1 }, { type: 'move', delta: 1 }]).index).toBe(0);
  });

  it('«Начать заново» сбрасывает всё', () => {
    expect(run([{ type: 'confirm' }, { type: 'reset' }])).toEqual(initialTrainerState());
  });
});

describe('тренажёр: изменить решение', () => {
  it('«Изменить решение» возвращает кандидата без решения и убирает причину', () => {
    const reduce = trainerReducer(TRAINER_CANDIDATES);
    let state = reduce(initialTrainerState(), { type: 'toggle-reject-menu' });
    state = reduce(state, { type: 'reject', reason: 'WRONG_REVISION' });
    const rejected = TRAINER_CANDIDATES[0];
    expect(state.verdicts[rejected.id]).toBe('rejected');
    state = reduce(state, { type: 'select', index: 0 });
    state = reduce(state, { type: 'reopen' });
    expect(state.verdicts[rejected.id]).toBeUndefined();
    expect(state.reasons[rejected.id]).toBeUndefined();
  });
});

describe('тренажёр: полный экран и Esc', () => {
  it('при входе в полный экран панели «Список» и «Проверка» свёрнуты', () => {
    const state = run([{ type: 'toggle-fullscreen' }]);
    expect(state.fullscreen).toBe(true);
    expect(state.listPanelOpen).toBe(false);
    expect(state.evidencePanelOpen).toBe(false);
    expect(run([{ type: 'toggle-evidence-panel' }], state).evidencePanelOpen).toBe(true);
  });

  it('повторный вход в полный экран снова сворачивает панели', () => {
    const state = run([{ type: 'toggle-fullscreen' }, { type: 'toggle-evidence-panel' }, { type: 'toggle-fullscreen' }, { type: 'toggle-fullscreen' }]);
    expect(state.evidencePanelOpen).toBe(false);
  });

  it('Esc сначала закрывает список причин, потом полный экран; когда закрывать нечего, ничего не меняет', () => {
    const state = run([{ type: 'toggle-fullscreen' }, { type: 'toggle-evidence-panel' }, { type: 'toggle-reject-menu' }]);
    expect(hasOpenAction(state)).toBe(true);
    const first = run([{ type: 'escape' }], state);
    expect(first.rejectMenuOpen).toBe(false);
    expect(first.fullscreen).toBe(true);
    const second = run([{ type: 'escape' }], first);
    expect(second.fullscreen).toBe(false);
    expect(hasOpenAction(second)).toBe(false);
    expect(run([{ type: 'escape' }], second)).toEqual(second);
  });
});
