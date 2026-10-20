import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, makePdf, makeTestApp, multipart, waitFor } from './helpers.js';

type Json = Record<string, any>;

/** Имя как в распакованном датасете: байты CP866, прочитанные как Mac Cyrillic. */
const broken = (s: string) => {
  const dos = new TextDecoder('ibm866');
  const cp866 = new Map<string, number>();
  for (let b = 0; b < 256; b++) cp866.set(dos.decode(Uint8Array.of(b)), b);
  return new TextDecoder('x-mac-cyrillic').decode(Uint8Array.from([...s].map((ch) => cp866.get(ch)!)));
};

describe('доработки по уточнённым требованиям', () => {
  let t: Awaited<ReturnType<typeof makeTestApp>>;
  let inspector: Record<string, string>;
  let importRoot: string;
  let objectId: string;
  let processId: string;

  const req = async (method: string, url: string, payload?: unknown, headers = inspector) => {
    const res = await t.app.inject({ method: method as 'GET', url, headers, payload: payload as Json });
    return { status: res.statusCode, body: (res.body ? res.json() : {}) as Json };
  };
  const waitDone = (id: string) =>
    waitFor(
      () => req('GET', `/api/v1/processes/${id}/status`),
      (r) => !['PENDING', 'PARSING'].includes(r.body.status),
    );

  beforeAll(async () => {
    importRoot = mkdtempSync(path.join(tmpdir(), 'inspector-import-'));
    const obj = path.join(importRoot, broken('Алтуфьевское, 79Б'));
    mkdirSync(path.join(obj, broken('Проектная документация')), { recursive: true });
    mkdirSync(path.join(obj, broken('Рабочая документация')), { recursive: true });
    writeFileSync(path.join(obj, broken('Проектная документация'), broken('4. П-2025-04-266-КР.pdf')), await makePdf(2, 'KR'));
    writeFileSync(path.join(obj, broken('Рабочая документация'), broken('Альбом 1.pdf')), await makePdf(2, 'KJ'));
    writeFileSync(path.join(obj, '.DS_Store'), 'x');
    t = await makeTestApp({ importRoot });
    inspector = await login(t.app, 'inspector');
  });
  afterAll(async () => {
    await t.cleanup();
    rmSync(importRoot, { recursive: true, force: true });
  });

  it('манифест: метаданные из манифеста, связь редакций, полнота по ожидаемому составу', async () => {
    const obj = await req('POST', '/api/v1/objects', { name: 'С манифестом', external_id: 'OBJ-07' });
    expect(obj.body.external_id).toBe('OBJ-07');
    objectId = obj.body.id;
    const manifest = {
      files: [
        { file_name: 'kr-old.pdf', doc_stage: 'PD', discipline: 'КР', document_code: 'П-2025-04-266-КР', revision: '0', approval_status: 'SUPERSEDED' },
        { file_name: 'kr-new.pdf', doc_stage: 'PD', discipline: 'КР', document_code: 'П-2025-04-266-КР', revision: '1', approval_status: 'APPROVED', approval_date: '2026-04-27', predecessor_file_name: 'kr-old.pdf' },
        { file_name: 'kj.pdf', doc_stage: 'RD', discipline: 'КЖ', document_code: 'П-2025-04-266-КЖ01', revision: '0', approval_status: 'APPROVED' },
      ],
      // строки files[] сами входят в ожидаемый состав; expected — то, чего нет среди файлов
      expected: [{ doc_stage: 'ID', title: 'АОСР на армирование фундаментной плиты' }],
    };
    const mp = multipart([
      { name: 'object_id', value: objectId },
      { name: 'manifest', value: JSON.stringify(manifest) },
      { name: 'files', filename: 'kr-old.pdf', content: await makePdf(1, 'old') },
      { name: 'files', filename: 'kr-new.pdf', content: await makePdf(1, 'new') },
      { name: 'files', filename: 'kj.pdf', content: await makePdf(1, 'kj') },
    ]);
    const up = await t.app.inject({ method: 'POST', url: '/api/v1/documents/upload', headers: { ...inspector, ...mp.headers }, payload: mp.payload });
    expect(up.statusCode, up.body).toBe(202);
    expect(up.json().upload_status).toEqual(['PD_UPLOADED', 'RD_UPLOADED', 'ID_MISSING']);
    processId = up.json().process_id;
    await waitDone(processId);

    const proc = await req('GET', `/api/v1/processes/${processId}`);
    expect(proc.body.scenario).toBe('PARTIALLY_LOADED');
    expect(proc.body.completeness).toMatchObject({ status: 'MISSING_EVIDENCE', registry: 'PRESENT', basis: 'MANIFEST', expected_total: 4, present_total: 3 });
    expect(proc.body.completeness.missing[0].title).toContain('АОСР');

    const files = (await req('GET', `/api/v1/processes/${processId}/files`)).body as unknown as Json[];
    const byName = Object.fromEntries(files.map((f) => [f.original_name, f]));
    expect(byName['kr-new.pdf']).toMatchObject({ metadata_source: 'MANIFEST', revision: '1', approval_status: 'APPROVED', predecessor_id: byName['kr-old.pdf'].id });
    expect(byName['kr-old.pdf'].successor_id).toBe(byName['kr-new.pdf'].id);
    expect(byName['kr-old.pdf']).toMatchObject({ in_registry: true, excluded_from_comparison: true });
    expect(byName['kr-new.pdf'].excluded_from_comparison).toBe(false);
  });

  it('невалидный манифест отклоняется', async () => {
    const mp = multipart([
      { name: 'object_id', value: objectId },
      { name: 'manifest', value: JSON.stringify({ files: [{ doc_stage: 'XX' }] }) },
      { name: 'files', filename: 'a.pdf', content: await makePdf(1, 'a') },
    ]);
    const r = await t.app.inject({ method: 'POST', url: '/api/v1/documents/upload', headers: { ...inspector, ...mp.headers }, payload: mp.payload });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('REGISTRY_INVALID');
    expect(r.json().details.errors.join(' ')).toContain('неизвестная стадия');
  });

  it('инспектор не правит метаданные, но выбирает авторитетную редакцию с основанием', async () => {
    const files = (await req('GET', `/api/v1/processes/${processId}/files`)).body as unknown as Json[];
    const old = files.find((f) => f.original_name === 'kr-old.pdf')!;
    const denied = await req('PATCH', `/api/v1/files/${old.id}`, { doc_stage: 'RD', comment: 'хочу поменять' });
    expect(denied.status).toBe(400);
    expect(denied.body.code).toBe('METADATA_READONLY');
    const noBasis = await req('PATCH', `/api/v1/files/${old.id}`, { is_authoritative: true });
    expect(noBasis.status).toBe(400);
    const ok = await req('PATCH', `/api/v1/files/${old.id}`, { is_authoritative: true, comment: 'Изменение 1 не согласовано', reference: 'Письмо №12' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.is_authoritative).toBe(true);
    expect(ok.body.authoritative_basis).toContain('Письмо №12');
    // явный выбор инспектора важнее статуса SUPERSEDED
    expect(ok.body.excluded_from_comparison).toBe(false);
    const st = await waitDone(processId);
    expect(st.body.current_protocol_version).toBe(2);
  });

  it('правка доказательств создаёт новую версию и переживает пересчёт; решение сохраняется', async () => {
    const st = await req('GET', `/api/v1/processes/${processId}/status`);
    const protocolId = st.body.current_protocol_id;
    const cand = (await req('GET', `/api/v1/protocols/${protocolId}/findings?finding_status=CANDIDATE`)).body.items[0];
    const [expected, actual] = cand.evidence_group.fragments;
    const edited = await req('POST', `/api/v1/findings/${cand.id}/evidence`, {
      reason: 'Модель указала не ту строку спецификации',
      reference: 'КЖ01, лист 1, поз. 3',
      remove_fragment_ids: [actual.id],
      add: [{ role: 'ACTUAL', file_id: actual.file_id, page: 1, bbox: [0.1, 0.5, 0.4, 0.55], extracted_value: 'B25' }],
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.evidence_history.map((v: Json) => v.source)).toEqual(['MODEL', 'INSPECTOR']);
    expect(edited.body.evidence_history[1]).toMatchObject({ version: 2, reason: 'Модель указала не ту строку спецификации', created_by_name: expect.stringContaining('Иванов') });
    const added = edited.body.evidence_group.fragments.find((f: Json) => f.source === 'MANUAL');
    expect(added).toMatchObject({ sha256: actual.sha256, stage: 'RD', bbox: [0.1, 0.5, 0.4, 0.55], extraction_method: null });
    expect(edited.body.evidence_group.fragments.some((f: Json) => f.id === expected.id)).toBe(false); // копия, не та же запись
    // оставленный фрагмент модели копируется вместе с пометкой, как найдено значение
    expect(edited.body.evidence_group.fragments.find((f: Json) => f.role === 'EXPECTED').extraction_method).toBe(expected.extraction_method);
    expect(expected.extraction_method).toBe('RULES');

    const bad = await req('POST', `/api/v1/findings/${cand.id}/evidence`, { reason: 'пусто', remove_fragment_ids: edited.body.evidence_group.fragments.map((f: Json) => f.id) });
    expect(bad.status).toBe(400);
    const outside = await req('POST', `/api/v1/findings/${cand.id}/evidence`, { reason: 'не та страница', add: [{ role: 'ACTUAL', file_id: actual.file_id, page: 99, bbox: [0, 0, 0.1, 0.1] }] });
    expect(outside.status).toBe(400);

    const confirmed = await req('POST', `/api/v1/findings/${cand.id}/decision`, { action: 'CONFIRM' });
    expect(confirmed.status).toBe(200);

    // дозагрузка → новая версия протокола: правка инспектора и решение сохраняются
    const mp = multipart([
      { name: 'process_id', value: processId },
      { name: 'files', filename: '2. СПОЗУ.pdf', content: await makePdf(1, 'spozu') },
    ]);
    const up = await t.app.inject({ method: 'POST', url: '/api/v1/documents/upload', headers: { ...inspector, ...mp.headers }, payload: mp.payload });
    expect(up.statusCode).toBe(202);
    const after = await waitDone(processId);
    const again = (await req('GET', `/api/v1/protocols/${after.body.current_protocol_id}/findings?finding_status=CANDIDATE`)).body.items[0];
    expect(again.finding_status).toBe('CONFIRMED_VIOLATION');
    expect(again.evidence_history.map((v: Json) => v.source)).toEqual(['MODEL', 'INSPECTOR']);
    expect(again.evidence_changed).toBe(false);
  });

  it('массовое решение: только CONFIRM/CLARIFY и только один параметр', async () => {
    // новая проверка, кандидата делим на две части — получаем два кандидата одного параметра
    const mp = multipart([
      { name: 'object_id', value: objectId },
      { name: 'files', filename: '4. П-2025-04-266-КР.pdf', content: await makePdf(1, 'bulk-kr') },
      { name: 'files', filename: 'П-2025-04-266-КЖ01.pdf', content: await makePdf(1, 'bulk-kj') },
    ]);
    const up = await t.app.inject({ method: 'POST', url: '/api/v1/documents/upload', headers: { ...inspector, ...mp.headers }, payload: mp.payload });
    const pid = up.json().process_id;
    const st = await waitDone(pid);
    const cand = (await req('GET', `/api/v1/protocols/${st.body.current_protocol_id}/findings?finding_status=CANDIDATE`)).body.items[0];
    const [f1, f2] = cand.evidence_group.fragments;
    const parts = await req('POST', `/api/v1/findings/${cand.id}/split`, {
      parts: [
        { rule_key: 'Плита Пм-1', fragment_ids: [f1.id] },
        { rule_key: 'Плита Пм-2', fragment_ids: [f2.id] },
      ],
    });
    expect(parts.status).toBe(200);
    const ids = (parts.body as unknown as Json[]).map((x) => x.id);

    const reject = await req('POST', '/api/v1/findings/bulk-decision', { finding_ids: ids, action: 'REJECT', comment: 'все сразу' });
    expect(reject.status).toBe(400);
    const pz = (await req('GET', `/api/v1/protocols/${st.body.current_protocol_id}/findings?param_code=M-002`)).body.items[0];
    const mixed = await req('POST', '/api/v1/findings/bulk-decision', { finding_ids: [ids[0], pz.id], action: 'CONFIRM' });
    expect(mixed.status).toBe(400);
    expect(mixed.body.code).toBe('BULK_MIXED');

    const ok = await req('POST', '/api/v1/findings/bulk-decision', { finding_ids: ids, action: 'CONFIRM', comment: 'Обе плиты — понижение класса' });
    expect(ok.status).toBe(200);
    expect((ok.body as unknown as Json[]).map((x) => x.finding_status)).toEqual(['CONFIRMED_VIOLATION', 'CONFIRMED_VIOLATION']);
    expect((await req('GET', `/api/v1/processes/${pid}`)).body.status).toBe('COMPLETED');
  });

  it('серверный импорт папки: исправление имён, стадия по папке, защита пути', async () => {
    const r = await req('POST', '/api/v1/documents/import', { path: 'Алтуфьевское, 79Б', object_name: 'Алтуфьевское ш., 79Б', external_id: 'ALT-79B' });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.files.map((f: Json) => f.original_name).sort()).toEqual(['4. П-2025-04-266-КР.pdf', 'Альбом 1.pdf']);
    const st = await waitDone(r.body.process_id);
    expect(st.body.status).toBe('READY');
    const files = (await req('GET', `/api/v1/processes/${r.body.process_id}/files`)).body as unknown as Json[];
    // «Альбом 1.pdf» по имени стадию не определить — берётся из папки «Рабочая документация»
    expect(Object.fromEntries(files.map((f) => [f.original_name, f.doc_stage]))).toEqual({ '4. П-2025-04-266-КР.pdf': 'PD', 'Альбом 1.pdf': 'RD' });
    const objects = (await req('GET', '/api/v1/objects?q=Алтуфьевское')).body.items;
    expect(objects[0].external_id).toBe('ALT-79B');

    expect((await req('POST', '/api/v1/documents/import', { path: '../etc', object_name: 'x' })).status).toBe(403);
    expect((await req('POST', '/api/v1/documents/import', { path: 'Нет такой папки', object_name: 'x' })).status).toBe(404);
    const admin = await login(t.app, 'ml');
    expect((await req('POST', '/api/v1/documents/import', { path: 'Алтуфьевское, 79Б' }, admin)).status).toBe(403);
  });
});
