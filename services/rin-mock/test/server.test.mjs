import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PACKAGE_META, createRinMock } from '../src/server.mjs';

const TOKEN = 'test-token';
const SECRET = 'test-secret';
const sha = (b) => createHash('sha256').update(b).digest('hex');

describe('мок внешней ИС', () => {
  let dir;
  let mock;
  let base;
  const auth = { authorization: `Bearer ${TOKEN}` };
  const pdf = Buffer.from('%PDF-1.4 КР');

  const result = (over = {}) => ({
    process_id: '0b6e7f52-1d8e-4a8b-9d55-3a2f1f0c9e10',
    protocol_version: 1,
    versions: { matrix_version: 'm-0.1' },
    confirmed_violations: [{ id: 'f1', param_code: 'M-055' }],
    input_files: [],
    finalized_at: '2026-09-19T10:00:00Z',
    ...over,
  });
  const post = (body, headers = {}) => {
    const raw = JSON.stringify(body);
    return fetch(`${base}/api/v1/results`, {
      method: 'POST',
      headers: {
        ...auth,
        'content-type': 'application/json',
        'x-signature': createHmac('sha256', SECRET).update(raw).digest('hex'),
        ...headers,
      },
      body: raw,
    });
  };

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'rin-mock-'));
    const pkg = path.join(dir, 'packages', 'PKG-1');
    mkdirSync(path.join(pkg, 'ПД'), { recursive: true });
    writeFileSync(path.join(pkg, 'ПД', '4. П-2025-04-266-КР.pdf'), pdf);
    writeFileSync(path.join(pkg, 'registry.csv'), 'file_name;doc_stage\n4. П-2025-04-266-КР.pdf;PD\n');
    writeFileSync(path.join(pkg, PACKAGE_META), JSON.stringify({ created_at: '2026-09-19T08:00:00Z', object: { object_id: 'ALT79B', name: 'ЖК «Алтуфьевское ш., 79Б»' } }));
    mock = createRinMock({ packagesDir: path.join(dir, 'packages'), resultsDir: path.join(dir, 'results'), token: TOKEN, secret: SECRET });
    base = await mock.listen();
  });
  after(async () => {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('health без токена, API — только с токеном', async () => {
    assert.equal((await (await fetch(`${base}/health`)).json()).status, 'ok');
    assert.equal((await fetch(`${base}/api/v1/packages`)).status, 401);
  });

  it('пакет: объект из package.meta.json, реестр отдельно, файлы с путём и sha256', async () => {
    const { items } = await (await fetch(`${base}/api/v1/packages`, { headers: auth })).json();
    assert.equal(items.length, 1);
    const [p] = items;
    assert.equal(p.package_id, 'PKG-1');
    assert.deepEqual(p.object, { object_id: 'ALT79B', name: 'ЖК «Алтуфьевское ш., 79Б»', address: null, customer: null, contractor: null, permit_number: null });
    assert.equal(p.registry.name, 'registry.csv');
    assert.equal(p.registry.url, '/api/v1/packages/PKG-1/files/registry');
    assert.deepEqual(p.files, [{ name: '4. П-2025-04-266-КР.pdf', rel_path: 'ПД/4. П-2025-04-266-КР.pdf', size_bytes: pdf.length, sha256: sha(pdf), url: '/api/v1/packages/PKG-1/files/0' }]);
    const file = await fetch(`${base}${p.files[0].url}`, { headers: auth });
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), pdf);
    const later = await (await fetch(`${base}/api/v1/packages?since=2026-09-19T09:00:00Z`, { headers: auth })).json();
    assert.equal(later.items.length, 0);
  });

  it('результат: квитанция и предписание, повтор по ключу — та же квитанция', async () => {
    const first = await post(result(), { 'x-idempotency-key': 'p1:v1' });
    assert.equal(first.status, 201);
    const receipt = await first.json();
    assert.match(receipt.receipt_id, /^RIN-\d{4}-00001$/);
    assert.equal(receipt.prescription.status, 'ISSUED');
    assert.equal(receipt.duplicate, false);
    const again = await post(result(), { 'x-idempotency-key': 'p1:v1' });
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { ...receipt, duplicate: true });
    const clean = await (await post(result({ confirmed_violations: [] }), { 'x-idempotency-key': 'p2:v1' })).json();
    assert.equal(clean.prescription, null);
    assert.equal(readdirSync(path.join(dir, 'results')).length, 2);
  });

  it('подпись, ключ идемпотентности и форма результата проверяются', async () => {
    const bad = await post(result(), { 'x-idempotency-key': 'k', 'x-signature': '00'.repeat(32) });
    assert.equal((await bad.json()).code, 'BAD_SIGNATURE');
    assert.equal((await (await post(result(), {})).json()).code, 'NO_IDEMPOTENCY_KEY');
    const partial = await post({ process_id: 'x' }, { 'x-idempotency-key': 'k2' });
    assert.equal(partial.status, 400);
    assert.equal((await partial.json()).code, 'BAD_RESULT');
  });

  it('сбои по команде: 503, отказ, таймаут, искажённый файл', async () => {
    const ctl = await fetch(`${base}/__control/failures`, { method: 'POST', body: JSON.stringify({ mode: 'error', count: 1 }) });
    assert.deepEqual((await ctl.json()).failures, ['error']);
    assert.equal((await post(result(), { 'x-idempotency-key': 'e1' })).status, 503);
    assert.equal((await post(result(), { 'x-idempotency-key': 'e1' })).status, 201);

    mock.state.failNext('reject');
    assert.equal((await post(result(), { 'x-idempotency-key': 'e2' })).status, 400);

    mock.state.failNext('timeout');
    await assert.rejects(
      fetch(`${base}/api/v1/results`, { method: 'POST', headers: { ...auth, 'x-idempotency-key': 'e3' }, body: '{}', signal: AbortSignal.timeout(150) }),
      (err) => err.name === 'TimeoutError' || err.name === 'AbortError',
    );

    mock.state.reset();
    mock.state.failNext('corrupt');
    const { items } = await (await fetch(`${base}/api/v1/packages`, { headers: auth })).json();
    const corrupted = Buffer.from(await (await fetch(`${base}${items[0].files[0].url}`, { headers: auth })).arrayBuffer());
    assert.notEqual(sha(corrupted), items[0].files[0].sha256);
  });
});
