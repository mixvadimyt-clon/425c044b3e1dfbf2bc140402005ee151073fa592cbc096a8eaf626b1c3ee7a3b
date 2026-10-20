import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './client';
import type { components } from './schema';

export type MatrixParam = components['schemas']['MatrixParam'];
export type MatrixParamInput = components['schemas']['MatrixParamInput'];
export type MatrixVersion = components['schemas']['MatrixVersion'];
export type NormativeDoc = components['schemas']['NormativeDoc'];
export type NormativeDocInput = components['schemas']['NormativeDocInput'];
/** Текст ошибки api (`Error.message`), чтобы администратор видел причину, а не общее «не удалось». */
const apiMessage = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string' ? (error as { message: string }).message : undefined;

export type LogicalRule = components['schemas']['LogicalRule'];
export type LogicalRuleInput = components['schemas']['LogicalRuleInput'];

const PARAMS_KEY = ['admin-params'] as const;
const VERSIONS_KEY = ['admin-matrix-versions'] as const;
const NORMATIVE_DOCS_KEY = ['admin-normative-docs'] as const;
const LOGICAL_RULES_KEY = ['admin-logical-rules'] as const;

export const useMatrixParams = (query: { section?: string; is_active?: boolean; q?: string } = {}) =>
  useQuery({
    queryKey: [...PARAMS_KEY, query],
    queryFn: async () => {
      const { data, error } = await apiClient.GET('/api/v1/admin/params', { params: { query } });
      if (error || !data) throw new Error('Не удалось получить матрицу параметров');
      return data;
    },
  });

export const useMatrixVersions = () =>
  useQuery({
    queryKey: VERSIONS_KEY,
    queryFn: async () => {
      const { data, error } = await apiClient.GET('/api/v1/admin/matrix-versions');
      if (error || !data) throw new Error('Не удалось получить историю версий матрицы');
      return data;
    },
  });

export const useCreateParam = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: MatrixParamInput) => {
      const { data, error } = await apiClient.POST('/api/v1/admin/params', { body });
      if (error || !data) throw new Error((error as { message?: string } | undefined)?.message ?? 'Не удалось добавить параметр');
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PARAMS_KEY });
      queryClient.invalidateQueries({ queryKey: VERSIONS_KEY });
    },
  });
};

export const useUpdateParam = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id: number; body: MatrixParamInput }) => {
      const { data, error } = await apiClient.PUT('/api/v1/admin/params/{param_id}', { params: { path: { param_id: id } }, body });
      if (error || !data) throw new Error((error as { message?: string } | undefined)?.message ?? 'Не удалось изменить параметр');
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PARAMS_KEY });
      queryClient.invalidateQueries({ queryKey: VERSIONS_KEY });
    },
  });
};

export const useDeactivateParam = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const { error } = await apiClient.DELETE('/api/v1/admin/params/{param_id}', { params: { path: { param_id: id } } });
      if (error) throw new Error('Не удалось деактивировать параметр');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PARAMS_KEY }),
  });
};

/** Массовое включение или выключение параметров: по одному запросу на параметр, списки перечитываются один раз в конце. */
export const useSetParamsActive = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ params, active }: { params: MatrixParam[]; active: boolean }) => {
      for (const param of params) {
        if (active) {
          const { error } = await apiClient.PUT('/api/v1/admin/params/{param_id}', { params: { path: { param_id: param.id } }, body: { ...param, is_active: true } });
          if (error) throw new Error('Не удалось включить параметр');
        } else {
          const { error } = await apiClient.DELETE('/api/v1/admin/params/{param_id}', { params: { path: { param_id: param.id } } });
          if (error) throw new Error('Не удалось выключить параметр');
        }
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: PARAMS_KEY });
      void queryClient.invalidateQueries({ queryKey: VERSIONS_KEY });
    },
  });
};

export const useNormativeDocs = () =>
  useQuery({
    queryKey: NORMATIVE_DOCS_KEY,
    queryFn: async () => {
      const { data, error } = await apiClient.GET('/api/v1/admin/normative-docs');
      if (error || !data) throw new Error('Не удалось получить нормативную базу');
      return data;
    },
  });

export const useCreateNormativeDoc = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: NormativeDocInput) => {
      const { data, error } = await apiClient.POST('/api/v1/admin/normative-docs', { body });
      if (error || !data) throw new Error('Не удалось добавить нормативный документ');
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: NORMATIVE_DOCS_KEY }),
  });
};

export const useUpdateNormativeDoc = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: NormativeDocInput }) => {
      const { data, error } = await apiClient.PUT('/api/v1/admin/normative-docs/{normative_doc_id}', { params: { path: { normative_doc_id: id } }, body });
      if (error || !data) throw new Error('Не удалось изменить нормативный документ');
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: NORMATIVE_DOCS_KEY }),
  });
};

export const useDeactivateNormativeDoc = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await apiClient.DELETE('/api/v1/admin/normative-docs/{normative_doc_id}', { params: { path: { normative_doc_id: id } } });
      if (error) throw new Error('Не удалось деактивировать документ');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: NORMATIVE_DOCS_KEY }),
  });
};

export const useLogicalRules = () =>
  useQuery({
    queryKey: LOGICAL_RULES_KEY,
    queryFn: async () => {
      const { data, error } = await apiClient.GET('/api/v1/admin/logical-rules');
      if (error || !data) throw new Error('Не удалось получить логические правила');
      return data;
    },
  });

export const useCreateLogicalRule = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: LogicalRuleInput) => {
      const { data, error } = await apiClient.POST('/api/v1/admin/logical-rules', { body });
      if (error || !data) throw new Error(apiMessage(error) ?? 'Не удалось добавить логическое правило');
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: LOGICAL_RULES_KEY }),
  });
};

export const useUpdateLogicalRule = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: LogicalRuleInput }) => {
      const { data, error } = await apiClient.PUT('/api/v1/admin/logical-rules/{rule_id}', { params: { path: { rule_id: id } }, body });
      if (error || !data) throw new Error(apiMessage(error) ?? 'Не удалось изменить логическое правило');
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: LOGICAL_RULES_KEY }),
  });
};

export const useDeactivateLogicalRule = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await apiClient.DELETE('/api/v1/admin/logical-rules/{rule_id}', { params: { path: { rule_id: id } } });
      if (error) throw new Error('Не удалось деактивировать правило');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: LOGICAL_RULES_KEY }),
  });
};
