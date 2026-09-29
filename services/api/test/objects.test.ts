/**
 * Правка реквизитов объекта и его архивирование.
 *
 * Снаружи `DELETE` ведёт себя как удаление — объект пропадает из списка и его карточка отвечает 404;
 * внутри это архив: проверки, протоколы и журнал остаются, потому что финализированный протокол
 * мог уже уехать во внешнюю ИС.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, makeTestApp } from './helpers.js';

type Json = Record<string, any>;

let app: FastifyInstance;
let cleanup: () => Promise<void>;
let inspector: Record<string, string>;
let supervisor: Record<string, string>;
let admin: Record<string, string>;

beforeAll(async () => {
  ({ app, cleanup } = await makeTestApp());
  inspector = await login(app, 'inspector');
  supervisor = await login(app, 'supervisor');
  admin = await login(app, 'admin');
});

afterAll(() => cleanup());

const createObject = async (name: string, headers = inspector): Promise<Json> => {
  const res = await app.inject({ method: 'POST', url: '/api/v1/objects', headers, payload: { name } });
  expect(res.statusCode).toBe(201);
  return res.json();
};

const listNames = async (): Promise<string[]> => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/objects?page_size=100', headers: inspector });
  expect(res.statusCode).toBe(200);
  return (res.json().items as Json[]).map((o) => o.name as string);
};

describe('правка реквизитов объекта', () => {
  it('меняет только переданные поля', async () => {
    const object = await createObject('ЖК на Полярной');
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/objects/${object.id}`,
      headers: inspector,
      payload: { address: 'Полярная ул., 25', permit_number: '77-123-456' },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json();
    expect(updated.name).toBe('ЖК на Полярной');
    expect(updated.address).toBe('Полярная ул., 25');
    expect(updated.permit_number).toBe('77-123-456');
  });

  it('пустое наименование и пустое тело отбиваются', async () => {
    const object = await createObject('Объект без имени');
    const empty = await app.inject({ method: 'PATCH', url: `/api/v1/objects/${object.id}`, headers: inspector, payload: { name: '  ' } });
    expect(empty.statusCode).toBe(400);
    const nothing = await app.inject({ method: 'PATCH', url: `/api/v1/objects/${object.id}`, headers: inspector, payload: {} });
    expect(nothing.statusCode).toBe(400);
  });

  it('несуществующий объект — 404', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/objects/00000000-0000-4000-8000-000000000000',
      headers: inspector,
      payload: { address: 'нет такого' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('правка пишется в журнал действий вместе с ролью', async () => {
    const object = await createObject('Объект для журнала');
    await app.inject({ method: 'PATCH', url: `/api/v1/objects/${object.id}`, headers: supervisor, payload: { customer: 'Мосинжпроект' } });
    const res = await app.inject({ method: 'GET', url: `/api/v1/audit?object_id=${object.id}`, headers: admin });
    expect(res.statusCode).toBe(200);
    const entry = (res.json().items as Json[]).find((e) => e.action === 'patchObject');
    expect(entry).toBeTruthy();
    expect(entry!.user_role).toBe('SUPERVISOR');
    expect(entry!.details.fields).toEqual(['customer']);
  });
});

describe('архивирование объекта', () => {
  it('объект пропадает из списка, а карточка отвечает 404', async () => {
    const object = await createObject('Временный проект');
    expect(await listNames()).toContain('Временный проект');

    const res = await app.inject({ method: 'DELETE', url: `/api/v1/objects/${object.id}`, headers: inspector });
    expect(res.statusCode).toBe(204);

    expect(await listNames()).not.toContain('Временный проект');
    const card = await app.inject({ method: 'GET', url: `/api/v1/objects/${object.id}`, headers: inspector });
    expect(card.statusCode).toBe(404);
  });

  it('данные остаются: запись в журнале по убранному объекту доступна', async () => {
    const object = await createObject('Проект со следом в журнале');
    await app.inject({ method: 'DELETE', url: `/api/v1/objects/${object.id}`, headers: admin });
    const res = await app.inject({ method: 'GET', url: `/api/v1/audit?object_id=${object.id}`, headers: admin });
    expect(res.statusCode).toBe(200);
    const actions = (res.json().items as Json[]).map((e) => e.action);
    expect(actions).toContain('deleteObject');
    expect(actions).toContain('createObject');
  });

  it('инспектор не может убрать чужой объект, супервизор может', async () => {
    const foreign = await createObject('Объект супервизора', supervisor);
    const denied = await app.inject({ method: 'DELETE', url: `/api/v1/objects/${foreign.id}`, headers: inspector });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({ method: 'DELETE', url: `/api/v1/objects/${foreign.id}`, headers: supervisor });
    expect(allowed.statusCode).toBe(204);
  });

  it('ML-инженеру убирать объекты нельзя', async () => {
    const object = await createObject('Объект не для ML');
    const ml = await login(app, 'ml');
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/objects/${object.id}`, headers: ml });
    expect(res.statusCode).toBe(403);
  });

  it('повторное удаление — 404', async () => {
    const object = await createObject('Дважды убранный');
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/objects/${object.id}`, headers: inspector })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/objects/${object.id}`, headers: inspector })).statusCode).toBe(404);
  });
});
