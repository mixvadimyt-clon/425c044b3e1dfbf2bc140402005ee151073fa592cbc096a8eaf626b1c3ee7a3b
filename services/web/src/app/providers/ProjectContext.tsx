import { createContext } from 'react';
import type { Project } from '@/shared/projects';

export interface ProjectContextValue {
  projects: Project[];
  /** `api` — данные из GET /objects; `mock` — явный демонстрационный режим (`VITE_DEMO_MODE=true`). */
  source: 'api' | 'mock';
  /**
   * Состояние связи: `live` — данные с сервера; `demo` — явный демо-режим; `offline` — сервер недоступен и показывать нечего;
   * `stale` — сервер недоступен, показаны последние загруженные данные.
   */
  mode: 'live' | 'demo' | 'offline' | 'stale';
  isLoading: boolean;
  /** Перечитать список объектов (после создания объекта или загрузки файлов). */
  reload: () => Promise<void>;
  /** Выбранный проект; пока инспектор не открыл ни один, `undefined`. */
  selectedProjectId: string | undefined;
  selectProject: (id: string | undefined) => void;
  /** `PATCH /objects/{id}`; на финализированной проверке сервер отвечает 409, ошибка показывается тостом. */
  updateProject: (id: string, patch: Partial<Omit<Project, 'id'>>) => Promise<void>;
  /** Добавляет демо-проект (только в mock-режиме) и возвращает его id. */
  addProject: (project: Omit<Project, 'id'>) => string;
  /** Удаляет проект: на сервере (если он умеет) или из демо-набора. */
  removeProject: (id: string) => Promise<void>;
}

export const ProjectContext = createContext<ProjectContextValue | null>(null);
