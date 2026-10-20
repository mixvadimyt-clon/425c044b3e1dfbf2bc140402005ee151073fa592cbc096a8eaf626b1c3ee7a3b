import { describe, expect, it } from 'vitest';
import { hasTraining, trainingLessons } from './training';

describe('обучение: уроки по ролям', () => {
  it('обучение есть у инспектора и супервизора, у администратора и ML-инженера нет', () => {
    expect(hasTraining('INSPECTOR')).toBe(true);
    expect(hasTraining('SUPERVISOR')).toBe(true);
    expect(hasTraining('ADMIN')).toBe(false);
    expect(hasTraining('ML_ENGINEER')).toBe(false);
    expect(trainingLessons('ADMIN')).toEqual([]);
    expect(trainingLessons('ML_ENGINEER')).toEqual([]);
    expect(trainingLessons(undefined)).toEqual([]);
  });

  it('у инспектора урок на каждую вкладку меню: дашборд, загрузка, верификация, протокол, интеграция', () => {
    const titles = trainingLessons('INSPECTOR').map((l) => l.title);
    for (const tab of ['Дашборд', 'Загрузка', 'Верификация', 'Протокол', 'Интеграция']) expect(titles).toContain(tab);
  });

  it('у супервизора всё то же плюс откат финализации и вкладка «Версии и модели»', () => {
    const inspector = trainingLessons('INSPECTOR').map((l) => l.id);
    const supervisor = trainingLessons('SUPERVISOR').map((l) => l.id);
    for (const id of inspector) expect(supervisor).toContain(id);
    expect(supervisor).toEqual(expect.arrayContaining(['unfinalize', 'ml']));
    expect(inspector).not.toContain('unfinalize');
    expect(inspector).not.toContain('ml');
  });

  it('уроки короткие: от 2 до 7 шагов с текстом и подсвечиваемой целью, идентификаторы не повторяются', () => {
    for (const role of ['INSPECTOR', 'SUPERVISOR'] as const) {
      const lessons = trainingLessons(role);
      expect(new Set(lessons.map((l) => l.id)).size).toBe(lessons.length);
      for (const lesson of lessons) {
        expect(lesson.title.length).toBeGreaterThan(0);
        expect(lesson.steps.length).toBeGreaterThanOrEqual(2);
        expect(lesson.steps.length).toBeLessThanOrEqual(18);
        expect(new Set(lesson.steps.map((s) => s.id)).size).toBe(lesson.steps.length);
        for (const step of lesson.steps) {
          expect(step.text.trim().length).toBeGreaterThan(20);
          expect(step.target.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('каждый урок можно пройти до конца: действия заданы там, где нужно что-то нажать, а пояснения идут без действия', () => {
    for (const lesson of trainingLessons('SUPERVISOR')) {
      // Дашборд, откат, «Версии и модели», обзор и рабочее окно целиком из пояснений: окна с причиной не открываются, вкладки переключает сам урок
      if (!['dashboard', 'rollback', 'models', 'overview', 'window'].includes(lesson.scene)) expect(lesson.steps.some((s) => s.expect)).toBe(true);
      for (const step of lesson.steps) {
        if (step.expect !== undefined) expect(step.expect.length).toBeGreaterThan(0);
      }
    }
  });

  it('есть уроки на учебной верификации и на полном экране', () => {
    const scenes = trainingLessons('INSPECTOR').map((l) => l.scene);
    expect(scenes).toContain('verification');
    expect(scenes).toContain('fullscreen');
  });
});

describe('обучение: тексты шагов', () => {
  const steps = (['INSPECTOR', 'SUPERVISOR'] as const).flatMap((role) => trainingLessons(role).flatMap((l) => l.steps.map((s) => ({ lesson: l.id, ...s }))));

  it('у шага есть заголовок до 28 знаков, текст до 210 знаков, без длинных тире', () => {
    for (const s of steps) {
      expect(s.title, `${s.lesson}/${s.id}`).toBeTruthy();
      expect((s.title ?? '').length, `${s.lesson}/${s.id}`).toBeLessThanOrEqual(28);
      expect(s.text.length, `${s.lesson}/${s.id}`).toBeLessThanOrEqual(210);
      expect(s.text, `${s.lesson}/${s.id}`).not.toContain('—');
    }
  });

  it('в уроке нет двух шагов с одним текстом, нет упоминания лимитов размера файлов', () => {
    for (const role of ['INSPECTOR', 'SUPERVISOR'] as const) {
      for (const l of trainingLessons(role)) {
        const texts = l.steps.map((s) => s.text);
        expect(new Set(texts).size, l.id).toBe(texts.length);
        const titles = l.steps.map((s) => s.title);
        expect(new Set(titles).size, `${l.id}: повтор заголовка`).toBe(titles.length);
      }
    }
    expect(steps.some((s) => s.text.includes('Размер ограничен'))).toBe(false);
  });
});
