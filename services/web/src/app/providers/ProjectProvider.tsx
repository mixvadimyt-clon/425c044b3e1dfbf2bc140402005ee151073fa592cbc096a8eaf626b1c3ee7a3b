import React from 'react';
import { App } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteObject, fetchProjects, patchObject } from '@/api/projects';
import { INITIAL_PROJECTS } from '@/shared/projects';
import type { Project } from '@/shared/projects';
import { DEMO_MODE } from '../config';
import { useAuth } from './useAuth';
import { ProjectContext } from './ProjectContext';
import { computeProjectsMode } from './projectsMode';
import { toObjectPatch } from './objectPatch';

export const PROJECTS_QUERY_KEY = ['projects'] as const;

export const ProjectProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, user } = useAuth();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: [...PROJECTS_QUERY_KEY, user?.id],
    queryFn: fetchProjects,
    enabled: isAuthenticated && !DEMO_MODE,
    retry: 0,
  });

  const [mockProjects, setMockProjects] = React.useState<Project[]>(INITIAL_PROJECTS);
  const [selectedProjectId, setSelectedProjectId] = React.useState<string | undefined>(undefined);

  // Демо-набор только по явному включению; ошибка запроса его не подставляет
  const source: 'api' | 'mock' = DEMO_MODE ? 'mock' : 'api';
  const mode = computeProjectsMode({
    demoMode: DEMO_MODE,
    hasData: query.data !== undefined,
    dataUpdatedAt: query.dataUpdatedAt,
    errorUpdatedAt: query.errorUpdatedAt,
  });

  const projects = React.useMemo(() => (source === 'api' ? (query.data ?? []) : mockProjects), [source, query.data, mockProjects]);

  const updateProject = React.useCallback(
    async (id: string, patch: Partial<Omit<Project, 'id'>>) => {
      if (source === 'mock') {
        setMockProjects((prev) => prev.map((project) => (project.id === id ? { ...project, ...patch } : project)));
        return;
      }
      try {
        await patchObject(id, toObjectPatch(patch));
        await queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY });
      } catch (error) {
        message.error(error instanceof Error ? error.message : 'Не удалось сохранить реквизиты');
      }
    },
    [source, queryClient, message]
  );

  const addProject = React.useCallback((project: Omit<Project, 'id'>) => {
    const id = `obj-${Date.now()}`;
    setMockProjects((prev) => [...prev, { ...project, id }]);
    return id;
  }, []);

  const removeProject = React.useCallback(
    async (id: string) => {
      if (source === 'mock') {
        setMockProjects((prev) => prev.filter((project) => project.id !== id));
      } else {
        await deleteObject(id);
        await query.refetch();
      }
      setSelectedProjectId((current) => (current === id ? undefined : current));
    },
    [source, query]
  );

  const reload = React.useCallback(async () => {
    await query.refetch();
  }, [query]);

  const value = React.useMemo(
    () => ({ projects, source, mode, isLoading: !DEMO_MODE && query.isLoading, reload, selectedProjectId, selectProject: setSelectedProjectId, updateProject, addProject, removeProject }),
    [projects, source, mode, query.isLoading, reload, selectedProjectId, updateProject, addProject, removeProject]
  );

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
};
