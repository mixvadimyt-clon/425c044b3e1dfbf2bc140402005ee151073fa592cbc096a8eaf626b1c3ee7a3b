import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RinMock, createRinMock } from '../../rin-mock/src/server.mjs';
import { login, makePdf, makeTestApp, waitFor } from './helpers.js';

type Json = Record<string, any>;

const TOKEN = 'rin-token';
const SECRET = 'rin-secret';
const KR = '4. П-2025-04-266-КР(27.04.26).pdf';
const KJ = 'П-2025-04-266-КЖ01 11.11.2025.pdf';

describe('обмен с внешней ИС (мок «РиН»)', () => {
  let dir: string;
  let mock: RinMock;
  let t: Awaited<ReturnType<typeof makeTestApp>>;
  let inspector: Record<string, string>;
  let supervisor: Record<string, string>;
  let processId: string;
  let objectId: string;

  const call = async (method: 'GET' | 'POST', url: string, payload?: unknown, headers = inspector) => {
    const res = await t.app.inject({ method, url, headers, payload: payload as Json });
    return { status: res.statusCode, body: res.body ? (res.json() as Json) : ({} as Json) };
  };
  const sync = (id = processId) => call('GET', `/api/v1/inspection/${id}/sync`);
  const waitSync = (until: (b: Json) => boolean) => waitFor(() => sync(), (r) => until(r.body));
  const systemActions = async () =>
    ((await call('GET', `/api/v1/audit?actor_type=SYSTEM&page_size=200`, undefined, supervisor)).body.items as Json[]).map((a) => a.action as string);

  let seq = 0;
  /** Пакет во «внешней ИС»: подпапка с package.meta.json, файлами и реестром. */
  const makePackage = (id: string, objectId: string, files: [string, Buffer][], registry?: string) => {
    const root = path.join(dir, 'packages', id);
    for (const [rel, content] of files) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), content);
    }
    if (registry) writeFileSync(path.join(root, 'registry.csv'), registry);
    seq += 1;
    const meta = { title: `Комплект ${id}`, created_at: `2026-09-19T0${seq}:00:00Z`, object: { object_id: objectId, name: `Объект ${objectId}`, address: 'Москва' } };
    writeFileSync(path.join(root, 'package.meta.json'), JSON.stringify(meta));
  };

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'inspector-rin-'));
    mock = createRinMock({ packagesDir: path.join(dir, 'packages'), token: TOKEN, secret: SECRET });
    const url = await mock.listen();
    t = await makeTestApp({
      rin: {
        url,
        token: TOKEN,
        secret: SECRET,
        systemName: 'ИАИС «РиН»',
        pollIntervalS: 0,
        autoPush: true,
        retryDelaysS: [0.05, 0.05, 0.05],
        // таймаут с запасом: мок в режиме timeout не отвечает вовсе, а обычный ответ под нагрузкой
        // (анализ заглушкой ML идёт тут же) изредка дольше 300 мс — повторный pull падал (флака 22.09)
        timeoutMs: 2000,
        outboxTickMs: 20,
        maxFileBytes: 1024 * 1024 * 1024,
        maxPackageBytes: 4 * 1024 * 1024 * 1024,
      },
    });
    inspector = await login(t.app, 'inspector');
    supervisor = await login(t.app, 'supervisor');
  });
  afterAll(async () => {
    await t.cleanup();
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('автозабор: объект по external_id, новая проверка с реестром, файлы — от имени «РиН»', async () => {
    const registry = ['file_id;file_name;doc_stage;approval_status', `ALT-1;${KR};PD;APPROVED`, `ALT-2;${KJ};RD;FOR_CONSTRUCTION`].join('\n');
    makePackage('PKG-1', 'ALT79B', [[`ПД/${KR}`, await makePdf(3, 'KR')], [`РД/${KJ}`, await makePdf(2, 'KJ')]], registry);

    const pulled = await call('POST', '/api/v1/integration/pull');
    expect(pulled.status, JSON.stringify(pulled.body)).toBe(200);
    const [pkg] = pulled.body.packages as Json[];
    expect(pkg).toMatchObject({ package_id: 'PKG-1', status: 'APPLIED', external_object_id: 'ALT79B', files_count: 2, accepted_count: 2, has_registry: true, error: null });
    expect(pkg.message).toContain('создана новая проверка');
    processId = pkg.process_id;
    objectId = pkg.object_id;

    expect((await call('GET', `/api/v1/objects/${objectId}`)).body).toMatchObject({ name: 'Объект ALT79B', external_id: 'ALT79B' });
    const files = (await call('GET', `/api/v1/processes/${processId}/files`)).body as unknown as Json[];
    expect(files.map((f) => [f.original_name, f.external_file_id, f.uploaded_by_name])).toEqual([
      [KR, 'ALT-1', 'ИАИС «РиН» (автозабор)'],
      [KJ, 'ALT-2', 'ИАИС «РиН» (автозабор)'],
    ]);
    const proc = (await call('GET', `/api/v1/processes/${processId}`)).body;
    expect(proc.completeness).toMatchObject({ registry: 'PRESENT', registry_file_name: 'registry.csv' });

    const notes = (await call('GET', '/api/v1/notifications')).body as unknown as Json[];
    expect(notes[0]).toMatchObject({ type: 'NEW_DOCUMENTS_AVAILABLE', process_id: processId });
    // повторная выдача того же пакета ничего не создаёт
    const again = await call('POST', '/api/v1/integration/pull');
    expect(again.body.packages, JSON.stringify(again.body)).toEqual([]);
    expect(await systemActions()).toContain('system.integration_package_applied');
  });

  it('финализация → результат уходит во внешнюю ИС с подписью; квитанция и предписание', async () => {
    await waitFor(
      () => call('GET', `/api/v1/processes/${processId}/status`),
      (r) => r.body.status === 'READY',
    );
    const protocolId = (await call('GET', `/api/v1/processes/${processId}/status`)).body.current_protocol_id;
    const { body } = await call('GET', `/api/v1/protocols/${protocolId}/findings?finding_status=CANDIDATE`);
    for (const f of body.items as Json[]) {
      expect((await call('POST', `/api/v1/findings/${f.id}/decision`, { action: 'CONFIRM' })).status).toBe(200);
    }
    expect((await sync()).body).toMatchObject({ sync_status: 'NOT_SENT', attempts: 0, external_system: 'ИАИС «РиН»' });
    expect((await call('POST', `/api/v1/processes/${processId}/finalize`, {})).status).toBe(200);

    const done = await waitSync((b) => b.sync_status === 'SYNCED');
    expect(done.body).toMatchObject({ protocol_version: 1, attempts: 1, last_error: null });
    const [received] = mock.state.results;
    expect(done.body.receipt_id).toBe(received.receipt.receipt_id);
    expect(received.key).toBe(`${processId}:v1`);
    expect(received.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(received.receipt.prescription).toMatchObject({ status: 'ISSUED' });
    expect(received.result.confirmed_violations).toHaveLength(1);
    expect(received.result.input_files.map((f: Json) => f.original_name)).toEqual([KR, KJ]);
    expect((await call('GET', `/api/v1/processes/${processId}`)).body.sync_status).toBe('SYNCED');
    expect(await systemActions()).toEqual(expect.arrayContaining(['system.integration_queued', 'system.integration_delivered']));
    // pull-модель: внешняя ИС может забрать тот же результат сама
    expect((await call('GET', `/api/v1/inspection/${processId}`)).body.confirmed_violations).toHaveLength(1);
  });

  it('503 дважды → доставлено с третьей попытки; повтор той же версии не заводит дубль во внешней ИС', async () => {
    const first = mock.state.results[0].receipt.receipt_id;
    mock.state.failNext('error', 2);
    const queued = await call('POST', `/api/v1/inspection/${processId}`);
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({ sync_status: 'PENDING_SYNC', protocol_version: 1 });
    const done = await waitSync((b) => b.sync_status === 'SYNCED' && b.attempts === 3);
    expect(done.body.receipt_id).toBe(first); // ключ идемпотентности тот же — квитанция та же
    expect(mock.state.results).toHaveLength(1);
    expect((await systemActions()).filter((a) => a === 'system.integration_retry')).toHaveLength(2);
  });

  it('таймаут — сбой связи, отправка повторяется', async () => {
    mock.state.failNext('timeout');
    // Ответ на POST проверяем отдельно: если отправка не встала в очередь, ждать её бессмысленно,
    // а `waitSync` покажет строку прошлой отправки и назовёт причиной таймаут ожидания (флака 22.09)
    const queued = await call('POST', `/api/v1/inspection/${processId}`);
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({ sync_status: 'PENDING_SYNC', attempts: 0 });
    const done = await waitSync((b) => b.sync_status === 'SYNCED');
    expect(done.body).toMatchObject({ attempts: 2, last_error: null });
  });

  it('повторы исчерпаны → SYNC_FAILED и уведомление; протокол остаётся финализированным', async () => {
    mock.state.failNext('error', 4);
    await call('POST', `/api/v1/inspection/${processId}`);
    const failed = await waitSync((b) => b.sync_status === 'SYNC_FAILED');
    expect(failed.body).toMatchObject({ attempts: 4, next_attempt_at: null });
    expect(failed.body.last_error).toContain('503');
    const proc = (await call('GET', `/api/v1/processes/${processId}`)).body;
    expect(proc).toMatchObject({ status: 'FINALIZED', sync_status: 'SYNC_FAILED' });
    const notes = (await call('GET', '/api/v1/notifications')).body as unknown as Json[];
    expect(notes.find((n) => n.type === 'SYNC_FAILED')?.message).toContain('Протокол остаётся финализированным');
  });

  it('отказ внешней ИС (4xx) не повторяется', async () => {
    mock.state.failNext('reject');
    await call('POST', `/api/v1/inspection/${processId}`);
    const failed = await waitSync((b) => b.sync_status === 'SYNC_FAILED' && b.attempts === 1);
    expect(failed.body.last_error).toContain('400');
  });

  it('новый пакет по объекту с финализированным протоколом откладывается; «Создать проверку» — новая проверка', async () => {
    makePackage('PKG-2', 'ALT79B', [[`РД/${KJ}`, await makePdf(2, 'KJ-2')]]);
    const [pkg] = (await call('POST', '/api/v1/integration/pull')).body.packages as Json[];
    expect(pkg).toMatchObject({ package_id: 'PKG-2', status: 'DEFERRED', process_id: processId, object_id: objectId, accepted_count: null });
    const notes = (await call('GET', '/api/v1/notifications')).body as unknown as Json[];
    expect(notes[0]).toMatchObject({ type: 'NEW_DOCUMENTS_AVAILABLE', process_id: processId });
    expect(notes[0].message).toContain('проверка не запущена');

    const applied = await call('POST', `/api/v1/integration/packages/${pkg.id}/apply`);
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body).toMatchObject({ status: 'APPLIED', object_id: objectId, accepted_count: 1 });
    expect(applied.body.process_id).not.toBe(processId);
    expect(applied.body.message).toContain('Реестра в пакете нет');
    expect((await call('GET', `/api/v1/processes/${processId}`)).body.status).toBe('FINALIZED');
    expect((await call('POST', `/api/v1/integration/packages/${pkg.id}/apply`)).body.code).toBe('PACKAGE_APPLIED');
    const list = (await call('GET', '/api/v1/integration/packages?status=APPLIED')).body as unknown as Json[];
    expect(list.map((p) => p.package_id)).toEqual(['PKG-2', 'PKG-1']);
  });

  it('файл, повреждённый при передаче, — пакет не принят; повторное применение скачивает заново', async () => {
    makePackage('PKG-3', 'POL16', [[`ПД/${KR}`, await makePdf(1, 'POL')]]);
    mock.state.failNext('corrupt');
    const [pkg] = (await call('POST', '/api/v1/integration/pull')).body.packages as Json[];
    expect(pkg).toMatchObject({ package_id: 'PKG-3', status: 'FAILED', process_id: null });
    expect(pkg.error).toContain('контрольная сумма');
    expect((await call('GET', `/api/v1/processes?object_id=${pkg.object_id}`)).body.total).toBe(0);

    const applied = await call('POST', `/api/v1/integration/packages/${pkg.id}/apply`);
    expect(applied.body).toMatchObject({ status: 'APPLIED', error: null, accepted_count: 1 });
  });

  it('файл больше предела — пакет не принят, причина видна', async () => {
    makePackage('PKG-BIG', 'BIG1', [[`ПД/${KR}`, await makePdf(3, 'BIG')]]);
    const small = await makeTestApp({ rin: { ...t.ctx.config.rin, maxFileBytes: 1024 } });
    try {
      const headers = await login(small.app, 'inspector');
      const res = await small.app.inject({ method: 'POST', url: '/api/v1/integration/pull', headers });
      const pkg = (res.json().packages as Json[]).find((p) => p.package_id === 'PKG-BIG')!;
      expect(pkg).toMatchObject({ status: 'FAILED', process_id: null });
      expect(pkg.error).toMatch(/больше предела 1 КБ \(RIN_MAX_FILE_MB\)/);
    } finally {
      await small.cleanup();
    }
  });

  it('статус обмена: настройки, очередь, время опроса', async () => {
    const { body } = await call('GET', '/api/v1/integration/status');
    expect(body).toMatchObject({ enabled: true, external_system: 'ИАИС «РиН»', auto_push: true, poll_interval_s: 0, last_pull_error: null });
    expect(body.outbox).toMatchObject({ pending: 0, synced: 3, failed: 2 });
    expect(body.last_pull_at).toBeTruthy();
  });

  it('внешняя ИС недоступна → 502, ошибка видна в статусе; без RIN_URL обмен выключен', async () => {
    const down = await makeTestApp({ rin: { ...t.ctx.config.rin, url: 'http://127.0.0.1:9', timeoutMs: 500 } });
    const off = await makeTestApp({ rin: { ...t.ctx.config.rin, url: '' } });
    try {
      const headers = await login(down.app, 'inspector');
      const r = await down.app.inject({ method: 'POST', url: '/api/v1/integration/pull', headers });
      expect(r.statusCode).toBe(502);
      expect(r.json().code).toBe('RIN_UNAVAILABLE');
      const st = await down.app.inject({ url: '/api/v1/integration/status', headers });
      expect(st.json().last_pull_error).toContain('ИАИС «РиН»: нет связи');

      const offHeaders = await login(off.app, 'inspector');
      const pull = await off.app.inject({ method: 'POST', url: '/api/v1/integration/pull', headers: offHeaders });
      expect([pull.statusCode, pull.json().code]).toEqual([409, 'INTEGRATION_DISABLED']);
      expect((await off.app.inject({ url: '/api/v1/integration/status', headers: offHeaders })).json().enabled).toBe(false);
    } finally {
      await down.cleanup();
      await off.cleanup();
    }
  });
});
