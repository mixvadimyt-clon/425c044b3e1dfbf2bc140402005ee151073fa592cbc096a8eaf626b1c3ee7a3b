import React from 'react';
import { Card, Typography } from 'antd';
import { SceneFrame } from '../guideUi';
import type { SceneProps } from '../guideUi';

const { Text } = Typography;

/** Что подсвечивать в настоящей шапке и меню страницы для шагов урока. */
const resolveOne = (target: string): HTMLElement | null => {
  switch (target) {
    case 'win-header':
      return document.querySelector<HTMLElement>('.ant-layout-header');
    case 'win-status':
      return document.querySelector<HTMLElement>('.system-status');
    case 'win-theme':
      return document.querySelector<HTMLElement>('.ant-layout-header button[aria-label$="тема"]');
    case 'win-bell':
      return document.querySelector<HTMLElement>('.ant-layout-header .anticon-bell')?.closest<HTMLElement>('button') ?? null;
    case 'win-user':
      return document.querySelector<HTMLElement>('.header-user-btn');
    case 'win-menu':
      return document.querySelector<HTMLElement>('.app-sider');
    default:
      return null;
  }
};

/** Главный элемент шага и всё, что названо в тексте: у меню пользователя это раскрытый список пунктов. */
const resolve = (target: string): HTMLElement[] => {
  const found = [resolveOne(target)];
  if (target === 'win-user') found.push(document.querySelector<HTMLElement>('.ant-dropdown:not(.ant-dropdown-hidden)'));
  return found.filter((el): el is HTMLElement => el !== null);
};

/**
 * Урок про рабочее окно идёт на настоящей странице: подсвечиваются реальные элементы шапки и бокового меню,
 * а здесь только памятка.
 */
export const WindowScene: React.FC<SceneProps> = ({ step, coach }) => {
  // До отрисовки: меню пользователя раскрыто с первого кадра шага, без перестроения на глазах
  React.useLayoutEffect(() => {
    if (!step) return;
    let marked: HTMLElement[] = [];
    const clear = () => {
      marked.forEach((el) => {
        el.classList.remove('training-target-np');
        el.removeAttribute('data-tt');
      });
    };
    const apply = () => {
      const els = resolve(step.target);
      if (els.length === marked.length && els.every((el, i) => el === marked[i] && el.classList.contains('training-target-np'))) return;
      clear();
      marked = els;
      els.forEach((el, i) => {
        el.classList.add('training-target-np');
        if (i === 0) el.setAttribute('data-tt', step.target);
      });
    };
    // Пункты меню пользователя видны, только когда оно открыто: на этом шаге раскрываем его, как при наведении
    const userBtn = step.target === 'win-user' ? resolveOne('win-user') : null;
    userBtn?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      clear();
      // Не сразу: события внутри перерисовки React не обрабатывает, и меню осталось бы открытым
      if (userBtn) window.setTimeout(() => userBtn.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })), 0);
    };
  }, [step]);

  return (
    <>
      {coach}
      <SceneFrame height="auto">
        <div style={{ padding: 24 }}>
          <Card>
            <Text>Этот урок идёт на настоящей странице: смотрите на подсвеченные места в шапке и в меню слева. Они устроены одинаково на всех вкладках.</Text>
          </Card>
        </div>
      </SceneFrame>
    </>
  );
};
