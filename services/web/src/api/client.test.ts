import { describe, expect, it } from 'vitest';
import { normalizeApiUrl } from './client';

describe('normalizeApiUrl', () => {
  it('убирает косую черту на конце — иначе адрес уходит на несуществующий узел', () => {
    // Образ стенда собирается с VITE_API_URL=/ (api на том же домене за Caddy).
    // Без чистки `${API_URL}/api/v1/...` даёт «//api/v1/...» — для браузера это адрес
    // с узлом «api», и загрузка файлов падает в ERR_NAME_NOT_RESOLVED.
    expect(`${normalizeApiUrl('/')}/api/v1/documents/upload`).toBe('/api/v1/documents/upload');
    expect(`${normalizeApiUrl('https://stand.example.ru/')}/api/v1/documents/upload`).toBe(
      'https://stand.example.ru/api/v1/documents/upload',
    );
  });

  it('адрес без косой черты на конце не трогает', () => {
    expect(normalizeApiUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeApiUrl('')).toBe('');
  });
});
