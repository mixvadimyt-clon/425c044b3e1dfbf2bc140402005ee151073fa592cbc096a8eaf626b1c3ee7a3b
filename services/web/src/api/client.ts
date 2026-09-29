import createClient from 'openapi-fetch';
import type { paths } from './schema';

// Пустая строка — api на том же домене (стенд за nginx); значение не задано вовсе — локальный api.
// Косую черту на конце убираем обязательно: образ стенда собирается с VITE_API_URL=/, и тогда
// `${API_URL}/api/v1/...` даёт «//api/v1/...» — браузер читает это как адрес с узлом «api»
// и падает в ERR_NAME_NOT_RESOLVED. Через apiClient не видно: openapi-fetch чистит baseUrl сам,
// а загрузка файлов, просмотр PDF и выгрузка протокола собирают адрес строкой.
export function normalizeApiUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

export const API_URL = normalizeApiUrl(import.meta.env.VITE_API_URL ?? 'http://localhost:3000');

export const apiClient = createClient<paths>({
  baseUrl: API_URL,
});

// Интерцептор для добавления Bearer-токена
apiClient.use({
  onRequest({ request }) {
    const token = localStorage.getItem('auth_token');
    if (token) {
      request.headers.set('Authorization', `Bearer ${token}`);
    }
    return request;
  },
  onResponse({ response }) {
    // 401 → редирект на логин
    if (response.status === 401) {
      const currentPath = window.location.pathname;
      if (currentPath !== '/login') {
        localStorage.removeItem('auth_token');
        localStorage.removeItem('user');
        window.location.href = '/login';
      }
    }
    return response;
  },
});

export type ApiClient = typeof apiClient;
