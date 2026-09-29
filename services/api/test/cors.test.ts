import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers.js';

// Веб-клиент в разработке живёт на другом порту, поэтому все запросы к api кросс-доменные.
// @fastify/cors 11 по умолчанию разрешает только безопасные методы (GET, HEAD, POST), и браузер
// отменял PATCH /files/{id} из меню файла ещё до отправки.
describe('CORS: предпроверка методов контракта', () => {
  let t: Awaited<ReturnType<typeof makeTestApp>>;

  beforeAll(async () => {
    t = await makeTestApp();
  });
  afterAll(async () => {
    await t.cleanup();
  });

  const preflight = (method: string) =>
    t.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/files/00000000-0000-4000-8000-000000000001',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': method,
        'access-control-request-headers': 'authorization,content-type',
      },
    });

  it.each(['GET', 'POST', 'PATCH', 'PUT', 'DELETE'])('браузеру разрешён %s', async (method) => {
    const res = await preflight(method);
    expect(res.statusCode).toBeLessThan(300);
    expect(res.headers['access-control-allow-methods']).toContain(method);
  });
});
