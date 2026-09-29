/**
 * Язык логических правил в api: правило проверяется при сохранении.
 * Примеры те же, что у движка (`services/ml/tests/.../test_dsl.py`), — разбор в api и в ML не должен расходиться.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RuleSyntaxError, parseRule } from '../src/modules/rules-dsl.js';
import { login, makeTestApp } from './helpers.js';

describe('разбор языка правил', () => {
  it('правила из задачи разбираются, ссылки собираются', () => {
    expect([...parseRule('exists(M-055.PD)')]).toEqual(['M-055.PD']);
    expect([...parseRule('exists(M-002.PD) and exists(M-002.RD)')]).toEqual(['M-002.PD', 'M-002.RD']);
    expect([...parseRule('M-002.RD == M-002.PD')]).toEqual(['M-002.RD', 'M-002.PD']);
    expect([...parseRule('not (exists(M-055.PD) or M-002.RD > 10)')].sort()).toEqual(['M-002.RD', 'M-055.PD']);
    expect([...parseRule("M-055.RD != 'B25' AND missing(m-055.id)")]).toEqual(['M-055.RD', 'M-055.ID']);
    expect(parseRule('M-002.PD >= 12,5').size).toBe(1);
  });

  it.each([
    '',
    '   ',
    'M-002.PD ==',
    'M-002.PD + 1',
    'exists(M-002)',
    'exists(M-002.ПД)',
    'and',
    '(M-002.PD == 1',
    'M-002.PD == 1)',
    "__import__('os').system('rm -rf /')",
    'M-002.PD == 1; drop table checks',
    'floors > 10',
  ])('неверное выражение «%s» — ошибка разбора', (text) => {
    expect(() => parseRule(text)).toThrow(RuleSyntaxError);
  });
});

describe('логические правила через API', () => {
  let t: Awaited<ReturnType<typeof makeTestApp>>;
  let admin: Record<string, string>;
  const rule = (condition: string, expected: string) => ({ rule_name: `Правило ${condition}`, condition, expected });

  beforeAll(async () => {
    t = await makeTestApp();
    admin = await login(t.app, 'admin');
  });
  afterAll(() => t.cleanup());

  it('верное правило сохраняется, неверное — 400 с причиной', async () => {
    const ok = await t.app.inject({ method: 'POST', url: '/api/v1/admin/logical-rules', headers: admin, payload: rule('exists(M-055.PD)', 'exists(M-055.RD)') });
    expect(ok.statusCode, ok.body).toBe(201);

    const broken = await t.app.inject({ method: 'POST', url: '/api/v1/admin/logical-rules', headers: admin, payload: rule('exists(M-055.PD)', 'M-055.RD ==') });
    expect(broken.statusCode).toBe(400);
    expect(broken.json()).toMatchObject({ code: 'RULE_INVALID', message: 'expected: выражение оборвалось' });

    const put = await t.app.inject({ method: 'PUT', url: `/api/v1/admin/logical-rules/${ok.json().id}`, headers: admin, payload: rule('floors > 10', 'exists(M-055.RD)') });
    expect(put.statusCode).toBe(400);
    expect(put.json().message).toMatch(/^condition: ссылка «floors» должна быть вида/);
  });

  it('неизвестный код параметра — отказ: такое правило никогда не сработает', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/admin/logical-rules', headers: admin, payload: rule('exists(M-999.PD)', 'exists(M-055.RD)') });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'RULE_INVALID', message: 'condition: параметров нет в матрице: M-999' });
  });
});
