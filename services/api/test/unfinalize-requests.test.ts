/**
 * Запросы на откат финализации и уведомления администратору (контракт 0.19.0).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, makePdf, makeTestApp, multipart, waitFor } from './helpers.js';

type Json = Record<string, any>;

describe('запросы на откат финализации', () => {
  let t: Awaited<ReturnType<typeof makeTestApp>>;
  let inspector: Record<string, string>;
  let supervisor: Record<string, string>;
  let admin: Record<string, string>;
  let processId: string;

  const call = async (method: 'GET' | 'POST', url: string, headers: Record<string, string>, payload?: unknown) => {
    const res = await t.app.inject({ method, url, headers, payload: payload as Json });
    return { status: res.statusCode, body: res.body ? (res.json() as Json) : ({} as Json) };
  };
  const notes = async (headers: Record<string, string>) => (await call('GET', '/api/v1/notifications', headers)).body as unknown as Json[];

  beforeAll(async () => {
    t = await makeTestApp();
    inspector = await login(t.app, 'inspector');
    supervisor = await login(t.app, 'supervisor');
    admin = await login(t.app, 'admin');
    const object = (await call('POST', '/api/v1/objects', inspector, { name: 'Объект для отката' })).body.id;
    const mp = multipart([
      { name: 'object_id', value: object },
      { name: 'files', filename: '4. П-2025-04-266-КР(27.04.26).pdf', content: await makePdf(3, 'unfin-KR') },
      { name: 'files', filename: 'П-2025-04-266-КЖ01 11.11.2025.pdf', content: await makePdf(2, 'unfin-KJ') },
      { name: 'files', filename: '1. П-2025-04.266-ПЗ.pdf', content: await makePdf(1, 'unfin-PZ') },
    ]);
    const up = await t.app.inject({ method: 'POST', url: '/api/v1/documents/upload', headers: { ...inspector, ...mp.headers }, payload: mp.payload });
    processId = up.json().process_id;
    const st = await waitFor(
      () => call('GET', `/api/v1/processes/${processId}/status`, inspector),
      (r) => !['PENDING', 'PARSING'].includes(r.body.status),
    );
    const findings = (await call('GET', `/api/v1/protocols/${st.body.current_protocol_id}/findings?finding_status=CANDIDATE`, inspector)).body.items as Json[];
    expect(findings.length).toBeGreaterThan(0);
    // отказ по кандидату — запись для дообучения; администратор узнаёт об этом уведомлением
    for (const f of findings) {
      const r = await call('POST', `/api/v1/findings/${f.id}/decision`, inspector, {
        action: 'REJECT',
        reason_code: 'NO_DISCREPANCY',
        comment: 'Расхождения нет: значения совпадают',
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    expect((await call('POST', `/api/v1/processes/${processId}/finalize`, inspector, {})).status).toBe(200);
  });
  afterAll(() => t.cleanup());

  it('отказ инспектора — уведомление администратору о записи для дообучения, инспектору — нет', async () => {
    expect((await notes(admin)).some((n) => n.type === 'RETRAIN_ITEM_PENDING' && n.process_id === processId)).toBe(true);
    expect((await notes(inspector)).some((n) => n.type === 'RETRAIN_ITEM_PENDING')).toBe(false);
  });

  it('инспектор просит откат с причиной; ADMIN и SUPERVISOR получают уведомление; повтор — 409', async () => {
    expect((await call('POST', `/api/v1/processes/${processId}/unfinalize-request`, inspector, { reason: '' })).status).toBe(400);
    const r = await call('POST', `/api/v1/processes/${processId}/unfinalize-request`, inspector, { reason: 'Пришли новые акты ИД' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ process_id: processId, status: 'OPEN', reason: 'Пришли новые акты ИД', object_name: 'Объект для отката' });
    expect(r.body.requested_by_name).toBeTruthy();
    for (const who of [admin, supervisor]) {
      expect((await notes(who)).some((n) => n.type === 'UNFINALIZE_REQUESTED' && n.message.includes('Пришли новые акты ИД'))).toBe(true);
    }
    const again = await call('POST', `/api/v1/processes/${processId}/unfinalize-request`, inspector, { reason: 'Ещё раз' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('REQUEST_EXISTS');
  });

  it('список — только ADMIN и SUPERVISOR; отказ закрывает запрос с причиной', async () => {
    expect((await call('GET', '/api/v1/unfinalize-requests', inspector)).status).toBe(403);
    const open = (await call('GET', '/api/v1/unfinalize-requests?status=OPEN', admin)).body as unknown as Json[];
    expect(open).toHaveLength(1);
    const rejected = await call('POST', `/api/v1/unfinalize-requests/${open[0].id}/reject`, admin, { reason: 'Акты придут дозагрузкой в новую проверку' });
    expect(rejected.body).toMatchObject({ status: 'REJECTED', resolution_comment: 'Акты придут дозагрузкой в новую проверку' });
    expect(rejected.body.resolved_by_name).toBeTruthy();
    expect((await call('POST', `/api/v1/unfinalize-requests/${open[0].id}/reject`, admin, { reason: 'повторно' })).status).toBe(409);
  });

  it('успешная отмена финализации закрывает открытый запрос как DONE', async () => {
    expect((await call('POST', `/api/v1/processes/${processId}/unfinalize-request`, inspector, { reason: 'Всё-таки нужно вернуть' })).status).toBe(201);
    expect((await call('POST', `/api/v1/processes/${processId}/unfinalize`, supervisor, { reason: 'Вернули по запросу инспектора' })).status).toBe(200);
    const all = (await call('GET', '/api/v1/unfinalize-requests', supervisor)).body as unknown as Json[];
    expect(all.map((r) => r.status).sort()).toEqual(['DONE', 'REJECTED']);
    expect(all.find((r) => r.status === 'DONE')).toMatchObject({ resolution_comment: 'Вернули по запросу инспектора' });
    // процесс уже не финализирован — новый запрос не нужен
    expect((await call('POST', `/api/v1/processes/${processId}/unfinalize-request`, inspector, { reason: 'Ещё' })).status).toBe(409);
  });
});
