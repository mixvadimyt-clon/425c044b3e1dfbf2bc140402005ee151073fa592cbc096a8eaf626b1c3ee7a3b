/**
 * Проверка синтаксиса логических правил при сохранении.
 *
 * Исполняет правила движок на Python (`services/ml/.../suspicion/rules/dsl.py`), и неверное правило
 * он молча пропускает: администратор сохранял опечатку и не узнавал, что правило не работает.
 * Здесь — та же грамматика, только разбор без вычисления, чтобы отказать сразу, с причиной.
 * Меняется язык там — меняется и здесь; общие примеры верных и неверных выражений —
 * `test/rules-dsl.test.ts` и `tests/.../test_dsl.py`.
 *
 *     выражение   := или
 *     или         := и ("or" и)*
 *     и           := не ("and" не)*
 *     не          := "not" не | сравнение
 *     сравнение   := значение (("==" | "!=" | ">" | ">=" | "<" | "<=") значение)?
 *     значение    := "(" выражение ")" | вызов | литерал | ссылка
 *     вызов       := ("exists" | "missing") "(" ссылка ")"
 *     ссылка      := КОД_ПАРАМЕТРА "." ("PD" | "RD" | "ID")
 *     литерал     := ЧИСЛО | СТРОКА | "true" | "false"
 */

export class RuleSyntaxError extends Error {}

const STAGES = new Set(['PD', 'RD', 'ID']);
const FUNCTIONS = new Set(['exists', 'missing']);
const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false', ...FUNCTIONS]);
const COMPARISONS = new Set(['==', '!=', '>', '>=', '<', '<=']);

const TOKEN =
  /\s*(?:(==|!=|>=|<=|>|<)|([()])|(\d+(?:[.,]\d+)?)|("[^"]*"|'[^']*')|([A-Za-zА-Яа-яЁё_](?:[A-Za-z0-9А-Яа-яЁё_.-]*[A-Za-z0-9А-Яа-яЁё_])?))/y;

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    TOKEN.lastIndex = pos;
    const match = TOKEN.exec(text);
    if (!match) {
      if (text.slice(pos).trim() === '') break;
      const at = pos + (text.slice(pos).length - text.slice(pos).trimStart().length);
      throw new RuleSyntaxError(`непонятный символ в позиции ${at}: «${text[at]}»`);
    }
    tokens.push(match[0].trim());
    pos = TOKEN.lastIndex;
  }
  return tokens;
}

/** Ссылки на параметры в выражении («M-002.PD»), если разбор прошёл. */
export function parseRule(text: string): Set<string> {
  if (!(text ?? '').trim()) throw new RuleSyntaxError('пустое выражение');
  const tokens = tokenize(text);
  const refs = new Set<string>();
  let pos = 0;
  const peek = (): string | undefined => tokens[pos];
  const take = (): string => {
    const token = tokens[pos];
    if (token === undefined) throw new RuleSyntaxError('выражение оборвалось');
    pos += 1;
    return token;
  };
  const expect = (token: string): void => {
    if (peek() !== token) throw new RuleSyntaxError(`ожидалось «${token}», а получено «${peek() ?? 'конец'}»`);
    pos += 1;
  };
  const reference = (token: string): void => {
    const dot = token.lastIndexOf('.');
    const stage = dot < 0 ? '' : token.slice(dot + 1).toUpperCase();
    if (dot < 0 || !STAGES.has(stage)) {
      throw new RuleSyntaxError(`ссылка «${token}» должна быть вида «M-002.PD» (стадия PD, RD или ID)`);
    }
    refs.add(`${token.slice(0, dot).toUpperCase()}.${stage}`);
  };
  const value = (): void => {
    const token = take();
    if (token === '(') {
      expression();
      expect(')');
      return;
    }
    if (token[0] === '"' || token[0] === "'" || /^\d/.test(token)) return;
    const lowered = token.toLowerCase();
    if (lowered === 'true' || lowered === 'false') return;
    if (FUNCTIONS.has(lowered)) {
      expect('(');
      reference(take());
      expect(')');
      return;
    }
    if (KEYWORDS.has(lowered)) throw new RuleSyntaxError(`«${token}» не может быть значением`);
    reference(token);
  };
  const comparison = (): void => {
    value();
    if (COMPARISONS.has(peek() ?? '')) {
      take();
      value();
    }
  };
  const negation = (): void => {
    if ((peek() ?? '').toLowerCase() === 'not') {
      take();
      negation();
      return;
    }
    comparison();
  };
  const boolean = (word: string, nested: () => void): void => {
    nested();
    while ((peek() ?? '').toLowerCase() === word) {
      take();
      nested();
    }
  };
  const expression = (): void => boolean('or', () => boolean('and', negation));

  expression();
  if (pos < tokens.length) throw new RuleSyntaxError(`лишнее в конце выражения: «${tokens.slice(pos).join(' ')}»`);
  return refs;
}
