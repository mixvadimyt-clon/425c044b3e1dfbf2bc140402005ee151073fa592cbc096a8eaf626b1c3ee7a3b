import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { zipEntryName } from '../src/modules/archive.js';
import { looksLikeRegistry, parseRegistry } from '../src/modules/registry.js';
import { readXlsxFirstSheet } from '../src/modules/tabular.js';
import { login, makePdf, makeTestApp, multipart, waitFor } from './helpers.js';

type Json = Record<string, any>;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Минимальный XLSX (inline-строки, числа) — как выгружает Excel/LibreOffice. */
function makeXlsx(rows: (string | number)[][]): Buffer {
  const col = (i: number) => String.fromCharCode(65 + i);
  const sheetRows = rows
    .map(
      (r, ri) =>
        `<row r="${ri + 1}">` +
        r
          .map((v, ci) =>
            typeof v === 'number'
              ? `<c r="${col(ci)}${ri + 1}" s="1"><v>${v}</v></c>`
              : `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`,
          )
          .join('') +
        '</row>',
    )
    .join('');
  const ns = 'http://schemas.openxmlformats.org';
  return Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8(`<?xml version="1.0"?><Types xmlns="${ns}/package/2006/content-types"/>`),
      'xl/workbook.xml': strToU8(
        `<?xml version="1.0"?><workbook xmlns="${ns}/spreadsheetml/2006/main" xmlns:r="${ns}/officeDocument/2006/relationships"><sheets><sheet name="Реестр" sheetId="1" r:id="rId7"/></sheets></workbook>`,
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        `<?xml version="1.0"?><Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId7" Type="${ns}/officeDocument/2006/relationships/worksheet" Target="worksheets/registry.xml"/></Relationships>`,
      ),
      'xl/worksheets/registry.xml': strToU8(`<?xml version="1.0"?><worksheet xmlns="${ns}/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`),
    }),
  );
}

describe('разбор реестра файлов', () => {
  it('CSV с «;», русскими заголовками и значениями, строкой-заголовком не в начале', () => {
    const csv = [
      'Реестр файлов комплекта;;;',
      'Идентификатор файла;Имя файла;Стадия;Раздел/марка;Шифр документа;Редакция;Статус утверждения;Дата утверждения;Диапазон листов;Предшественник;Подпись',
      'ALT79B-000015;3. АР.pdf;ПД;АР;П-2025-04.266-АР;1;Утверждена;27.04.2026;1-56;;есть',
      'ALT79B-000077;РД-2025-04-266-АР2.pdf;РД;АР;РД-2025-04-266-АР2;0;В производство работ;2025-11-11;1-26;;УКЭП',
      'ALT79B-000014;3. АР старый.pdf;ПД;АР;П-2025-04.266-АР;0;Заменена;01.02.2025;;;нет',
    ].join('\r\n');
    const { format, manifest } = parseRegistry(Buffer.from('\uFEFF' + csv), 'реестр.csv');
    expect(format).toBe('CSV');
    expect(manifest.files).toHaveLength(3);
    expect(manifest.files![0]).toMatchObject({
      file_id: 'ALT79B-000015',
      doc_stage: 'PD',
      approval_status: 'APPROVED',
      approval_date: '2026-04-27',
      sheet_page_range: '1-56',
      signature_status: 'SIGNED',
    });
    expect(manifest.files![1]).toMatchObject({ doc_stage: 'RD', approval_status: 'FOR_CONSTRUCTION', signature_status: 'QES' });
    expect(manifest.files![2]).toMatchObject({ approval_status: 'SUPERSEDED', signature_status: 'ABSENT' });
  });

  it('XLSX: даты Excel числами, контрольные суммы, object_id → object_external_id', () => {
    const xlsx = makeXlsx([
      ['object_id', 'file_id', 'file_name', 'sha256', 'doc_stage', 'approval_status', 'approval_date', 'successor_id'],
      ['ALT79B', 'ALT79B-000001', 'a.pdf', 'A'.repeat(64), 'PD', 'DRAFT', 46139, 'ALT79B-000002'],
      ['ALT79B', 'ALT79B-000002', 'b.pdf', 'b'.repeat(64), 'PD', 'CANCELLED', '', ''],
    ]);
    const { format, manifest } = parseRegistry(xlsx, 'registry.xlsx');
    expect(format).toBe('XLSX');
    expect(manifest.object_external_id).toBe('ALT79B');
    expect(manifest.files![0]).toMatchObject({ sha256: 'a'.repeat(64), approval_status: 'DRAFT', approval_date: '2026-04-27', successor_id: 'ALT79B-000002' });
    expect(manifest.files![1].approval_status).toBe('CANCELLED');
  });

  it('ошибки значений собираются с номерами строк', () => {
    const csv = 'file_name,doc_stage,approval_status,sha256,approval_date\na.pdf,XX,maybe,123,вчера\n,PD,,,\n';
    try {
      parseRegistry(Buffer.from(csv), 'r.csv');
      expect.unreachable();
    } catch (err) {
      const e = err as { code: string; details: { errors: string[] } };
      expect(e.code).toBe('REGISTRY_INVALID');
      expect(e.details.errors).toHaveLength(5);
      expect(e.details.errors[0]).toContain('строка 2');
      expect(e.details.errors[4]).toContain('строка 3');
    }
    expect(() => parseRegistry(Buffer.from('колонка\nзначение'), 'r.csv')).toThrow(/строка заголовка/);
    expect(() => parseRegistry(Buffer.from('file_id,file_name\nX,a.pdf\nX,b.pdf'), 'r.csv')).toThrow(/ошибки/);
  });

  it('читает настоящий XLSX организаторов (Приложение 1, общие строки)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const rows = readXlsxFirstSheet(readFileSync(path.join(here, '../../../data/matrix/source/appendix1-matrix-v1.1.xlsx')));
    expect(rows[0]).toContain('Код параметра');
    expect(rows.filter((r) => /^M-\d{3}$/.test(String(r[1])))).toHaveLength(132);
  });
});

describe('реестр организаторов и имена в архивах', () => {
  it('document_manifest.jsonl организаторов читается как реестр: relative_path, stage, section, source_sha256', () => {
    const sha = 'a'.repeat(64);
    const jsonl = [
      JSON.stringify({ file_id: 'F0171', object_id: 'OBJ-RECHNIKOV-7-7', stage: 'PD', section: 'АР', relative_path: 'ПД/АР.pdf', source_sha256: sha, pdf_pages: 104, duplicate_group: null }),
      JSON.stringify({ file_id: 'F0418', object_id: 'OBJ-RECHNIKOV-7-7', stage: 'ID', section: 'ИД', relative_path: 'ИД/акты.zip', sha256: 'b'.repeat(64) }),
      '',
    ].join('\n');
    const { format, manifest } = parseRegistry(Buffer.from(jsonl), 'document_manifest.jsonl');
    expect(format).toBe('JSON');
    expect(manifest.object_external_id).toBe('OBJ-RECHNIKOV-7-7');
    expect(manifest.files![0]).toMatchObject({ file_id: 'F0171', file_name: 'ПД/АР.pdf', doc_stage: 'PD', discipline: 'АР', sha256: sha });
    expect(looksLikeRegistry('document_manifest.jsonl')).toBe(true);
    expect(() => parseRegistry(Buffer.from('{"file_id":"F1","file_name":"a.pdf"}\n{oops}'), 'm.jsonl')).toThrow(/строка 2/);
  });

  it('имена внутри zip: UTF-8 как есть, CP866 из Windows-архивов декодируется', () => {
    expect(zipEntryName('Акт 1.pdf')).toBe('Акт 1.pdf');
    expect(zipEntryName('plan.pdf')).toBe('plan.pdf');
    // «АР.pdf» в CP866 (0x80, 0x90), как его отдаёт fflate без флага UTF-8
    expect(zipEntryName(String.fromCharCode(0x80, 0x90) + '.pdf')).toBe('АР.pdf');
  });
});

describe('реестр в сценарии загрузки', () => {
  let t: Awaited<ReturnType<typeof makeTestApp>>;
  let inspector: Record<string, string>;
  let objectId: string;
  let importRoot: string;
  const pz = makePdf(1, 'reg-pz');
  const ar = makePdf(2, 'reg-ar');

  const req = async (method: string, url: string, payload?: unknown) => {
    const res = await t.app.inject({ method: method as 'GET', url, headers: inspector, payload: payload as Json });
    return { status: res.statusCode, body: (res.body ? res.json() : {}) as Json };
  };
  const send = async (url: string, parts: Parameters<typeof multipart>[0]) => {
    const mp = multipart(parts);
    const res = await t.app.inject({ method: 'POST', url, headers: { ...inspector, ...mp.headers }, payload: mp.payload });
    return { status: res.statusCode, body: res.json() as Json };
  };
  const waitDone = (id: string) =>
    waitFor(
      () => req('GET', `/api/v1/processes/${id}/status`),
      (r) => !['PENDING', 'PARSING'].includes(r.body.status),
    );

  beforeAll(async () => {
    importRoot = mkdtempSync(path.join(tmpdir(), 'inspector-registry-'));
    const dir = path.join(importRoot, 'Объект с реестром');
    mkdirSync(path.join(dir, 'ПД'), { recursive: true });
    writeFileSync(path.join(dir, 'ПД', '1. ПЗ.pdf'), await makePdf(1, 'imp-pz'));
    writeFileSync(path.join(dir, 'реестр файлов.csv'), 'file_id,file_name,doc_stage,approval_status\nIMP-1,1. ПЗ.pdf,PD,APPROVED\n');
    t = await makeTestApp({ importRoot });
    inspector = await login(t.app, 'inspector');
    objectId = (await req('POST', '/api/v1/objects', { name: 'Алтуфьевское ш., 79Б', external_id: 'ALT79B' })).body.id;
  });
  afterAll(async () => {
    await t.cleanup();
    rmSync(importRoot, { recursive: true, force: true });
  });

  it('загрузка с реестром CSV: file_id, недостающий файл, M-002 по ПЗ и РД АР', async () => {
    const csv = [
      'file_id;file_name;doc_stage;discipline;document_code;approval_status;sheet_page_range',
      'ALT79B-000010;1. П-2025-04.266-ПЗ.pdf;PD;ПЗ;П-2025-04.266-ПЗ;APPROVED;1-14',
      `ALT79B-000077;РД-2025-04-266-АР2.pdf;RD;АР;РД-2025-04-266-АР2;FOR_CONSTRUCTION;1-26`,
      'ALT79B-000099;ИД-АОСР-1.pdf;ID;АОСР;АОСР-1;APPROVED;1',
    ].join('\n');
    const r = await send('/api/v1/documents/upload', [
      { name: 'object_id', value: objectId },
      { name: 'registry', filename: 'реестр.csv', content: Buffer.from(csv), contentType: 'text/csv' },
      { name: 'files', filename: '1. П-2025-04.266-ПЗ.pdf', content: await pz },
      { name: 'files', filename: 'РД-2025-04-266-АР2.pdf', content: await ar },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.files.map((f: Json) => [f.external_file_id, f.warnings])).toEqual([
      ['ALT79B-000010', []],
      ['ALT79B-000077', []],
    ]);
    expect(r.body.upload_status).toEqual(['PD_UPLOADED', 'RD_UPLOADED', 'ID_MISSING']);
    const st = await waitDone(r.body.process_id);

    const proc = (await req('GET', `/api/v1/processes/${r.body.process_id}`)).body;
    expect(proc.completeness).toMatchObject({ status: 'MISSING_EVIDENCE', registry: 'PRESENT', registry_file_name: 'реестр.csv', expected_total: 3, present_total: 2 });
    expect(proc.completeness.issues).toEqual([expect.objectContaining({ code: 'MISSING_FILE', external_file_id: 'ALT79B-000099' })]);
    expect(proc.completeness.missing).toEqual([expect.objectContaining({ doc_stage: 'ID', file_name: 'ИД-АОСР-1.pdf' })]);

    const files = (await req('GET', `/api/v1/processes/${r.body.process_id}/files`)).body as unknown as Json[];
    expect(files[1]).toMatchObject({ doc_stage: 'RD', in_registry: true, sheet_page_range: '1-26', approval_status: 'FOR_CONSTRUCTION', metadata_source: 'MANIFEST' });

    const m002 = (await req('GET', `/api/v1/protocols/${st.body.current_protocol_id}/findings?param_code=M-002`)).body.items as Json[];
    expect(m002.map((f) => [f.rule_key, f.finding_status]).sort()).toEqual([
      ['Общая площадь здания', 'NEGATIVE_VERIFIED'],
      ['Экспликация помещений 1-го этажа', 'CANDIDATE'],
    ]);
  });

  it('дозагрузка файла вне реестра → NOT_IN_REGISTRY и CLARIFICATION_REQUIRED', async () => {
    const pid = (await req('GET', `/api/v1/processes?object_id=${objectId}`)).body.items[0].process_id;
    const r = await send('/api/v1/documents/upload', [
      { name: 'process_id', value: pid },
      { name: 'files', filename: 'лишний.pdf', content: await makePdf(1, 'extra') },
    ]);
    expect(r.status).toBe(202);
    expect(r.body.files[0].warnings.map((w: Json) => w.code)).toEqual(['NOT_IN_REGISTRY']);
    await waitDone(pid);
    const proc = (await req('GET', `/api/v1/processes/${pid}`)).body;
    expect(proc.completeness.status).toBe('CLARIFICATION_REQUIRED');
    expect(proc.completeness.issues.map((i: Json) => i.code)).toContain('NOT_IN_REGISTRY');
  });

  it('перезапись под тем же file_id запрещена; повторная загрузка того же файла — новая запись', async () => {
    const other = await send('/api/v1/documents/upload', [
      { name: 'object_id', value: objectId },
      { name: 'manifest', value: JSON.stringify({ files: [{ file_id: 'ALT79B-000010', file_name: 'другой.pdf', doc_stage: 'PD' }] }) },
      { name: 'files', filename: 'другой.pdf', content: await makePdf(1, 'other-content') },
    ]);
    expect(other.status).toBe(400);
    expect(other.body.details.files[0].error.code).toBe('FILE_ID_CONFLICT');

    const same = await send('/api/v1/documents/upload', [
      { name: 'object_id', value: objectId },
      { name: 'manifest', value: JSON.stringify([{ file_id: 'ALT79B-000010', file_name: 'ПЗ повторно.pdf', sha256: sha(await pz), doc_stage: 'PD' }]) },
      { name: 'files', filename: 'ПЗ повторно.pdf', content: await pz },
    ]);
    expect(same.status, JSON.stringify(same.body)).toBe(202);
    expect(same.body.files[0]).toMatchObject({ external_file_id: 'ALT79B-000010', duplicate_of: null, warnings: [] });
    await waitDone(same.body.process_id);
  });

  it('реестр XLSX после загрузки: метаданные, исключение заменённой редакции, новая версия протокола', async () => {
    const krOld = await makePdf(1, 'kr-v0');
    const krNew = await makePdf(1, 'kr-v1');
    const up = await send('/api/v1/documents/upload', [
      { name: 'object_id', value: objectId },
      { name: 'files', filename: 'КР ред0.pdf', content: krOld },
      { name: 'files', filename: 'КР ред1.pdf', content: krNew },
      { name: 'files', filename: 'КЖ01.pdf', content: await makePdf(1, 'kj-reg') },
    ]);
    const pid = up.body.process_id;
    const before = await waitDone(pid);
    expect(before.body.current_protocol_version).toBe(1);
    expect((await req('GET', `/api/v1/processes/${pid}`)).body.completeness).toMatchObject({ status: 'CLARIFICATION_REQUIRED', registry: 'ABSENT' });

    const xlsx = makeXlsx([
      ['Реестр файлов (приложение к сопроводительному письму)'],
      ['ID файла', 'Имя файла', 'SHA-256', 'Стадия', 'Марка', 'Шифр', 'Изм.', 'Статус', 'Заменена на'],
      ['KR-0', 'КР ред0.pdf', sha(krOld), 'ПД', 'КР', 'П-2025-04-266-КР', '0', 'SUPERSEDED', 'KR-1'],
      ['KR-1', 'КР ред1.pdf', sha(krNew), 'ПД', 'КР', 'П-2025-04-266-КР', 1, 'APPROVED', ''],
      ['KJ-1', 'КЖ01.pdf', '', 'РД', 'КЖ', 'П-2025-04-266-КЖ01', '0', 'FOR_CONSTRUCTION', ''],
    ]);
    const applied = await send(`/api/v1/processes/${pid}/registry`, [{ name: 'registry', filename: 'Реестр.xlsx', content: xlsx, contentType: 'application/octet-stream' }]);
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body).toMatchObject({ entries_total: 3, matched_files: 3, analysis_started: true, completeness: { status: 'COMPLETE', registry: 'PRESENT' } });

    const after = await waitDone(pid);
    expect(after.body.current_protocol_version).toBe(2);
    const versions = (await req('GET', `/api/v1/processes/${pid}/protocols`)).body as unknown as Json[];
    expect(versions[0].trigger).toBe('METADATA_CHANGE');

    const files = (await req('GET', `/api/v1/processes/${pid}/files`)).body as unknown as Json[];
    const byName = Object.fromEntries(files.map((f) => [f.original_name, f]));
    expect(byName['КР ред0.pdf']).toMatchObject({ external_file_id: 'KR-0', approval_status: 'SUPERSEDED', excluded_from_comparison: true, successor_id: byName['КР ред1.pdf'].id });
    expect(byName['КР ред1.pdf']).toMatchObject({ revision: '1', predecessor_id: byName['КР ред0.pdf'].id, excluded_from_comparison: false });

    // кандидат по классу бетона строится по действующей редакции
    const cand = (await req('GET', `/api/v1/protocols/${after.body.current_protocol_id}/findings?param_code=M-055`)).body.items[0];
    expect(cand.evidence_group.fragments[0].file_id).toBe(byName['КР ред1.pdf'].id);
  });

  it('неоднозначные редакции требуют уточнения, выбор инспектора снимает блокировку', async () => {
    const manifest = {
      files: [
        { file_name: 'КЖ-а.pdf', doc_stage: 'RD', document_code: 'РД-КЖ02', approval_status: 'APPROVED' },
        { file_name: 'КЖ-б.pdf', doc_stage: 'RD', document_code: 'РД-КЖ02', approval_status: 'APPROVED' },
      ],
    };
    const up = await send('/api/v1/documents/upload', [
      { name: 'object_id', value: objectId },
      { name: 'manifest', value: JSON.stringify(manifest) },
      { name: 'files', filename: 'КЖ-а.pdf', content: await makePdf(1, 'kj-a') },
      { name: 'files', filename: 'КЖ-б.pdf', content: await makePdf(1, 'kj-b') },
    ]);
    const pid = up.body.process_id;
    await waitDone(pid);
    const proc = (await req('GET', `/api/v1/processes/${pid}`)).body;
    expect(proc.completeness.status).toBe('CLARIFICATION_REQUIRED');
    expect(proc.completeness.issues[0]).toMatchObject({ code: 'AMBIGUOUS_REVISION' });
    expect(proc.completeness.issues[0].message).toContain('КЖ-а.pdf, КЖ-б.pdf');

    const files = (await req('GET', `/api/v1/processes/${pid}/files`)).body as unknown as Json[];
    const chosen = await req('PATCH', `/api/v1/files/${files[1].id}`, { is_authoritative: true, comment: 'Действующая редакция по письму заказчика' });
    expect(chosen.status).toBe(200);
    expect((await req('GET', `/api/v1/processes/${pid}`)).body.completeness.status).toBe('COMPLETE');
  });

  it('импорт папки находит реестр и не считает его документом', async () => {
    const r = await req('POST', '/api/v1/documents/import', { path: 'Объект с реестром', object_name: 'Импорт с реестром' });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.files.map((f: Json) => [f.original_name, f.external_file_id])).toEqual([['1. ПЗ.pdf', 'IMP-1']]);
    await waitDone(r.body.process_id);
    const proc = (await req('GET', `/api/v1/processes/${r.body.process_id}`)).body;
    expect(proc.completeness).toMatchObject({ registry: 'PRESENT', registry_file_name: 'реестр файлов.csv', status: 'COMPLETE' });
    expect((await req('POST', '/api/v1/documents/import', { path: 'Объект с реестром', object_name: 'x', registry_path: 'нет.csv' })).status).toBe(404);
  });

  it('загрузка реестра: пустой запрос и неверный формат', async () => {
    const pid = (await req('GET', `/api/v1/processes?object_id=${objectId}`)).body.items[0].process_id;
    const empty = await send(`/api/v1/processes/${pid}/registry`, [{ name: 'auto_start', value: 'false' }]);
    expect(empty.status).toBe(400);
    expect(empty.body.code).toBe('REGISTRY_INVALID');
    const bad = await send(`/api/v1/processes/${pid}/registry`, [{ name: 'registry', filename: 'r.txt', content: Buffer.from('x'), contentType: 'text/plain' }]);
    expect(bad.status).toBe(400);
  });
  const newObject = async (name: string) => (await req('POST', '/api/v1/objects', { name })).body.id as string;
  const csvFile = (rows: string[]) => ({ name: 'registry', filename: 'registry.csv', content: Buffer.from(rows.join('\n')), contentType: 'text/csv' });
  const filesOf = async (pid: string) => (await req('GET', `/api/v1/processes/${pid}/files`)).body as unknown as Json[];

  it('одинаково названные файлы разных стадий занимают свои строки реестра по контрольной сумме', async () => {
    const pd = await makePdf(1, 'same-name-pd');
    const rd = await makePdf(1, 'same-name-rd');
    const r = await send('/api/v1/documents/upload', [
      { name: 'object_id', value: await newObject('Одинаковые имена') },
      { name: 'auto_start', value: 'false' },
      csvFile(['file_id,file_name,doc_stage,sha256', `SN-1,Общие данные.pdf,PD,${sha(pd)}`, `SN-2,Общие данные.pdf,RD,${sha(rd)}`]),
      { name: 'files', filename: 'Общие данные.pdf', content: pd },
      { name: 'files', filename: 'Общие данные.pdf', content: rd },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.files.map((f: Json) => [f.status, f.external_file_id])).toEqual([
      ['UPLOADED', 'SN-1'],
      ['UPLOADED', 'SN-2'],
    ]);
    const files = await filesOf(r.body.process_id);
    expect(files.map((f) => [f.external_file_id, f.doc_stage])).toEqual([
      ['SN-1', 'PD'],
      ['SN-2', 'RD'],
    ]);
  });

  it('реестр, пришедший с дозагрузкой, применяется и к ранее загруженным файлам', async () => {
    const first = await send('/api/v1/documents/upload', [
      { name: 'object_id', value: await newObject('Реестр при дозагрузке') },
      { name: 'auto_start', value: 'false' },
      { name: 'files', filename: 'ПЗ.pdf', content: await makePdf(1, 'late-pz') },
    ]);
    const pid = first.body.process_id as string;
    expect((await req('GET', `/api/v1/processes/${pid}`)).body.completeness.status).toBe('CLARIFICATION_REQUIRED');

    const second = await send('/api/v1/documents/upload', [
      { name: 'process_id', value: pid },
      { name: 'auto_start', value: 'false' },
      csvFile(['file_id,file_name,doc_stage,approval_status', 'LR-1,ПЗ.pdf,PD,APPROVED', 'LR-2,АР.pdf,PD,APPROVED']),
      { name: 'files', filename: 'АР.pdf', content: await makePdf(1, 'late-ar') },
    ]);
    expect(second.status, JSON.stringify(second.body)).toBe(202);
    const proc = (await req('GET', `/api/v1/processes/${pid}`)).body;
    expect(proc.completeness).toMatchObject({ status: 'COMPLETE', registry: 'PRESENT', issues: [] });
    expect((await filesOf(pid)).map((f) => [f.original_name, f.external_file_id, f.approval_status])).toEqual([
      ['ПЗ.pdf', 'LR-1', 'APPROVED'],
      ['АР.pdf', 'LR-2', 'APPROVED'],
    ]);
  });

  it('исправленный реестр снимает ошибочную связь редакций', async () => {
    const up = await send('/api/v1/documents/upload', [
      { name: 'object_id', value: await newObject('Связь редакций') },
      { name: 'auto_start', value: 'false' },
      csvFile(['file_id,file_name,doc_stage,document_code,predecessor_id', 'RV-1,АР старый.pdf,PD,П-АР,', 'RV-2,АР новый.pdf,PD,П-АР,RV-1']),
      { name: 'files', filename: 'АР старый.pdf', content: await makePdf(1, 'rv-old') },
      { name: 'files', filename: 'АР новый.pdf', content: await makePdf(1, 'rv-new') },
    ]);
    const pid = up.body.process_id as string;
    const excluded = async () => (await filesOf(pid)).filter((f) => f.excluded_from_comparison).map((f) => f.original_name);
    expect(await excluded()).toEqual(['АР старый.pdf']);

    const fixed = await send(`/api/v1/processes/${pid}/registry`, [
      { name: 'auto_start', value: 'false' },
      csvFile(['file_id,file_name,doc_stage,document_code,predecessor_id', 'RV-1,АР старый.pdf,PD,П-АР-1,', 'RV-2,АР новый.pdf,PD,П-АР-2,']),
    ]);
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    expect(await excluded()).toEqual([]);
    expect((await filesOf(pid)).map((f) => f.predecessor_id)).toEqual([null, null]);
  });

  it('файл, выпавший из реестра, возвращается к стадии из подсказки пользователя', async () => {
    const up = await send('/api/v1/documents/upload', [
      { name: 'object_id', value: await newObject('Стадия после реестра') },
      { name: 'auto_start', value: 'false' },
      { name: 'stage_hints', value: JSON.stringify({ 'Записка.pdf': 'RD' }) },
      csvFile(['file_id,file_name,doc_stage', 'SH-1,Записка.pdf,PD', 'SH-2,ПЗ.pdf,PD']),
      { name: 'files', filename: 'Записка.pdf', content: await makePdf(1, 'sh-note') },
      { name: 'files', filename: 'ПЗ.pdf', content: await makePdf(1, 'sh-pz') },
    ]);
    const pid = up.body.process_id as string;
    expect((await filesOf(pid)).map((f) => f.doc_stage)).toEqual(['PD', 'PD']);
    await send(`/api/v1/processes/${pid}/registry`, [{ name: 'auto_start', value: 'false' }, csvFile(['file_id,file_name,doc_stage', 'SH-2,ПЗ.pdf,PD'])]);
    const note = (await filesOf(pid)).find((f) => f.original_name === 'Записка.pdf')!;
    expect(note).toMatchObject({ in_registry: false, doc_stage: 'RD' });
  });
  it('файл: ссылка на хранилище по хешу, кто загрузил, заголовок; журнал действий системы', async () => {
    const pz = await makePdf(1, 'meta-pz');
    const up = await send('/api/v1/documents/upload', [
      { name: 'object_id', value: await newObject('Метаданные и журнал') },
      csvFile(['file_id,file_name,doc_stage,title', 'MT-1,ПЗ.pdf,PD,Пояснительная записка']),
      { name: 'files', filename: 'ПЗ.pdf', content: pz },
    ]);
    const pid = up.body.process_id as string;
    await waitDone(pid);
    const [file] = await filesOf(pid);
    expect(file).toMatchObject({
      title: 'Пояснительная записка',
      storage_key: `raw/${sha(pz)}`,
      uploaded_by_name: 'Иванов Иван (инспектор)',
    });
    expect(file.uploaded_by).toBeTruthy();

    const admin = await login(t.app, 'admin');
    const audit = async (query: string) =>
      (await t.app.inject({ url: `/api/v1/audit?page_size=200&${query}`, headers: admin })).json().items as Json[];
    const system = (await audit('actor_type=SYSTEM')).filter((a) => a.details.process_id === pid);
    expect(system.map((a) => a.action).reverse()).toEqual([
      'system.analysis_started',
      'system.file_parsed',
      'system.compare_started',
      'system.protocol_created',
    ]);
    expect(system.every((a) => a.actor_type === 'SYSTEM' && a.user_id === null && a.user_name === 'Система «Инспектор ИИ»')).toBe(true);
    const parsed = system.find((a) => a.action === 'system.file_parsed')!;
    expect(parsed).toMatchObject({ entity_type: 'file', entity_id: file.id, details: { file_name: 'ПЗ.pdf' } });
    expect(system.find((a) => a.action === 'system.protocol_created')!.details.version).toBe(1);
    const users = await audit('actor_type=USER');
    expect(users.some((a) => a.action.startsWith('system.'))).toBe(false);
    expect(users.find((a) => a.action === 'uploadDocuments' && a.entity_id === pid)).toMatchObject({ actor_type: 'USER', user_name: 'Иванов Иван (инспектор)' });
  });
  it('импорт: манифест организаторов, .zip распаковывается, архивы и DWG — карточкой без анализа', async () => {
    const dir = path.join(importRoot, 'Объект с архивом');
    for (const d of ['Проектная документация', 'Рабочая документация', 'Исполнительная документация']) mkdirSync(path.join(dir, d), { recursive: true });
    const ar = await makePdf(1, 'zip-ar');
    const act = await makePdf(1, 'zip-act');
    const dwgInZip = Buffer.from('AC1032 схема');
    const zip = Buffer.from(zipSync({ 'Акт 1.pdf': new Uint8Array(act), 'схемы/схема.dwg': new Uint8Array(dwgInZip) }));
    const dwg = Buffer.from('AC1032 план');
    writeFileSync(path.join(dir, 'Проектная документация', 'АР.pdf'), ar);
    writeFileSync(path.join(dir, 'Исполнительная документация', 'акты.zip'), zip);
    writeFileSync(path.join(dir, 'Рабочая документация', 'план.dwg'), dwg);
    const line = (file_id: string, stage: string, relative_path: string, content: Buffer) =>
      JSON.stringify({ file_id, object_id: 'OBJ-ZIP', stage, relative_path, sha256: sha(content) });
    writeFileSync(
      path.join(dir, 'document_manifest.jsonl'),
      [
        line('F1', 'PD', 'Проектная документация/АР.pdf', ar),
        line('F2', 'ID', 'Исполнительная документация/акты.zip', zip),
        line('F3', 'ID', 'Исполнительная документация/акты.zip/Акт 1.pdf', act),
        line('F4', 'ID', 'Исполнительная документация/акты.zip/схемы/схема.dwg', dwgInZip),
        line('F5', 'RD', 'Рабочая документация/план.dwg', dwg),
      ].join('\n'),
    );

    const r = await req('POST', '/api/v1/documents/import', { path: 'Объект с архивом', object_name: 'Импорт с архивом' });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.files.every((f: Json) => f.status !== 'REJECTED')).toBe(true);
    await waitDone(r.body.process_id);
    const files = await filesOf(r.body.process_id);
    const byId = new Map(files.map((f) => [f.external_file_id, f]));
    expect([...byId.keys()].sort()).toEqual(['F1', 'F2', 'F3', 'F4', 'F5']);
    expect(byId.get('F3')).toMatchObject({ original_name: 'Акт 1.pdf', doc_stage: 'ID', format: 'PDF', processing_status: 'PARSED' });
    for (const id of ['F2', 'F4', 'F5']) expect(byId.get(id)).toMatchObject({ format: 'OTHER', processing_status: 'SKIPPED' });

    const proc = (await req('GET', `/api/v1/processes/${r.body.process_id}`)).body;
    expect(proc.completeness).toMatchObject({ status: 'COMPLETE', registry_file_name: 'document_manifest.jsonl' });
    expect(proc.completeness.issues.map((i: Json) => i.code)).toEqual(['FORMAT_CARD_ONLY', 'FORMAT_CARD_ONLY', 'FORMAT_CARD_ONLY']);
  });

  // Комплект через интерфейс целиком — архивом или папкой, а не по файлу
  it('загрузка архива комплекта: содержимое по папкам стадий, реестр из архива, сам архив не входит', async () => {
    const pz = await makePdf(1, 'zip-upload-pz');
    const kzh = await makePdf(1, 'zip-upload-kzh');
    const registry = 'file_id,file_name,doc_stage,approval_status\nUZ-1,ПЗ из архива.pdf,PD,APPROVED\nUZ-2,КЖ из архива.pdf,RD,FOR_CONSTRUCTION\n';
    const zip = Buffer.from(
      zipSync({
        'Комплект/registry.csv': strToU8(registry),
        'Комплект/Проектная документация/ПЗ из архива.pdf': new Uint8Array(pz),
        'Комплект/Рабочая документация/КЖ из архива.pdf': new Uint8Array(kzh),
        'Комплект/Рабочая документация/узел.dwg': strToU8('AC1032 узел'),
      }),
    );
    const object = (await req('POST', '/api/v1/objects', { name: 'Комплект архивом' })).body.id;
    const r = await send('/api/v1/documents/upload', [
      { name: 'object_id', value: object },
      { name: 'files', filename: 'Комплект.zip', content: zip, contentType: 'application/zip' },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.files.map((f: Json) => f.original_name).sort()).toEqual(['КЖ из архива.pdf', 'ПЗ из архива.pdf', 'узел.dwg']);
    await waitDone(r.body.process_id);

    const byName = new Map((await filesOf(r.body.process_id)).map((f) => [f.original_name, f]));
    expect(byName.get('ПЗ из архива.pdf')).toMatchObject({ external_file_id: 'UZ-1', doc_stage: 'PD', format: 'PDF' });
    expect(byName.get('КЖ из архива.pdf')).toMatchObject({ external_file_id: 'UZ-2', doc_stage: 'RD', format: 'PDF' });
    expect(byName.get('узел.dwg')).toMatchObject({ format: 'OTHER', processing_status: 'SKIPPED' });
    const proc = (await req('GET', `/api/v1/processes/${r.body.process_id}`)).body;
    expect(proc.completeness).toMatchObject({ registry: 'PRESENT', registry_file_name: 'registry.csv' });
  });

  it('загрузка папки: путь в имени файла даёт стадию, реестр из корня папки документом не считается', async () => {
    const object = (await req('POST', '/api/v1/objects', { name: 'Комплект папкой' })).body.id;
    const registry = 'file_id,file_name,doc_stage\nUD-1,ПЗ из папки.pdf,PD\nUD-2,АР из папки.pdf,RD\n';
    const r = await send('/api/v1/documents/upload', [
      { name: 'object_id', value: object },
      { name: 'files', filename: 'Комплект/registry.csv', content: Buffer.from(registry), contentType: 'text/csv' },
      { name: 'files', filename: 'Комплект/Проектная документация/ПЗ из папки.pdf', content: await makePdf(1, 'dir-pz') },
      { name: 'files', filename: 'Комплект/Рабочая документация/АР из папки.pdf', content: await makePdf(1, 'dir-ar') },
      // вне реестра: стадию даёт только папка
      { name: 'files', filename: 'Комплект/Исполнительная документация/без стадии в имени.pdf', content: await makePdf(1, 'dir-act') },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.files.map((f: Json) => f.original_name)).toEqual(['ПЗ из папки.pdf', 'АР из папки.pdf', 'без стадии в имени.pdf']);
    await waitDone(r.body.process_id);

    const byName = new Map((await filesOf(r.body.process_id)).map((f) => [f.original_name, f]));
    expect(byName.get('ПЗ из папки.pdf')).toMatchObject({ external_file_id: 'UD-1', doc_stage: 'PD' });
    expect(byName.get('без стадии в имени.pdf')).toMatchObject({ doc_stage: 'ID', in_registry: false });
    const proc = (await req('GET', `/api/v1/processes/${r.body.process_id}`)).body;
    expect(proc.completeness).toMatchObject({ registry: 'PRESENT', registry_file_name: 'registry.csv' });
  });

  it('архив, который не распаковывается, отклоняется с причиной', async () => {
    const object = (await req('POST', '/api/v1/objects', { name: 'Битый архив' })).body.id;
    const r = await send('/api/v1/documents/upload', [
      { name: 'object_id', value: object },
      { name: 'files', filename: 'комплект.zip', content: Buffer.from('это не zip'), contentType: 'application/zip' },
    ]);
    expect(r.status).toBe(400);
    expect(r.body.details.files[0]).toMatchObject({ original_name: 'комплект.zip', status: 'REJECTED' });
    expect(r.body.details.files[0].error).toMatchObject({ code: 'CORRUPTED_FILE', message: expect.stringMatching(/^Архив не распакован/) });
  });
});
