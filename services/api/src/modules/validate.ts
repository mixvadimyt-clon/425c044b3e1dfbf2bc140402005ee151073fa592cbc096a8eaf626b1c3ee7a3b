import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { badRequest } from '../errors.js';

/**
 * OpenAPI 3.0 `nullable: true` → JSON Schema `anyOf: [null, схема]`. Ajv понимает `nullable` только рядом с `type`
 * своего узла: `{ nullable: true, allOf: [{ $ref: JobError }] }` отвергает null (вложенная схема требует объект),
 * а `nullable` с `enum` без null — тоже. Так ml, честно присылающий `"error": null`, получал 400.
 */
export function nullableToAnyOf(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(nullableToAnyOf);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) out[key] = nullableToAnyOf(value);
  if (out.nullable !== true) return out;
  const { nullable: _nullable, ...schema } = out;
  return { anyOf: [{ type: 'null' }, schema] };
}

const isNullable = (schema: unknown) =>
  Boolean(schema && typeof schema === 'object' && (schema as { anyOf?: unknown[] }).anyOf?.some((s) => (s as { type?: string })?.type === 'null'));

/**
 * Сообщения ml: необязательное поле со значением null равносильно отсутствию — так pydantic сериализует
 * `X | None = None` (модели ml сгенерированы из того же контракта). Обязательные поля остаются строгими.
 */
export function optionalAcceptsNull(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(optionalAcceptsNull);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) out[key] = optionalAcceptsNull(value);
  const props = out.properties as Record<string, unknown> | undefined;
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    const required = new Set((out.required as string[] | undefined) ?? []);
    out.properties = Object.fromEntries(
      Object.entries(props).map(([key, schema]) => [key, required.has(key) || isNullable(schema) ? schema : { anyOf: [{ type: 'null' }, schema] }]),
    );
  }
  return out;
}

/** Валидация произвольных фрагментов по схемам контракта (для данных вне тела запроса: multipart-поля, файлы, сообщения ml). */
export class ContractValidator {
  private readonly ajv = new Ajv({ strict: false, allErrors: false });
  private readonly cache = new Map<string, ValidateFunction>();

  constructor(contractsDir: string) {
    addFormats.default(this.ajv);
    const load = (file: string) => nullableToAnyOf(JSON.parse(readFileSync(path.join(contractsDir, file), 'utf8'))) as object;
    this.ajv.addSchema(load('inspector-api.v1.json'), 'api');
    this.ajv.addSchema(optionalAcceptsNull(load('ml-events.v1.json')) as object, 'events');
  }

  schema(doc: 'api' | 'events', name: string): ValidateFunction {
    const key = `${doc}#/components/schemas/${name}`;
    let fn = this.cache.get(key);
    if (!fn) {
      fn = this.ajv.getSchema(key);
      if (!fn) throw new Error(`Схема не найдена: ${key}`);
      this.cache.set(key, fn);
    }
    return fn;
  }

  /** Проверить и вернуть значение или бросить 400 с перечнем ошибок. */
  assert<T>(doc: 'api' | 'events', name: string, value: unknown, what: string): T {
    const fn = this.schema(doc, name);
    if (!fn(value)) throw badRequest(`${what} не соответствует контракту`, { errors: fn.errors }, 'VALIDATION_ERROR');
    return value as T;
  }
}
