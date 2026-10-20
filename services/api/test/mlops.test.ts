import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SPLITS, assignSplit, canonicalJson } from '../src/modules/mlops/dataset.js';
import { isoWeekOf, weekBounds } from '../src/modules/mlops/weekly.js';
import { login, makePdf, makeTestApp, multipart, waitFor } from './helpers.js';

type Json = Record<string, any>;

const KR = '4. П-2025-04-266-КР(27.04.26).pdf';
const KJ = 'П-2025-04-266-КЖ01 11.11.2025.pdf';
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const GOOD = {
  precision: 0.93,
  recall: 0.85,
  f1: 0.89,
  false_positive_rate: 0.06,
  sample_size: 120,
  per_category: { КР: { recall: 0.85, false_positive_rate: 0.05 }, АР: { recall: 0.9, false_positive_rate: 0.04 } },
};

describe('ML-контур: версии GOLD-набора, реестр моделей, недельный отчёт', () => {
  let t: Awaited<ReturnType<typeof makeTestApp>>;
  const h: Record<string, Record<string, string>> = {};
  const items: Record<string, Json> = {};
  let ds1Export = '';
  let ds1: Json;

  const call = async (method: 'GET' | 'POST', url: string, payload?: unknown, who = 'ml') => {
    const res = await t.app.inject({ method, url, headers: h[who], payload: payload as Json });
    const json = (res.headers['content-type'] ?? '').includes('json') && !(res.headers['content-type'] ?? '').includes('ndjson');
    return { status: res.statusCode, body: (json && res.body ? res.json() : {}) as Json, text: res.body, headers: res.headers };
  };

  /** Объект с КР и КЖ: заглушка ML даёт одного кандидата M-055; решение инспектора → черновик GOLD. */
  const decided = async (name: string, tag: string, decision: Json) => {
    const obj = await call('POST', '/api/v1/objects', { name }, 'inspector');
    const mp = multipart([
      { name: 'object_id', value: obj.body.id },
      { name: 'files', filename: KR, content: await makePdf(3, `KR-${tag}`) },
      { name: 'files', filename: KJ, content: await makePdf(2, `KJ-${tag}`) },
    ]);
    const up = await t.app.inject({ method: 'POST', url: '/api/v1/documents/upload', headers: { ...h.inspector, ...mp.headers }, payload: mp.payload });
    const pid = up.json().process_id;
    const st = await waitFor(
      () => call('GET', `/api/v1/processes/${pid}/status`, undefined, 'inspector'),
      (r) => r.body.status === 'READY',
    );
    const { body } = await call('GET', `/api/v1/protocols/${st.body.current_protocol_id}/findings?finding_status=CANDIDATE`, undefined, 'inspector');
    const [f] = body.items as Json[];
    expect((await call('POST', `/api/v1/findings/${f.id}/decision`, decision, 'inspector')).status).toBe(200);
    const list = (await call('GET', '/api/v1/ml/dataset-items?page_size=200')).body.items as Json[];
    return list.find((i) => i.finding_id === f.id)!;
  };

  beforeAll(async () => {
    t = await makeTestApp();
    for (const who of ['inspector', 'supervisor', 'admin', 'ml']) h[who] = await login(t.app, who);
    items.a = await decided('ЖК Альфа', 'a', { action: 'CONFIRM', comment: 'Класс бетона понижен' });
    items.b = await decided('ЖК Бета', 'b', { action: 'REJECT', reason_code: 'NO_DISCREPANCY', comment: 'Класс тот же, опечатка в КЖ' });
    items.c = await decided('ЖК Гамма', 'c', { action: 'REJECT', reason_code: 'NO_DISCREPANCY', comment: 'Совпадает' });
  });
  afterAll(async () => t.cleanup());

  it('решения инспектора дают черновики GOLD с меткой и объектом', () => {
    expect([items.a.gold_label, items.b.gold_label, items.c.gold_label]).toEqual(['POSITIVE', 'NEGATIVE', 'NEGATIVE']);
    expect(items.a.curation_status).toBe('DRAFT');
  });

  it('выпуск: только одобренные с полным доказательством, разбиение по объекту, хеши сходятся с выгрузкой', async () => {
    for (const k of ['a', 'b', 'c']) expect((await call('POST', `/api/v1/ml/dataset-items/${items[k].id}/curate`, { curation_status: 'APPROVED' })).status).toBe(200);
    // метка расходится с решением инспектора — запись не выпускается (REQ-ML-08)
    t.ctx.db.update('dataset_items', { gold_label: 'POSITIVE' }, 'id = ?', items.c.id);

    const r = await call('POST', '/api/v1/ml/dataset-versions', { version: 'ds-2026.09.1', comment: 'первый выпуск' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    ds1 = r.body;
    expect(ds1).toMatchObject({ version: 'ds-2026.09.1', items_count: 2, positives: 1, negatives: 1, new_items: 2, comment: 'первый выпуск' });
    expect(ds1.excluded).toEqual([{ item_id: items.c.id, param_code: 'M-055', reason: 'Метка POSITIVE расходится с текущим статусом проверки NEGATIVE_VERIFIED' }]);
    expect(Object.keys(ds1.split_hashes).sort()).toEqual(['HIDDEN_TEST', 'TRAIN', 'VALIDATION']);
    expect(Object.values(ds1.split_counts as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(2);

    const exp = await call('GET', '/api/v1/ml/dataset-versions/ds-2026.09.1/export');
    expect(exp.status).toBe(200);
    expect(exp.headers['content-type']).toContain('application/x-ndjson');
    ds1Export = exp.text;
    const lines = ds1Export.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    // проверка хешей — без пересериализации: строки части как есть
    for (const split of ['TRAIN', 'VALIDATION', 'HIDDEN_TEST']) {
      const part = lines.filter((l) => JSON.parse(l).split === split).map((l) => `${l}\n`).join('');
      expect(sha(part), split).toBe(ds1.split_hashes[split]);
    }
    const rec = JSON.parse(lines[0]);
    expect(rec).toMatchObject({ released_in: 'ds-2026.09.1', param_code: 'M-055' });
    expect(rec.record).toMatchObject({ dataset_version: 'ds-2026.09.1', split: rec.split, completeness_status: 'COMPLETE' });
    expect(rec.record.source_expected[0].bbox_polygon).toHaveLength(4);
    expect(lines[0]).toBe(canonicalJson(rec)); // строка — канонический JSON

    const only = await call('GET', `/api/v1/ml/dataset-versions/ds-2026.09.1/export?split=${rec.split}`);
    expect(only.text.split('\n').filter(Boolean).every((l) => JSON.parse(l).split === rec.split)).toBe(true);
    expect((await call('GET', '/api/v1/ml/dataset-versions/нет/export')).status).toBe(404);
  });

  it('версии неизменны: повтор имени, пустой выпуск, курирование выпущенной записи — отказ', async () => {
    expect((await call('POST', '/api/v1/ml/dataset-versions', { version: 'ds-2026.09.1' })).body.code).toBe('VERSION_EXISTS');
    const empty = await call('POST', '/api/v1/ml/dataset-versions', { version: 'ds-2026.09.2' });
    expect([empty.status, empty.body.code]).toEqual([409, 'NOTHING_TO_RELEASE']);
    expect(empty.body.details.excluded).toHaveLength(1);
    const cur = await call('POST', `/api/v1/ml/dataset-items/${items.a.id}/curate`, { curation_status: 'EXCLUDED' });
    expect([cur.status, cur.body.code]).toEqual([409, 'ITEM_RELEASED']);
    expect((await call('POST', '/api/v1/ml/dataset-versions', { version: 'ds 1' })).status).toBe(400);
    expect((await call('POST', '/api/v1/ml/dataset-versions', { version: 'ds-x' }, 'inspector')).status).toBe(403);
  });

  it('следующая версия накопительная, часть объекта сохраняется, прежняя выгрузка байт в байт та же', async () => {
    t.ctx.db.update('dataset_items', { gold_label: 'NEGATIVE' }, 'id = ?', items.c.id);
    const r = await call('POST', '/api/v1/ml/dataset-versions', { version: 'ds-2026.09.2', split_ratio: { train: 1, validation: 0, test: 0 } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ items_count: 3, positives: 1, negatives: 2, new_items: 1, excluded: [] });
    // новый объект при доле train = 1 — в TRAIN; прежние объекты остались в своих частях
    const byObject = (v: Json) => Object.fromEntries(Object.entries(v.objects_by_split as Record<string, string[]>).flatMap(([s, objs]) => objs.map((o) => [o, s])));
    const before = byObject(ds1);
    const after = byObject(r.body);
    for (const [obj, split] of Object.entries(before)) expect(after[obj]).toBe(split);
    expect(after[items.c.object_group_id]).toBe('TRAIN');
    expect((await call('GET', '/api/v1/ml/dataset-versions/ds-2026.09.1/export')).text).toBe(ds1Export);
    const list = (await call('GET', '/api/v1/ml/dataset-versions', undefined, 'supervisor')).body as unknown as Json[];
    expect(list.map((v) => v.version)).toEqual(['ds-2026.09.2', 'ds-2026.09.1']);
  });

  it('модели: регистрация сверяет хеши набора и считает пороги §14 и регрессию', async () => {
    const reg = (body: Json) => call('POST', '/api/v1/ml/models', { artifact_hash: 'a'.repeat(64), dataset_version: 'ds-2026.09.1', split_hashes: ds1.split_hashes, ...body });
    expect((await reg({ model_version: 'x', split_hashes: { ...ds1.split_hashes, TRAIN: '0'.repeat(64) }, metrics: GOOD })).body.code).toBe('DATASET_HASH_MISMATCH');
    expect((await reg({ model_version: 'x', dataset_version: 'ds-нет', metrics: GOOD })).body.code).toBe('DATASET_UNKNOWN');
    expect((await reg({ model_version: 'x', artifact_hash: 'не-хеш', metrics: GOOD })).status).toBe(400);

    const m1 = await reg({ model_version: 'scorer-1', metrics: GOOD, training_params: { C: 1.0 }, code_version: 'abc123' });
    expect(m1.status, JSON.stringify(m1.body)).toBe(201);
    expect(m1.body).toMatchObject({ approval_status: 'PENDING', thresholds_passed: true, is_current: false, code_version: 'abc123' });
    expect(m1.body.threshold_checks.map((c: Json) => c.message)).toContain('Precision 0.93 ≥ 0.9');

    const weak = await reg({ model_version: 'scorer-weak', metrics: { ...GOOD, recall: 0.7 } });
    expect(weak.body.thresholds_passed).toBe(false);
    const denied = await call('POST', '/api/v1/ml/models/scorer-weak/decision', { action: 'APPROVE', comment: 'пробуем' });
    expect([denied.status, denied.body.code]).toEqual([409, 'THRESHOLDS_FAILED']);
    expect(denied.body.details.failed).toEqual(['Recall 0.7, а нужно ≥ 0.8']);
    // без измерения обязательной метрики — не проходит
    const partial = await reg({ model_version: 'scorer-partial', metrics: { precision: 0.95, recall: 0.9, f1: 0.92 } });
    expect(partial.body.threshold_checks.find((c: Json) => !c.passed).message).toBe('FPR: не измерен');
  });

  it('одобрение, регрессия против текущей модели, откат и отказ — с журналом', async () => {
    expect((await call('POST', '/api/v1/ml/models/scorer-1/decision', { action: 'APPROVE', comment: ' ' })).body.code).toBe('COMMENT_REQUIRED');
    expect((await call('POST', '/api/v1/ml/models/scorer-1/decision', { action: 'APPROVE', comment: 'ок' }, 'inspector')).status).toBe(403);
    const ok = await call('POST', '/api/v1/ml/models/scorer-1/decision', { action: 'APPROVE', comment: 'Пороги пройдены' }, 'admin');
    expect(ok.body).toMatchObject({ approval_status: 'APPROVED', is_current: true, previous_model_version: null, comment: 'Пороги пройдены' });

    const reg = (model_version: string, metrics: Json) =>
      call('POST', '/api/v1/ml/models', { model_version, artifact_hash: 'b'.repeat(64), dataset_version: 'ds-2026.09.1', split_hashes: ds1.split_hashes, metrics });
    // Recall по КР упал на 5 п.п. — регрессия, хотя общие пороги пройдены
    const worse = await reg('scorer-2', { ...GOOD, per_category: { ...GOOD.per_category, КР: { recall: 0.8, false_positive_rate: 0.05 } } });
    expect(worse.body.thresholds_passed).toBe(false);
    expect(worse.body.threshold_checks.filter((c: Json) => !c.passed).map((c: Json) => c.message)).toEqual([
      'Recall по категории «КР» упал на 5.0 п.п. против текущей модели (0.85 → 0.8), допустимо 2.0 п.п.',
    ]);
    const better = await reg('scorer-3', { ...GOOD, recall: 0.86, per_category: { ...GOOD.per_category, КР: { recall: 0.86, false_positive_rate: 0.05 } } });
    expect(better.body.thresholds_passed).toBe(true);
    const approved = await call('POST', '/api/v1/ml/models/scorer-3/decision', { action: 'APPROVE', comment: 'Лучше по КР' });
    expect(approved.body).toMatchObject({ approval_status: 'APPROVED', is_current: true, previous_model_version: 'scorer-1' });

    expect((await call('POST', '/api/v1/ml/models/scorer-1/decision', { action: 'ROLLBACK', comment: 'x' })).body.code).toBe('INVALID_STATUS');
    const back = await call('POST', '/api/v1/ml/models/scorer-3/decision', { action: 'ROLLBACK', comment: 'Жалобы инспекторов на КР' });
    expect(back.body).toMatchObject({ approval_status: 'ROLLED_BACK', rollback_to: 'scorer-1', is_current: false });
    expect((await call('POST', '/api/v1/ml/models/scorer-2/decision', { action: 'REJECT', comment: 'Регрессия по КР' })).body.approval_status).toBe('REJECTED');
    expect((await call('POST', '/api/v1/ml/models/scorer-2/decision', { action: 'REJECT', comment: 'ещё раз' })).body.code).toBe('INVALID_STATUS');
    expect((await call('POST', '/api/v1/ml/models/нет/decision', { action: 'REJECT', comment: 'x' })).status).toBe(404);

    const models = (await call('GET', '/api/v1/ml/models', undefined, 'supervisor')).body as unknown as Json[];
    expect(models.filter((m) => m.is_current).map((m) => m.model_version)).toEqual(['scorer-1']);
    const log = t.ctx.db.all<{ model_version: string; action: string }>('SELECT model_version, action FROM ml_retraining_log ORDER BY rowid');
    expect(log.filter((l) => l.model_version === 'scorer-3').map((l) => l.action)).toEqual(['REGISTER', 'APPROVE', 'ROLLBACK']);

    // откат единственной модели — работаем без модели (только правила)
    const solo = await call('POST', '/api/v1/ml/models/scorer-1/decision', { action: 'ROLLBACK', comment: 'Проверка без скорера' });
    expect(solo.body).toMatchObject({ approval_status: 'ROLLED_BACK', rollback_to: null });
    expect(((await call('GET', '/api/v1/ml/models')).body as unknown as Json[]).some((m) => m.is_current)).toBe(false);
  });

  it('недельный отчёт: решения, причины, ложные срабатывания по параметру, рекомендации', async () => {
    const r = await call('GET', '/api/v1/ml/reports/weekly', undefined, 'supervisor');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      week: isoWeekOf(new Date()),
      decisions_total: 3,
      confirmed: 1,
      rejected: 2,
      clarifications: 0,
      rejections_by_reason: { NO_DISCREPANCY: 2 },
      rejections_by_section: { КР: 2 },
      top_false_positive_params: [{ param_code: 'M-055', rejections: 2, fp_rate: 0.667 }],
      gold_drafts: 0,
      gold_approved_unreleased: 0,
      current_model_version: null,
    });
    expect(r.body.recommendations[0]).toBe(
      'M-055: отклонено 2 из 3 кандидатов (67 %). Смотреть в первую очередь пороги триггеров и нормализацию значений: расхождения нет, а кандидат есть.',
    );
    const past = await call('GET', '/api/v1/ml/reports/weekly?week=2026-W01');
    expect(past.body).toMatchObject({ decisions_total: 0, period_start: '2025-12-28T21:00:00.000Z' });
    expect(past.body.recommendations).toContain('За неделю решений нет: данных для оценки и дообучения не прибавилось.');
    expect((await call('GET', '/api/v1/ml/reports/weekly?week=2025-W53')).body.code).toBe('BAD_WEEK');
    expect((await call('GET', '/api/v1/ml/reports/weekly?week=38')).status).toBe(400);
  });

  it('ISO-недели по московскому времени', () => {
    expect(isoWeekOf(new Date('2026-09-13T20:59:59Z'))).toBe('2026-W37'); // воскресенье 23:59 МСК
    expect(isoWeekOf(new Date('2026-09-13T21:00:00Z'))).toBe('2026-W38'); // понедельник 00:00 МСК
    expect(isoWeekOf(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
    expect(weekBounds('2026-W38')).toEqual({ start: new Date('2026-09-13T21:00:00Z'), end: new Date('2026-09-20T21:00:00Z') });
  });

  it('явная часть объекта (object_splits): поверх хеша, прежняя часть неизменна, чужой объект — отказ', async () => {
    items.d = await decided('ЖК Дельта', 'd', { action: 'CONFIRM', comment: 'Класс бетона понижен' });
    items.e = await decided('ЖК Эпсилон', 'e', { action: 'REJECT', reason_code: 'NO_DISCREPANCY', comment: 'Совпадает' });
    for (const k of ['d', 'e']) expect((await call('POST', `/api/v1/ml/dataset-items/${items[k].id}/curate`, { curation_status: 'APPROVED' })).status).toBe(200);
    const [d, e, a] = [items.d.object_group_id, items.e.object_group_id, items.a.object_group_id] as string[];
    const ratio = { train: 0.7, validation: 0.15, test: 0.15 };
    // часть, которую хеш объекту не дал бы, — иначе проверка ничего не доказывает
    const pinD = SPLITS.find((s) => s !== assignSplit(d, ratio))!;
    const pinE = SPLITS.find((s) => s !== assignSplit(e, ratio) && s !== pinD)!;
    const splitA = Object.entries(ds1.objects_by_split as Record<string, string[]>).find(([, objs]) => objs.includes(a))![0];

    const fixed = await call('POST', '/api/v1/ml/dataset-versions', { version: 'ds-2026.09.3', object_splits: { [d]: pinD, [a]: SPLITS.find((s) => s !== splitA) } });
    expect([fixed.status, fixed.body.code]).toEqual([409, 'SPLIT_FIXED']);
    expect(fixed.body.details.objects).toEqual([{ object_id: a, split: splitA, requested: SPLITS.find((s) => s !== splitA) }]);
    const stranger = '00000000-0000-4000-8000-000000000000';
    const unknown = await call('POST', '/api/v1/ml/dataset-versions', { version: 'ds-2026.09.3', object_splits: { [d]: pinD, [stranger]: 'TRAIN' } });
    expect([unknown.status, unknown.body.code, unknown.body.details.objects]).toEqual([400, 'UNKNOWN_OBJECT', [stranger]]);
    expect((await call('POST', '/api/v1/ml/dataset-versions', { version: 'ds-2026.09.3', object_splits: { [d]: 'TEST' } })).status).toBe(400);
    // отказы ничего не выпустили: записи не в версии, имя версии свободно
    expect(t.ctx.db.get('SELECT 1 FROM dataset_versions WHERE version = ?', 'ds-2026.09.3')).toBeUndefined();

    // та же часть у прежнего объекта — допустима
    const r = await call('POST', '/api/v1/ml/dataset-versions', { version: 'ds-2026.09.3', object_splits: { [d]: pinD, [e]: pinE, [a]: splitA } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ items_count: 5, new_items: 2 });
    expect(r.body.objects_by_split[pinD]).toContain(d);
    expect(r.body.objects_by_split[pinE]).toContain(e);
    expect(r.body.objects_by_split[splitA]).toContain(a);
  });
});
