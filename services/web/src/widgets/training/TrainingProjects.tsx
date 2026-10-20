import React from 'react';
import { UNSAFE_NavigationContext } from 'react-router-dom';
import { ProjectContext } from '@/app/providers/ProjectContext';
import type { ProjectContextValue } from '@/app/providers/ProjectContext';
import { TRAINING_PROJECT_ROW } from '@/shared/training';

const noop = async () => undefined;

// Навигатор-пустышка: настоящие страницы зовут navigate(...), а в обучении переходить некуда
const fakeNavigator = {
  createHref: () => '#',
  encodeLocation: (to: unknown) => ({ pathname: typeof to === 'string' ? to : '/', search: '', hash: '' }),
  go: () => undefined,
  push: () => undefined,
  replace: () => undefined,
};
const fakeNavigation = { basename: '/', navigator: fakeNavigator, static: false, future: { v7_relativeSplatPath: true } };

/**
 * Настоящие страницы и виджеты читают проекты из контекста. В обучении подменяем его одним учебным проектом,
 * а навигацию делаем пустой: нажатия «Протокол» и «Верификация» никуда не уводят со страницы обучения.
 */
export const TrainingProjects: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const value = React.useMemo<ProjectContextValue>(
    () => ({
      projects: [TRAINING_PROJECT_ROW],
      source: 'mock',
      mode: 'live',
      isLoading: false,
      reload: noop,
      selectedProjectId: TRAINING_PROJECT_ROW.id,
      selectProject: () => undefined,
      updateProject: noop,
      addProject: () => TRAINING_PROJECT_ROW.id,
      removeProject: noop,
    }),
    [],
  );
  return (
    <UNSAFE_NavigationContext.Provider value={fakeNavigation}>
      <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
    </UNSAFE_NavigationContext.Provider>
  );
};
