import React from 'react';
import { flushSync } from 'react-dom';
import { Button, Typography } from 'antd';
import { guideProgress, stepAllows } from '@/shared/guide';
import type { Lesson } from '@/shared/training';
import { DashboardScene } from './scenes/DashboardScene';
import { OverviewScene } from './scenes/OverviewScene';
import { WindowScene } from './scenes/WindowScene';
import { IntegrationScene } from './scenes/IntegrationScene';
import { ModelsScene } from './scenes/ModelsScene';
import { ProtocolScene } from './scenes/ProtocolScene';
import { UploadScene } from './scenes/UploadScene';
import { VerificationScene } from './scenes/VerificationScene';
import type { SceneProps } from './guideUi';
import { Spotlight } from './Spotlight';
import { CoachCard } from './CoachCard';
import { revealLit } from './reveal';
import './training.css';

const { Text } = Typography;

interface Props {
  lesson: Lesson;
  paused: boolean;
  registerEscape: SceneProps['registerEscape'];
  /** Страница спрашивает, можно ли выйти из урока (Esc): урок заканчивается досрочно, если ещё идёт. */
  registerExitLesson?: (exit: (() => boolean) | null) => void;
  /** Есть следующий урок: после прохождения предлагаем перейти к нему. */
  onNext?: () => void;
  /** Это последний урок: после прохождения предлагаем закончить обучение. */
  onFinish?: () => void;
}

/**
 * Урок «за руку»: учебный экран вкладки, подсвеченный элемент и объяснение. Шаг засчитывается, когда человек сам
 * сделал ожидаемое действие; чужие действия экран игнорирует и напоминает, что нажимать.
 */
const BADGE_STYLE: React.CSSProperties = { flexShrink: 0, minWidth: 34, height: 34, borderRadius: 17, padding: '0 10px', background: '#12988C', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 16 };

export const GuidedLesson: React.FC<Props> = ({ lesson, paused, registerEscape, registerExitLesson, onNext, onFinish }) => {
  const [run, setRun] = React.useState(0);
  const [skipped, setSkipped] = React.useState(false);
  const [index, setIndex] = React.useState(0);
  const [hint, setHint] = React.useState(false);
  // «Назад»: сцену пересоздаём и быстро проходим шаги до нужного (тем же, что делает Enter), чтобы экран был в состоянии того шага
  const [replayTo, setReplayTo] = React.useState<number | null>(null);
  const replaying = replayTo !== null;
  const instantAlign = React.useRef(false);
  const indexRef = React.useRef(index);
  indexRef.current = index;
  const { done, current, total } = guideProgress(lesson.steps, index);
  const step = done ? undefined : lesson.steps[index];

  // Сцена вызывает act из слушателей клавиш, поэтому читаем актуальный шаг из ref, а не из замыкания
  const stepRef = React.useRef(step);
  stepRef.current = step;
  const doneRef = React.useRef(done);
  doneRef.current = done;
  const replayingRef = React.useRef(false);
  replayingRef.current = replaying;
  // Последнее действие экрана не принято уроком: Esc тогда не «закрывает открытое», а выходит из урока
  const lastRefusedRef = React.useRef(false);
  const act = React.useCallback((action: string): boolean => {
    if (doneRef.current) return true;
    if (stepAllows(stepRef.current, action)) {
      lastRefusedRef.current = false;
      setIndex((i) => i + 1);
      setHint(false);
      return true;
    }
    lastRefusedRef.current = true;
    setHint(true);
    return false;
  }, []);
  const registerSceneEscape = React.useCallback<SceneProps['registerEscape']>(
    (close) => {
      registerEscape(
        close &&
          (() => {
            lastRefusedRef.current = false;
            const handled = close();
            return handled && !lastRefusedRef.current;
          }),
      );
    },
    [registerEscape],
  );

  // Enter проходит урок дальше: на пояснении это «Понятно», на шаге с действием экран сам выполняет его
  const enterRef = React.useRef<(() => void) | null>(null);
  const registerEnter = React.useCallback((run: (() => void) | null) => {
    enterRef.current = run;
  }, []);
  React.useEffect(() => {
    if (paused || replaying) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const target = e.target;
      // В полях ввода у Enter своё назначение (например, отправка комментария)
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('[role="tab"]'))) return;
      // Enter на кнопке подсказки сработает как нажатие этой кнопки: второй раз шаг не засчитываем
      if (target instanceof HTMLElement && target.closest('.training-coach button')) return;
      const current = stepRef.current;
      if (!current) {
        // Урок пройден: Enter открывает следующий, а после последнего спрашивает, закончить ли обучение
        const forward = onNext ?? onFinish;
        if (forward) {
          e.preventDefault();
          forward();
        }
        return;
      }
      e.preventDefault();
      if (!current.expect) {
        setIndex((i) => i + 1);
      } else {
        enterRef.current?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paused, replaying, onNext, onFinish]);

  // Новый шаг: фокус на «Далее» (клавиатуре и экранным дикторам не нужно искать кнопку), если человек не печатает в поле
  React.useEffect(() => {
    if (paused || replaying || !step) return;
    const timer = window.setTimeout(() => {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) return;
      document.querySelector<HTMLElement>('.training-coach-float .ant-btn-primary')?.focus({ preventScroll: true });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [step?.id, paused, replaying]); // eslint-disable-line react-hooks/exhaustive-deps

  // Новый шаг (и конец повтора после «Назад»): убираем напоминание и ставим подсвеченное сразу под подсказкой
  React.useEffect(() => {
    setHint(false);
    if (!step || lesson.scene === 'window' || replaying) return;
    const align = (behavior: ScrollBehavior) => {
      const target = document.querySelector<HTMLElement>(`[data-tt="${step.target}"]`);
      if (document.querySelector('.verification-fullscreen-wrapper')) {
        // Полный экран: страница не прокручивается, но у плавающих панелей своя прокрутка: подсвеченное в ней ставим повыше
        if (target) revealLit(step.target, 'auto');
        return;
      }
      // Подсвеченное ставим в удобную зону окна (выше середины), и внутренней прокруткой учебного экрана, и страницы. Если оно
      // уже удобно стоит, не двигаем: страница не прыгает. Если у экрана есть своя «точка прокрутки» (вкладки над таблицей),
      // она тоже учитывается
      // Для высокого подсвеченного оставляем над ним место под подпись: оценка её высоты по длине текста
      const wideWidth = Math.min(Math.max(520, 380 + step.text.length * 2.7), 1100, window.innerWidth - 48);
      const rows = Math.ceil((step.text.length * 12.8) / Math.max(200, wideWidth - 44));
      // Подпись «снизу» (поле side у шага): оставляем под целью место для неё, сверху запас не нужен
      if (step.side === 'bottom') revealLit(step.target, behavior, 0, 150 + rows * 32 + 40);
      else revealLit(step.target, behavior, 140 + rows * 32 + 40);
    };
    // Второй раз после того, как поменялась высота подсказки и догрузились страницы документов
    const first = window.setTimeout(() => align(instantAlign.current ? 'auto' : 'smooth'), 0);
    const second = window.setTimeout(() => {
      align('auto');
      instantAlign.current = false;
    }, 450);
    return () => {
      window.clearTimeout(first);
      window.clearTimeout(second);
    };
  }, [step?.id, replaying]); // eslint-disable-line react-hooks/exhaustive-deps

  // «Далее» делает то, что показывает шаг (действие экрана, если оно есть), и идёт дальше
  const acknowledge = () => {
    const current = stepRef.current;
    if (!current) return;
    if (current.expect) {
      // Шаг показывает действие экрана: «Далее» делает его так же, как Enter
      enterRef.current?.();
    } else {
      setIndex((i) => i + 1);
      setHint(false);
    }
  };

  // Выход из урока досрочно: сцену собираем заново (закрывается всё открытое в ней), урок считается законченным
  const exitLesson = React.useCallback((): boolean => {
    if (doneRef.current) return false;
    setReplayTo(null);
    setHint(false);
    setSkipped(true);
    setIndex(lesson.steps.length);
    setRun((r) => r + 1);
    return true;
  }, [lesson.steps.length]);
  React.useEffect(() => {
    registerExitLesson?.(exitLesson);
    return () => registerExitLesson?.(null);
  }, [registerExitLesson, exitLesson]);

  const back = () => {
    if (index === 0) return;
    const target = index - 1;
    instantAlign.current = true;
    // Сцену собираем заново и в одном проходе, без таймеров, доводим до нужного шага: браузер ничего не успевает
    // нарисовать, поэтому виден сразу предыдущий шаг
    flushSync(() => {
      setIndex(0);
      setHint(false);
      setRun((r) => r + 1);
    });
    for (let k = 0; k < target; k += 1) {
      const at = indexRef.current;
      const s = lesson.steps[at];
      if (!s) break;
      flushSync(() => {
        if (!s.expect) setIndex((i) => i + 1);
        else enterRef.current?.();
      });
      if (indexRef.current === at) break; // действие не засчиталось: достраиваем по таймеру
    }
    if (indexRef.current < target) setReplayTo(target);
  };

  React.useEffect(() => {
    if (replayTo === null) return;
    let guard = 0;
    const timer = window.setInterval(() => {
      const at = indexRef.current;
      guard += 1;
      if (at >= replayTo || guard > 80) {
        window.clearInterval(timer);
        setReplayTo(null);
        return;
      }
      const s = lesson.steps[at];
      if (!s.expect) setIndex((i) => i + 1);
      else enterRef.current?.();
    }, 60);
    return () => window.clearInterval(timer);
  }, [replayTo, lesson.steps]);

  const coach = (
    <CoachCard target={step?.target} textLength={step?.text.length ?? 0} done={done} hidden={paused || replaying} preferSide={step?.side} pageHints={lesson.scene === 'protocol' || lesson.scene === 'rollback'} label={done ? (skipped ? 'Урок завершён досрочно' : 'Урок пройден') : `Шаг ${current} из ${total}`}>
      {done && (
        <span aria-hidden style={BADGE_STYLE}>
          ✓
        </span>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        {done ? (
          <Text strong style={{ fontSize: 20 }}>{skipped ? 'Урок завершён досрочно.' : 'Урок пройден.'}</Text>
        ) : (
          <>
            {/* Номер шага рядом с заголовком, «Шаг N из M» справа в той же строке, текст ниже на всю ширину */}
            <div className="training-coach-head">
              <span aria-hidden style={BADGE_STYLE}>
                {current}
              </span>
              <Text strong className="training-coach-title">
                {step!.title}
              </Text>
              <Text type="secondary" className="training-coach-count">
                Шаг {current} из {total}
              </Text>
            </div>
            <div className="training-coach-text">
              <Text className="training-coach-body">{step!.text}</Text>
            </div>
            {hint && (
              <Text style={{ display: 'block', marginTop: 6, fontSize: 17, color: '#B54708' }}>
                Сейчас достаточно нажать «Далее»: остальное на учебном экране сейчас не работает.
              </Text>
            )}
          </>
        )}
        <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {index > 0 && (
            <Button danger onClick={back} disabled={replaying}>
              Назад
            </Button>
          )}
          {step && (
            <Button type="primary" onClick={acknowledge}>
              Далее
            </Button>
          )}
          {done && onNext && (
            <Button type="primary" onClick={onNext}>
              Следующий урок
            </Button>
          )}
          {done && !onNext && onFinish && (
            <Button type="primary" onClick={onFinish}>
              Закончить обучение
            </Button>
          )}
          {step && (
            <Button onClick={exitLesson} disabled={replaying}>
              Выйти из урока
            </Button>
          )}
        </div>
      </div>
    </CoachCard>
  );

  const props: SceneProps = { step, act, coach, paused, registerEscape: registerSceneEscape, registerEnter, onNext };
  return (
    <>
      <Spotlight target={step?.target} active={!paused && !replaying} global={lesson.scene === 'window'} />
      {renderScene(lesson.scene, run, props)}
    </>
  );
};

const renderScene = (scene: Lesson['scene'], run: number, props: SceneProps): React.ReactElement => {
  switch (scene) {
    case 'overview':
      return <OverviewScene key={run} {...props} />;
    case 'window':
      return <WindowScene key={run} {...props} />;
    case 'dashboard':
      return <DashboardScene key={run} {...props} />;
    case 'upload':
      return <UploadScene key={run} {...props} />;
    case 'verification':
    case 'fullscreen':
      return <VerificationScene key={run} {...props} />;
    case 'protocol':
    case 'rollback':
      return <ProtocolScene key={run} {...props} variant={scene} />;
    case 'integration':
      return <IntegrationScene key={run} {...props} />;
    case 'models':
      return <ModelsScene key={run} {...props} />;
  }
};
