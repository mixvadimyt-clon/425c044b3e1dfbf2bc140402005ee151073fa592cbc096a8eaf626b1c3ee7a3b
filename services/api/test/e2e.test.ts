import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, makePdf, makeTestApp, multipart, waitFor } from './helpers.js';

type Json = Record<string, any>;

describe('сквозной сценарий инспектора (ML-заглушка)', () => {
  let t: Awaited<ReturnType<typeof makeTestApp>>;
  let inspector: Record<string, string>;
  let supervisor: Record<string, string>;
  let admin: Record<string, string>;
  let objectId: string;
  let processId: string;
  let protocolId: string;
  let candidateId: string;

  const get = async (url: string, headers = inspector) => {
    const res = await t.app.inject({ method: 'GET', url, headers });
    return { status: res.statusCode, body: res.json() as Json };
  };
  const post = async (url: string, payload: unknown, headers = inspector) => {
    const res = await t.app.inject({ method: 'POST', url, headers, payload: payload as Json });
    return { status: res.statusCode, body: res.body ? (res.json() as Json) : ({} as Json) };
  };
  const upload = async (files: { filename: string; content: Buffer; contentType?: string }[], fields: Record<string, string>) => {
    const mp = multipart([
      ...Object.entries(fields).map(([name, value]) => ({ name, value })),
      ...files.map((f) => ({ name: 'files', ...f })),
    ]);
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/documents/upload', headers: { ...inspector, ...mp.headers }, payload: mp.payload });
    return { status: res.statusCode, body: res.json() as Json };
  };
  const waitReady = (id: string) =>
    waitFor(
      () => get(`/api/v1/processes/${id}/status`),
      (r) => !['PENDING', 'PARSING'].includes(r.body.status),
    );

  beforeAll(async () => {
    t = await makeTestApp();
    inspector = await login(t.app, 'inspector');
    supervisor = await login(t.app, 'supervisor');
    admin = await login(t.app, 'admin');
  });
  afterAll(async () => t.cleanup());

  it('health и метрики доступны без авторизации', async () => {
    expect((await t.app.inject({ url: '/health' })).json().status).toBe('ok');
    const metrics = await t.app.inject({ url: '/metrics' });
    expect(metrics.body).toContain('http_request_duration_seconds');
  });

  it('без токена — 401, неверный пароль — 401', async () => {
    expect((await t.app.inject({ url: '/api/v1/objects' })).statusCode).toBe(401);
    const bad = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'inspector', password: 'x' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().code).toBe('INVALID_CREDENTIALS');
  });

  it('матрица стартует с двух активных параметров', async () => {
    const { body } = await get('/api/v1/admin/params?is_active=true');
    expect((body as unknown as Json[]).map((p) => p.code).sort()).toEqual(['M-002', 'M-055']);
    // коды организаторов для выгрузки submission (каталог parameter_catalog_132)
    expect((body as unknown as Json[]).map((p) => p.external_code).sort()).toEqual(['KR-055', 'PZ-002']);
  });

  it('создание объекта и загрузка ПД+РД с автозапуском', async () => {
    const obj = await post('/api/v1/objects', { name: 'ЖК «Алтуфьевское ш., 79Б»', address: 'Москва, Алтуфьевское ш., 79Б' });
    expect(obj.status).toBe(201);
    expect(obj.body.indicator).toBe('GREEN');
    objectId = obj.body.id;

    const up = await upload(
      [
        { filename: '4. П-2025-04-266-КР(27.04.26).pdf', content: await makePdf(3, 'KR') },
        { filename: 'П-2025-04-266-КЖ01 11.11.2025.pdf', content: await makePdf(2, 'KJ') },
        { filename: '1. П-2025-04.266-ПЗ.pdf', content: await makePdf(1, 'PZ') },
      ],
      { object_id: objectId },
    );
    expect(up.status).toBe(202);
    expect(up.body.files.map((f: Json) => f.status)).toEqual(['PARSING', 'PARSING', 'PARSING']);
    expect(up.body.files[0].original_name).toBe('4. П-2025-04-266-КР(27.04.26).pdf');
    // без манифеста система не вправе объявить комплект полным
    expect(up.body.upload_status).toEqual(['PD_PARTIAL', 'RD_PARTIAL', 'ID_MISSING']);
    expect(up.body.process_status).toBe('PARSING');
    processId = up.body.process_id;
  });

  it('протокол формируется: сценарий, 5 таблиц, версии, соответствие', async () => {
    const status = await waitReady(processId);
    expect(status.body.status).toBe('READY');
    expect(status.body.current_protocol_version).toBe(1);
    protocolId = status.body.current_protocol_id;

    const proc = await get(`/api/v1/processes/${processId}`);
    expect(proc.body.scenario).toBe('PD_RD_ONLY');
    // реестра нет → комплект принят со статусом CLARIFICATION_REQUIRED («Перечень ИД» ред. 1.1)
    expect(proc.body.completeness).toMatchObject({ status: 'CLARIFICATION_REQUIRED', registry: 'ABSENT', basis: 'NONE', missing: [] });
    expect(proc.body.completeness.issues.map((i: Json) => i.code)).toEqual(['NO_REGISTRY']);
    expect(proc.body.can_finalize).toBe(false);
    // M-055 — кандидат; M-002 — нет РД АР, доказательств не хватает
    expect(proc.body.counts).toMatchObject({ candidates_pending: 1, negative_verified: 0, missing_evidence: 1, suspicions: 1, compliance_percent: 0 });

    const { body: p } = await get(`/api/v1/protocols/${protocolId}`);
    expect(p.version).toBe(1);
    expect(p.versions.matrix_version).toBe('m-0.1');
    expect(p.versions.model_version).toBe('stub-0.1');
    expect(p.versions.input_manifest_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.input_files).toHaveLength(3);
    expect(p.tables.completeness).toHaveLength(2);
    expect(p.tables.candidates).toHaveLength(1);
    expect(p.tables.negative_verified).toHaveLength(0);
    expect(p.tables.completeness.find((c: Json) => c.param_code === 'M-002').completeness_status).toBe('MISSING_EVIDENCE');
    expect(p.tables.confirmed_violations).toHaveLength(0);
    expect(p.tables.suspicions[0].discovery_method).toBe('VISUAL_DIFF');
  });

  it('очередь кандидатов, карточка доказательства и фильтр по странице', async () => {
    const { body } = await get(`/api/v1/protocols/${protocolId}/findings?finding_status=CANDIDATE`);
    expect(body.total).toBe(1);
    const f = body.items[0];
    candidateId = f.id;
    expect(f).toMatchObject({ param_code: 'M-055', expected_value: 'B30', actual_value: 'B25', inspector_status: 'PENDING', section: 'КР' });
    // для карточки: правило срабатывания из матрицы отдельно от самодостаточного rationale
    expect(f.trigger_logic).toMatch(/^Понижение класса бетона/);
    // Сравнение по каждой стадии доходит от ML до карточки
    expect(f.stage_comparisons).toEqual([{ stage: 'RD', value: 'B25', raw_value: 'B25', delta: '−1 класс', triggered: true, verdict: 'Понижение: B30 → B25' }]);
    expect(f.evidence_group.fragments.map((x: Json) => x.role)).toEqual(['EXPECTED', 'ACTUAL']);
    expect(f.evidence_group.fragments[0].bbox).toHaveLength(4);

    const fileId = f.evidence_group.fragments[1].file_id;
    const onPage = await get(`/api/v1/protocols/${protocolId}/findings?file_id=${fileId}&evidence_page=1`);
    expect(onPage.body.total).toBe(1);
    const otherPage = await get(`/api/v1/protocols/${protocolId}/findings?file_id=${fileId}&evidence_page=2`);
    expect(otherPage.body.total).toBe(0);

    const content = await t.app.inject({ url: `/api/v1/files/${fileId}/content`, headers: inspector });
    expect(content.statusCode).toBe(200);
    expect(content.headers['content-type']).toBe('application/pdf');
    expect(content.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('пары страниц для экрана сравнения связаны с findings и гипотезами', async () => {
    const { body } = await get(`/api/v1/protocols/${protocolId}/page-pairs`);
    const pairs = body as unknown as Json[];
    expect(pairs).toHaveLength(1);
    expect(pairs[0].left.stage).toBe('PD');
    expect(pairs[0].right.stage).toBe('RD');
    expect(pairs[0].finding_ids).toEqual([candidateId]);
    expect(pairs[0].diff_regions[0].finding_id).toBe(candidateId);
    expect(pairs[0].diff_regions[1].suspicion_id).toBeTruthy();
  });

  it('финализация запрещена, пока есть необработанные кандидаты', async () => {
    const r = await post(`/api/v1/processes/${processId}/finalize`, {});
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PENDING_CANDIDATES');
  });

  it('отклонение требует причину и комментарий; админ не верифицирует', async () => {
    const r = await post(`/api/v1/findings/${candidateId}/decision`, { action: 'REJECT' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('REASON_REQUIRED');
    const bad = await post(`/api/v1/findings/${candidateId}/decision`, { action: 'MAYBE' });
    expect(bad.status).toBe(400);
    const byAdmin = await post(`/api/v1/findings/${candidateId}/decision`, { action: 'CONFIRM' }, admin);
    expect(byAdmin.status).toBe(403);
  });

  it('подтверждение нарушения → COMPLETED, красный светофор, GOLD-черновик', async () => {
    const r = await post(`/api/v1/findings/${candidateId}/decision`, { action: 'CONFIRM', comment: 'Класс бетона понижен без согласования' });
    expect(r.status).toBe(200);
    expect(r.body.finding_status).toBe('CONFIRMED_VIOLATION');
    expect(r.body.decision.user_name).toContain('Иванов');
    expect((await get(`/api/v1/processes/${processId}`)).body).toMatchObject({ status: 'COMPLETED', can_finalize: true });
    expect((await get(`/api/v1/objects/${objectId}`)).body.indicator).toBe('RED');
    const gold = await get('/api/v1/ml/dataset-items', admin);
    expect(gold.body.items[0]).toMatchObject({ gold_label: 'POSITIVE', curation_status: 'DRAFT' });
  });

  it('финализация, запрет изменений, отмена только супервизором', async () => {
    const fin = await post(`/api/v1/processes/${processId}/finalize`, {});
    expect(fin.status).toBe(200);
    expect(fin.body.status).toBe('FINALIZED');

    const again = await post(`/api/v1/findings/${candidateId}/decision`, { action: 'CLARIFY' });
    expect(again.status).toBe(409);
    const up = await upload([{ filename: 'x.pdf', content: await makePdf(1) }], { process_id: processId });
    expect(up.status).toBe(409);

    const result = await get(`/api/v1/inspection/${processId}`);
    expect(result.status).toBe(200);
    expect(result.body.confirmed_violations).toHaveLength(1);
    expect(result.body.input_files).toHaveLength(3);

    expect((await post(`/api/v1/processes/${processId}/unfinalize`, { reason: 'ошибка' })).status).toBe(403);
    const un = await post(`/api/v1/processes/${processId}/unfinalize`, { reason: 'Нужна дозагрузка документов' }, supervisor);
    expect(un.status).toBe(200);
    expect(un.body.status).toBe('COMPLETED');
  });

  it('дозагрузка: новая версия протокола, решение инспектора сохраняется, дубликат сохраняется отдельной записью', async () => {
    const up = await upload(
      [
        { filename: '2. П-2025-04-266-СПОЗУ (Изм.1).pdf', content: await makePdf(2, 'SPOZU') },
        { filename: 'П-2025-04-266-КЖ01 11.11.2025.pdf', content: await makePdf(2, 'KJ') },
      ],
      { process_id: processId },
    );
    expect(up.status).toBe(202);
    // повторная загрузка создаёт новую запись, но в сравнение идёт только первый экземпляр
    expect(up.body.files[1]).toMatchObject({ status: 'PARSING', error: null });
    expect(up.body.files[1].duplicate_of).toBeTruthy();
    expect(up.body.files[1].warnings.map((w: Json) => w.code)).toEqual(['DUPLICATE_CONTENT']);
    const status = await waitReady(processId);
    expect(status.body.current_protocol_version).toBe(2);
    expect(status.body.status).toBe('COMPLETED');

    const versions = await get(`/api/v1/processes/${processId}/protocols`);
    expect((versions.body as unknown as Json[]).map((v) => [v.version, v.is_current, v.trigger])).toEqual([
      [2, true, 'INCREMENTAL_UPLOAD'],
      [1, false, 'INITIAL'],
    ]);
    const { body } = await get(`/api/v1/protocols/${status.body.current_protocol_id}/findings?finding_status=CANDIDATE`);
    expect(body.items[0]).toMatchObject({ finding_status: 'CONFIRMED_VIOLATION', evidence_changed: false });
    expect(body.items[0].decision_history).toHaveLength(1);

    const files = (await get(`/api/v1/processes/${processId}/files`)).body as unknown as Json[];
    // сведения о документе от ML: из результата разбора через files.metadata в список файлов
    expect(files[0]).toMatchObject({ language: 'ru', scan_share: 0, encrypted: false, project_code: null, pdf_producer: null });
    const dup = files.find((f) => f.duplicate_of)!;
    expect(dup).toMatchObject({ excluded_from_comparison: true, processing_status: 'PARSED' });
    expect(dup.exclusion_reason).toContain('Повторная загрузка');
    const { body: p2 } = await get(`/api/v1/protocols/${status.body.current_protocol_id}`);
    expect(p2.input_files.map((f: Json) => f.id)).not.toContain(dup.id);
    expect(p2.input_files).toHaveLength(4); // КР, КЖ01, ПЗ + СПОЗУ
  });

  it('журнал аудита фиксирует действия инспектора', async () => {
    const { body } = await get('/api/v1/audit?page_size=100', admin);
    const actions = body.items.map((a: Json) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['login', 'createObject', 'uploadDocuments', 'decideFinding', 'finalizeProcess', 'unfinalizeProcess']));
    const decision = body.items.find((a: Json) => a.action === 'decideFinding' && a.details.status_code === 200);
    expect(decision.details).toMatchObject({ action: 'CONFIRM', param_code: 'M-055' });
    expect(decision.ip_address).toBeTruthy();
    expect((await get('/api/v1/audit', inspector)).status).toBe(403);
  });

  it('уведомления о готовности протокола', async () => {
    const { body } = await get('/api/v1/notifications');
    expect((body as unknown as Json[]).some((n) => n.type === 'PROTOCOL_READY')).toBe(true);
  });

  it('администратор меняет порог — новая версия матрицы', async () => {
    const params = (await get('/api/v1/admin/params', admin)).body as unknown as Json[];
    expect(params).toHaveLength(132);
    const ar41 = params.find((p) => p.code === 'M-041')!;
    expect(ar41.is_active).toBe(false);
    const { id, created_at, updated_at, ...input } = ar41;
    const upd = await t.app.inject({ method: 'PUT', url: `/api/v1/admin/params/${id}`, headers: admin, payload: { ...input, is_active: true, min_value: 1.2 } });
    expect(upd.statusCode, upd.body).toBe(200);
    expect(upd.json()).toMatchObject({ is_active: true, min_value: 1.2 });
    const versions = (await get('/api/v1/admin/matrix-versions', admin)).body as unknown as Json[];
    expect(versions[0].params_count).toBe(3); // активные: M-002, M-055 и включённый M-041
    const forbidden = await t.app.inject({ method: 'PUT', url: `/api/v1/admin/params/${id}`, headers: inspector, payload: input });
    expect(forbidden.statusCode).toBe(403);
  });

  it('недельный отчёт ML — для ML-инженера, админа и супервизора, не для инспектора', async () => {
    const r = await get('/api/v1/ml/reports/weekly', admin);
    expect(r.status).toBe(200);
    expect(r.body.week).toMatch(/^\d{4}-W\d{2}$/);
    expect((await get('/api/v1/ml/reports/weekly')).status).toBe(403);
  });

  it('callback от ML: только с localhost и по контракту', async () => {
    const payload = { message_id: crypto.randomUUID(), type: 'ml.parse.result', payload: { status: 'OK' } };
    const r = await t.app.inject({ method: 'POST', url: '/internal/ml/results', payload });
    expect(r.statusCode).toBe(400);
    const remote = await t.app.inject({ method: 'POST', url: '/internal/ml/results', payload, remoteAddress: '10.0.0.5' });
    expect(remote.statusCode).toBe(403);
  });

  it('callback от ML: результат больше 1 МиБ принимается (не 413)', async () => {
    // Большой комплект: CompareResult с сотнями проверок и пар листов не влезал в предел Fastify по умолчанию
    const payload = { message_id: crypto.randomUUID(), type: 'ml.parse.result', payload: { status: 'OK', filler: 'x'.repeat(2 * 1024 * 1024) } };
    const r = await t.app.inject({ method: 'POST', url: '/internal/ml/results', payload });
    expect(r.statusCode).toBe(400); // дошло до проверки по контракту, а не отрезано по размеру
  });
});

describe('негативные сценарии загрузки', () => {
  let t: Awaited<ReturnType<typeof makeTestApp>>;
  let headers: Record<string, string>;
  let objectId: string;

  beforeAll(async () => {
    t = await makeTestApp({ uploadMaxFileBytes: 4000, uploadMaxBatchBytes: 9000 });
    headers = await login(t.app, 'inspector');
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/objects', headers, payload: { name: 'Тест' } });
    objectId = res.json().id;
  });
  afterAll(async () => t.cleanup());

  const send = async (files: { filename: string; content: Buffer }[], fields: Record<string, string> = {}) => {
    const mp = multipart([{ name: 'object_id', value: objectId }, ...Object.entries(fields).map(([name, value]) => ({ name, value })), ...files.map((f) => ({ name: 'files', ...f }))]);
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/documents/upload', headers: { ...headers, ...mp.headers }, payload: mp.payload });
    return { status: res.statusCode, body: res.json() };
  };

  it('неподдерживаемый формат, битый PDF и слишком большой файл отклоняются с кодами', async () => {
    const pdf = await makePdf(1);
    const r = await send([
      { filename: 'notes.txt', content: Buffer.from('hello') },
      { filename: 'broken.pdf', content: pdf.subarray(0, pdf.length - 20) },
      { filename: 'big.pdf', content: Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(5000, 32), Buffer.from('%%EOF')]) },
    ]);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('ALL_FILES_REJECTED');
    expect(r.body.details.files.map((f: Json) => f.error.code)).toEqual(['UNSUPPORTED_FORMAT', 'CORRUPTED_FILE', 'FILE_TOO_LARGE']);
    expect(r.body.details.files[0].error.message).toContain('PDF, DOCX, XML');
  });

  it('частично принятый пакет: хороший файл сохраняется, auto_start=false не запускает анализ', async () => {
    const r = await send(
      [
        { filename: 'ok.pdf', content: await makePdf(1) },
        { filename: 'bad.doc', content: Buffer.from('xx') },
      ],
      { auto_start: 'false', stage_hints: JSON.stringify({ 'ok.pdf': 'RD' }) },
    );
    expect(r.status).toBe(202);
    expect(r.body.process_status).toBe('PENDING');
    expect(r.body.files.map((f: Json) => f.status)).toEqual(['UPLOADED', 'REJECTED']);
    expect(r.body.upload_status).toEqual(['PD_MISSING', 'RD_PARTIAL', 'ID_MISSING']);
  });

  it('превышение лимита пакета — 413 для всего пакета', async () => {
    const pdf = await makePdf(1);
    const filler = Buffer.concat([pdf.subarray(0, pdf.length - 6), Buffer.alloc(3500 - pdf.length, 32), Buffer.from('\n%%EOF')]);
    const r = await send([
      { filename: 'a.pdf', content: filler },
      { filename: 'b.pdf', content: Buffer.from(filler) },
      { filename: 'c.pdf', content: Buffer.from(filler) },
    ]);
    expect(r.status).toBe(413);
    expect(r.body.code).toBe('BATCH_TOO_LARGE');
  });
});

describe('ML недоступен (HTTP-транспорт)', () => {
  it('после повторов проверка переходит в FAILED, администратор уведомлён', async () => {
    const t = await makeTestApp({ ml: { transport: 'http', url: 'http://127.0.0.1:9', jobTimeoutMs: 60_000, maxRetries: 1, stubDelayMs: 0 } } as never);
    try {
      const headers = await login(t.app, 'inspector');
      const obj = await t.app.inject({ method: 'POST', url: '/api/v1/objects', headers, payload: { name: 'Без ML' } });
      const mp = multipart([
        { name: 'object_id', value: obj.json().id },
        { name: 'files', filename: 'Раздел 4 КР.pdf', content: await makePdf(1) },
      ]);
      const up = await t.app.inject({ method: 'POST', url: '/api/v1/documents/upload', headers: { ...headers, ...mp.headers }, payload: mp.payload });
      expect(up.statusCode).toBe(202);
      const status = await t.app.inject({ url: `/api/v1/processes/${up.json().process_id}/status`, headers });
      expect(status.json()).toMatchObject({ status: 'FAILED' });
      expect(status.json().error).toContain('Ни один файл');
      const admin = await login(t.app, 'admin');
      const notes = (await t.app.inject({ url: '/api/v1/notifications', headers: admin })).json() as Json[];
      expect(notes.some((n) => n.type === 'ADMIN_ALERT')).toBe(true);
    } finally {
      await t.cleanup();
    }
  });
});

describe('пароль демо-пользователей на стенде (DEMO_PASSWORD)', () => {
  it('с заданным паролем вход «логин = пароль» не работает', async () => {
    const t = await makeTestApp({ demoPassword: 'Стенд-2026!' });
    try {
      const weak = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'inspector', password: 'inspector' } });
      expect(weak.statusCode).toBe(401);
      const ok = await t.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'inspector', password: 'Стенд-2026!' } });
      expect(ok.statusCode).toBe(200);
    } finally {
      await t.cleanup();
    }
  });
});
