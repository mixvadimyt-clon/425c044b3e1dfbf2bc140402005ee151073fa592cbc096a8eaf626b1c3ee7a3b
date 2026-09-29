import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config.js';
import { ContractValidator, nullableToAnyOf } from '../src/modules/validate.js';

const validator = new ContractValidator(path.join(REPO_ROOT, 'contracts/dist'));

describe('проверка сообщений ml по контракту', () => {
  it('nullable рядом с allOf, $ref и enum допускает null', () => {
    expect(nullableToAnyOf({ type: 'object', nullable: true, allOf: [{ $ref: '#/x' }] })).toEqual({
      anyOf: [{ type: 'null' }, { type: 'object', allOf: [{ $ref: '#/x' }] }],
    });
    expect(nullableToAnyOf({ properties: { nullable: { type: 'string' } } })).toEqual({ properties: { nullable: { type: 'string' } } });
  });

  it('успешный ParseResult с "error": null принимается (так его сериализует pydantic в ml)', () => {
    const parse = validator.schema('events', 'ParseResult');
    const ok = {
      file_id: '0b6e7f52-1d8e-4a8b-9d55-3a2f1f0c9e10',
      process_id: '6f1c1c9e-6c38-4d7e-9c1a-2f0f4b0b7a01',
      sha256: 'a'.repeat(64),
      status: 'OK',
      error: null,
    };
    expect(parse(ok), JSON.stringify(parse.errors)).toBe(true);
    // но ошибка, если она есть, должна быть объектом по контракту
    expect(parse({ ...ok, status: 'FAILED', error: 'сломалось' })).toBe(false);
  });

  it('необязательные поля со значением null — как отсутствующие; обязательные остаются строгими', () => {
    const parse = validator.schema('events', 'ParseResult');
    const base = { file_id: '0b6e7f52-1d8e-4a8b-9d55-3a2f1f0c9e10', process_id: '6f1c1c9e-6c38-4d7e-9c1a-2f0f4b0b7a01', sha256: 'a'.repeat(64), status: 'OK' };
    const withNulls = { ...base, metadata: { doc_stage: 'PD', requisites: null, stamps: null, sheets: null }, quality: null, duration_ms: null };
    expect(parse(withNulls), JSON.stringify(parse.errors)).toBe(true);
    expect(parse({ ...base, status: null })).toBe(false);
  });
});
