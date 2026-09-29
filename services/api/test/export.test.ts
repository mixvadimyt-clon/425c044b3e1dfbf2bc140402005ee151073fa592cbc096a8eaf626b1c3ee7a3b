import { readdirSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, makePdf, makeTestApp, multipart, waitFor } from './helpers.js';

type Json = Record<string, any>;

/** Грубая проверка корректности XML: теги сбалансированы, нет «голых» амперсандов. */
function assertWellFormed(xml: string) {
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/);
  const stack: string[] = [];
  for (const m of xml.replace(/^<\?xml[^>]*\?>/, '').matchAll(/<(\/?)([\w:-]+)[^>]*?(\/?)>/g)) {
    if (m[3]) continue;
    if (m[1]) expect(stack.pop()).toBe(m[2]);
    else stack.push(m[2]);
  }
  expect(stack).toEqual([]);
}

describe('экспорт протокола', () => {
  let t: Awaited<ReturnType<typeof makeTestApp>>;
  let inspector: Record<string, string>;
  let processId: string;
  let protocolId: string;

  const req = async (method: string, url: string, payload?: unknown) => {
    const res = await t.app.inject({ method: method as 'GET', url, headers: inspector, payload: payload as Json });
    return { status: res.statusCode, body: (res.body ? res.json() : {}) as Json };
  };
  const exportAs = (format: string) => t.app.inject({ url: `/api/v1/protocols/${protocolId}/export?format=${format}`, headers: inspector });

  beforeAll(async () => {
    t = await makeTestApp();
    inspector = await login(t.app, 'inspector');
    const obj = await req('POST', '/api/v1/objects', { name: 'Алтуфьевское ш., 79Б', address: 'Москва, Алтуфьевское ш., 79Б', external_id: 'ALT79B', customer: 'ООО «Заказчик & партнёры»' });
    const registry = [
      'file_id,file_name,doc_stage,discipline,document_code,revision,approval_status',
      'ALT79B-000010,1. П-2025-04.266-ПЗ.pdf,PD,ПЗ,П-2025-04.266-ПЗ,0,APPROVED',
      'ALT79B-000040,4. П-2025-04-266-КР.pdf,PD,КР,П-2025-04-266-КР,1,APPROVED',
      'ALT79B-000077,РД-2025-04-266-АР2.pdf,RD,АР,РД-2025-04-266-АР2,0,FOR_CONSTRUCTION',
      'ALT79B-000081,П-2025-04-266-КЖ01.pdf,RD,КЖ,П-2025-04-266-КЖ01,0,FOR_CONSTRUCTION',
    ].join('\n');
    const mp = multipart([
      { name: 'object_id', value: obj.body.id },
      { name: 'registry', filename: 'registry.csv', content: Buffer.from(registry), contentType: 'text/csv' },
      { name: 'files', filename: '1. П-2025-04.266-ПЗ.pdf', content: await makePdf(1, 'exp-pz') },
      { name: 'files', filename: '4. П-2025-04-266-КР.pdf', content: await makePdf(2, 'exp-kr') },
      { name: 'files', filename: 'РД-2025-04-266-АР2.pdf', content: await makePdf(2, 'exp-ar') },
      { name: 'files', filename: 'П-2025-04-266-КЖ01.pdf', content: await makePdf(2, 'exp-kj') },
    ]);
    const up = await t.app.inject({ method: 'POST', url: '/api/v1/documents/upload', headers: { ...inspector, ...mp.headers }, payload: mp.payload });
    processId = up.json().process_id;
    const st = await waitFor(
      () => req('GET', `/api/v1/processes/${processId}/status`),
      (r) => !['PENDING', 'PARSING'].includes(r.body.status),
    );
    protocolId = st.body.current_protocol_id;

    // решения: класс бетона подтверждён, экспликация — отклонена с причиной
    const cands = (await req('GET', `/api/v1/protocols/${protocolId}/findings?finding_status=CANDIDATE`)).body.items as Json[];
    const kr = cands.find((f) => f.param_code === 'M-055')!;
    const ar = cands.find((f) => f.param_code === 'M-002')!;
    expect((await req('POST', `/api/v1/findings/${kr.id}/decision`, { action: 'CONFIRM', comment: 'Класс бетона понижен <без согласования>' })).status).toBe(200);
    expect(
      (await req('POST', `/api/v1/findings/${ar.id}/decision`, { action: 'REJECT', reason_code: 'APPROVED_CHANGE', comment: 'Изменение согласовано письмом № 7', approved_change_ref: 'Письмо № 7 от 01.03.2026' })).status,
    ).toBe(200);
  });
  afterAll(async () => t.cleanup());

  it('JSON — протокол как есть', async () => {
    const r = await exportAs('json');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/json');
    expect(r.headers['content-disposition']).toContain('.json');
    const p = r.json();
    expect(p.tables.confirmed_violations).toHaveLength(1);
    expect(p.input_files).toHaveLength(4);
  });

  it('GOLD — записи по схеме Приложения 1', async () => {
    const r = await exportAs('gold');
    expect(r.statusCode, r.body).toBe(200);
    const g = r.json();
    expect(g).toMatchObject({ schema: 'inspector-gold/1.0', object_id: 'ALT79B', protocol_version: 1, completeness: { status: 'COMPLETE', registry: 'PRESENT' } });
    const byStatus = (s: string) => (g.records as Json[]).filter((x) => x.finding_status === s);

    const confirmed = byStatus('CONFIRMED_VIOLATION');
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({
      matrix_code: 'M-055',
      expected_value: 'B30',
      actual_value: 'B25',
      source_expected_file_id: 'ALT79B-000040',
      source_expected_stage: 'PD',
      source_expected_code: 'П-2025-04-266-КР',
      source_expected_approval: 'APPROVED',
      source_expected_page: 1,
      source_actual_file_id: 'ALT79B-000081',
      source_actual_approval: 'FOR_CONSTRUCTION',
      approved_change_ref: 'NONE',
      completeness_status: 'COMPLETE',
      review_priority: 'HIGH',
      expert_name: expect.stringContaining('Иванов'),
      expert_reason_code: null,
      matrix_version: 'm-0.1',
      model_version: 'stub-0.1',
      split: null,
    });
    expect(confirmed[0].finding_id).toMatch(/^[0-9a-f]{40}$/);
    expect(confirmed[0].source_expected_bbox_polygon).toHaveLength(4);
    expect(confirmed[0].source_expected_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(confirmed[0].expert_timestamp).toBeTruthy();

    const negative = byStatus('NEGATIVE_VERIFIED');
    expect(negative.map((x) => [x.matrix_code, x.rule_key]).sort()).toEqual([
      ['M-002', 'Общая площадь здания'],
      ['M-002', 'Экспликация помещений 1-го этажа'],
    ]);
    // как найдено значение: в заглушке РД «Общей площади здания» найдена Sentence-BERT, остальное — правилами
    const area = negative.find((x) => x.rule_key === 'Общая площадь здания')!;
    expect(area.source_actual.map((x: Json) => x.extraction_method)).toEqual(['SBERT']);
    expect(area.source_expected.map((x: Json) => x.extraction_method)).toEqual(['RULES']);
    const rejected = negative.find((x) => x.expert_id)!;
    expect(rejected).toMatchObject({ expert_reason_code: 'APPROVED_CHANGE', approved_change_ref: 'Письмо № 7 от 01.03.2026' });
    expect(negative.find((x) => !x.expert_id)!.approved_change_ref).toBe('NONE');

    const suspicion = byStatus('SUSPICION');
    expect(suspicion).toHaveLength(1);
    expect(suspicion[0]).toMatchObject({ matrix_code: null, rule_version: 'free-search:VISUAL_DIFF@stub-0.1', source_expected_stage: 'PD', source_actual_stage: 'RD' });
    expect(g.not_evaluated).toEqual([]);
  });

  it('submission — ответ в формате организаторов: внешние коды, location, файл и страница', async () => {
    const r = await exportAs('submission');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['content-disposition']).toContain('.submission.json');
    const sub = r.json();
    expect(sub.object_id).toBe('ALT79B');
    const byKey = new Map((sub.checks as Json[]).map((c) => [`${c.parameter_code}|${c.location ?? ''}`, c]));
    expect([...byKey.keys()].filter((k) => !k.startsWith('FREE-')).sort()).toEqual([
      'KR-055|Фундаментная плита Пм-1',
      'PZ-002|Общая площадь здания',
      'PZ-002|Экспликация помещений 1-го этажа',
    ]);
    expect(byKey.get('KR-055|Фундаментная плита Пм-1')).toMatchObject({
      pd_value: 'B30',
      rd_value: 'B25',
      id_value: null,
      violation_label: 'VIOLATION_PRESENT',
      protocol_status: 'CRITICAL',
      criticality: 'Критическое (приостановка работ)',
    });
    expect(byKey.get('KR-055|Фундаментная плита Пм-1')!.evidence).toEqual([
      { stage: 'PD', file_id: 'ALT79B-000040', pdf_page_number: 1 },
      expect.objectContaining({ stage: 'RD', file_id: 'ALT79B-000081' }),
    ]);
    for (const c of (sub.checks as Json[]).filter((x) => x.parameter_code === 'PZ-002')) {
      expect(c).toMatchObject({ violation_label: 'NO_VIOLATION', protocol_status: 'OK' });
    }
    // гипотеза свободного поиска — в тех же checks[] с кодом FREE-<ТЕМА>-<NNN>, как FREE-HEATING-001 у организаторов
    const free = (sub.checks as Json[]).filter((x) => x.parameter_code.startsWith('FREE-'));
    expect(free).toHaveLength(1);
    expect(free[0]).toMatchObject({ location: null, violation_label: 'VIOLATION_PRESENT', protocol_status: 'WARNING', criticality: 'Существенное (предписание)' });
    expect(free[0].parameter_code).toMatch(/^FREE-[A-Z]+-001$/);
    expect(free[0].evidence.map((e: Json) => e.stage)).toEqual(['PD', 'RD']);
  });

  it('submission: гипотезы ниже порога уверенности не выгружаются, тема — по марке документа', async () => {
    const { buildSubmission, freeTopic } = await import('../src/modules/export/submission.js');
    const { loadExportModel } = await import('../src/modules/export/report.js');
    const model = loadExportModel(t.ctx.db, protocolId);
    expect(buildSubmission(t.ctx.db, model, 0.9).checks.some((c) => c.parameter_code.startsWith('FREE-'))).toBe(false);
    expect([freeTopic('ОВ1'), freeTopic('ИОС4'), freeTopic('КЖ'), freeTopic('АР'), freeTopic(null)]).toEqual(['HEATING', 'HEATING', 'STRUCT', 'ARCH', 'GENERAL']);
  });

  it('XML — корректный документ со всеми таблицами и экранированием', async () => {
    const r = await exportAs('xml');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/xml');
    const xml = r.body;
    assertWellFormed(xml);
    expect(xml).toContain('<protocol xmlns="urn:inspector-ai:protocol:1"');
    expect(xml).toContain('<customer>ООО «Заказчик &amp; партнёры»</customer>');
    expect(xml).toContain('Класс бетона понижен &lt;без согласования&gt;');
    expect(xml).toMatch(/<confirmed_violations><finding [^>]*param_code="M-055"/);
    expect(xml).toContain('external_file_id="ALT79B-000077"');
    expect(xml).toContain('<completeness status="COMPLETE" registry="PRESENT"');
    expect(xml).toMatch(/<fragment [^>]*extraction_method="SBERT"/);
  });

  it('DOCX — документ Word с таблицами протокола', async () => {
    const r = await exportAs('docx');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toContain('.docx');
    const files = unzipSync(new Uint8Array(r.rawPayload));
    const body = strFromU8(files['word/document.xml']);
    for (const text of ['Протокол автоматизированной сверки', '3. Подтверждённые нарушения', 'M-055', 'ALT79B-000040', 'Проверенные отрицательные']) {
      expect(body).toContain(text);
    }
    expect(body).toContain('w:orient="landscape"');
  });

  it('PDF — со шрифтом с кириллицей, финализированный сохраняется и отдаётся повторно', async () => {
    const r = await exportAs('pdf');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    const pdf = r.rawPayload;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('DejaVuSans');
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
    expect(doc.getPage(0).getWidth()).toBeGreaterThan(doc.getPage(0).getHeight()); // альбомная

    expect((await req('POST', `/api/v1/processes/${processId}/finalize`, {})).status).toBe(200);
    const first = await exportAs('pdf');
    expect(readdirSync(t.ctx.storage.pathOf(`protocols/${processId}`))).toEqual([expect.stringMatching(/^v1-\d+\.pdf$/)]);
    const second = await exportAs('pdf');
    expect(second.rawPayload.equals(first.rawPayload)).toBe(true);
    const audit = (await t.app.inject({ url: '/api/v1/audit?page_size=200', headers: await login(t.app, 'admin') })).json();
    const exports = (audit.items as Json[]).filter((a) => a.action === 'exportProtocol' && a.details.format === 'pdf');
    expect(exports.map((a) => a.details.cached)).toContain(true);
  });

  it('после отмены финализации и новых решений протокол собирается заново', async () => {
    const before = await exportAs('xml');
    const supervisor = await login(t.app, 'supervisor');
    const un = await t.app.inject({ method: 'POST', url: `/api/v1/processes/${processId}/unfinalize`, headers: supervisor, payload: { reason: 'Ошибка в решении' } });
    expect(un.statusCode, un.body).toBe(200);
    const kr = (await req('GET', `/api/v1/protocols/${protocolId}/findings?param_code=M-055`)).body.items[0] as Json;
    expect((await req('POST', `/api/v1/findings/${kr.id}/decision`, { action: 'REJECT', reason_code: 'OCR_ERROR', comment: 'Повторное решение' })).status).toBe(200);
    expect((await req('POST', `/api/v1/processes/${processId}/finalize`, {})).status).toBe(200);

    const after = await exportAs('xml');
    expect(after.body).not.toBe(before.body);
    expect(after.body).toContain('Повторное решение');
    expect((await exportAs('pdf')).statusCode).toBe(200);
    expect(readdirSync(t.ctx.storage.pathOf(`protocols/${processId}`)).filter((f) => f.endsWith('.pdf'))).toHaveLength(2);
  });

  it('прежняя версия протокола выгружается с полнотой на момент её сравнения', async () => {
    const obj = await req('POST', '/api/v1/objects', { name: 'Версии протокола' });
    const registry = ['file_id,file_name,doc_stage,discipline,document_code', 'VER-1,4. П-КР.pdf,PD,КР,П-2025-04-266-КР', 'VER-2,П-КЖ01.pdf,RD,КЖ,П-2025-04-266-КЖ01'].join('\n');
    const uploadAndWait = async (parts: Parameters<typeof multipart>[0]) => {
      const mp = multipart(parts);
      const r = await t.app.inject({ method: 'POST', url: '/api/v1/documents/upload', headers: { ...inspector, ...mp.headers }, payload: mp.payload });
      expect(r.statusCode, r.body).toBe(202);
      const pid = r.json().process_id as string;
      await waitFor(() => req('GET', `/api/v1/processes/${pid}/status`), (x) => !['PENDING', 'PARSING'].includes(x.body.status));
      return pid;
    };
    // v1 — без РД (не хватает файла из реестра), v2 — после дозагрузки
    const pid = await uploadAndWait([
      { name: 'object_id', value: obj.body.id },
      { name: 'registry', filename: 'registry.csv', content: Buffer.from(registry), contentType: 'text/csv' },
      { name: 'files', filename: '4. П-КР.pdf', content: await makePdf(2, 'ver-kr') },
    ]);
    await uploadAndWait([
      { name: 'process_id', value: pid },
      { name: 'files', filename: 'П-КЖ01.pdf', content: await makePdf(2, 'ver-kj') },
    ]);

    const versions = (await req('GET', `/api/v1/processes/${pid}/protocols`)).body;
    const list = (Array.isArray(versions) ? versions : versions.items) as Json[];
    const byVersion = new Map(list.map((v) => [v.version, v.id ?? v.protocol_id]));
    expect([...byVersion.keys()].sort()).toEqual([1, 2]);
    const gold = async (id: string) =>
      (await t.app.inject({ url: `/api/v1/protocols/${id}/export?format=gold`, headers: inspector })).json().completeness as Json;
    expect(await gold(byVersion.get(1))).toMatchObject({ status: 'MISSING_EVIDENCE', present_total: 1, expected_total: 2 });
    expect(await gold(byVersion.get(2))).toMatchObject({ status: 'COMPLETE', present_total: 2 });
  });

  it('неизвестный протокол и формат', async () => {
    const missing = await t.app.inject({ url: `/api/v1/protocols/${crypto.randomUUID()}/export?format=pdf`, headers: inspector });
    expect(missing.statusCode).toBe(404);
    const bad = await exportAs('rtf');
    expect(bad.statusCode).toBe(400);
  });
});
