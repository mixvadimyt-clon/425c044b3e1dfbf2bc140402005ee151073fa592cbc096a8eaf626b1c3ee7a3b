import React from 'react';
import { Alert } from 'antd';
import { InspectorDashboard } from '@/pages/DashboardPage';
import { SceneFrame } from '../guideUi';
import type { SceneProps } from '../guideUi';
import { TrainingProjects } from '../TrainingProjects';

const byText = (root: HTMLElement, text: string): HTMLElement | null =>
  [...root.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.includes(text)) ?? null;

/** Что подсвечивать на настоящем дашборде для шагов урока: первый элемент главный, остальные названы в тексте шага. */
const resolve = (root: HTMLElement | null, target: string): HTMLElement[] => {
  if (!root) return [];
  const found: Array<HTMLElement | null> = [];
  switch (target) {
    case 'cards':
      // все карточки сводки одним блоком
      {
        const card = root.querySelector<HTMLElement>('[aria-label^="На проверке"]');
        found.push(card?.closest<HTMLElement>('.ant-row') ?? card);
      }
      break;
    case 'search':
      // поиск, а также сортировка и фильтр в заголовках столбцов
      found.push(root.querySelector<HTMLElement>('.ant-input-affix-wrapper'), root.querySelector<HTMLElement>('.ant-table-thead'));
      break;
    case 'columns':
      // заголовки столбцов и первая строка (в ней статус проверки и плюс слева, который раскрывает строку)
      found.push(root.querySelector<HTMLElement>('.ant-table-thead'), root.querySelector<HTMLElement>('.ant-table-tbody .ant-table-row'));
      break;
    case 'add':
      found.push(byText(root, 'Добавить проект'));
      break;
    case 'finalized':
      found.push(root.querySelectorAll<HTMLElement>('.ant-table-wrapper')[1]?.closest<HTMLElement>('.ant-card') ?? null);
      break;
    case 'main-btn': {
      // колонка «Действия» целиком: главная кнопка, «Дозагрузка», «Верификация», «Протокол»
      const main = byText(root, 'Продолжить верификацию');
      found.push(main?.closest<HTMLElement>('td') ?? main);
      break;
    }
  }
  return found.filter((el): el is HTMLElement => el !== null);
};

/**
 * Дашборд из настоящей страницы: те же карточки, таблица и кнопки, только проект учебный, а переходы выключены.
 * Пока идёт урок, срабатывает лишь подсвеченное, остальное страница игнорирует.
 */
export const DashboardScene: React.FC<SceneProps> = ({ step, act, coach, onNext, registerEnter }) => {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const stepRef = React.useRef(step);
  stepRef.current = step;
  const [opened, setOpened] = React.useState(false);

  // Enter делает то, что урок просит сейчас
  React.useEffect(() => {
    // На дашборде все шаги пояснения, действий у Enter нет
    registerEnter(() => undefined);
    return () => registerEnter(null);
  });

  // Подсветка у настоящих элементов: класс и метка для прокрутки к ним ставятся здесь, а не в разметке страницы
  // Таблица antd может пересоздать строку и потерять класс, поэтому следим за изменениями и ставим подсветку заново
  React.useEffect(() => {
    const root = rootRef.current;
    if (!step || !root) return;
    let marked: HTMLElement[] = [];
    const clear = () => {
      marked.forEach((el) => {
        el.classList.remove('training-target');
        el.removeAttribute('data-tt');
      });
    };
    const apply = () => {
      const els = resolve(root, step.target);
      if (els.length === marked.length && els.every((el, i) => el === marked[i] && el.classList.contains('training-target'))) return;
      clear();
      marked = els;
      els.forEach((el, i) => {
        el.classList.add('training-target');
        // метка для прокрутки и затемнения только у главного элемента
        if (i === 0) el.setAttribute('data-tt', step.target);
      });
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    return () => {
      observer.disconnect();
      clear();
    };
  }, [step]);

  const actionOf = (node: HTMLElement): string => {
    if (node.closest('[aria-label^="На проверке"]')) return 'cards';
    const main = byText(rootRef.current as HTMLElement, 'Продолжить верификацию');
    if (main?.contains(node)) return 'main-btn';
    return 'other';
  };

  return (
    <>
      {coach}
      <SceneFrame>
        <div
          ref={rootRef}
          style={{ flex: 1, minHeight: 0 }}
          onClickCapture={(e) => {
            if (!stepRef.current) return; // урок пройден: экран свободный, переходы пустые
            const action = actionOf(e.target as HTMLElement);
            e.stopPropagation();
            e.preventDefault();
            if (!act(action)) return;
            if (action === 'cards') document.getElementById('dash-review')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            if (action === 'main-btn') {
              setOpened(true);
              // Настоящая кнопка открыла бы верификацию: ведём туда же, к следующему уроку
              if (onNext) window.setTimeout(onNext, 1200);
            }
          }}
        >
          <TrainingProjects>
            <InspectorDashboard hideWelcome />
          </TrainingProjects>
        </div>
      </SceneFrame>
      {opened && <Alert style={{ marginTop: 12 }} type="info" showIcon message={onNext ? 'Открываем верификацию проекта…' : 'Откроется верификация проекта.'} />}
    </>
  );
};
