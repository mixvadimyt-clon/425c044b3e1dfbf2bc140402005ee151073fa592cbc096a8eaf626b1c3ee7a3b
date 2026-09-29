/**
 * Ограничение неудачных попыток входа (до публичного стенда).
 *
 * Считаем неудачи в скользящем окне по двум ключам:
 * - **логин + адрес** — подбор пароля к одной учётной записи;
 * - **адрес** — перебор по многим учётным записям с одного адреса (password spraying).
 *
 * Почему не блокируем учётную запись целиком. Демо-учётки общие: `inspector` на стенде открывают
 * проверяющие и разработчики. Блокировка по одному логину отдала бы любому постороннему кнопку
 * «запереть проверяющих» — пять неверных паролей раз в 15 минут. Пара «логин + адрес» запирает только
 * того, кто подбирает, а честные входы с других адресов идут как шли.
 *
 * Адрес — `req.ip`: за Caddy его даёт `TRUST_PROXY=1` (последний адрес в X-Forwarded-For, который
 * дописал сам Caddy). Без доверия прокси все клиенты выглядели бы одним адресом Caddy, и лимит
 * по адресу запер бы всех разом.
 *
 * Счётчики в памяти процесса: api один, а сброс при перезапуске допустим — перезапуск сам по себе
 * не ускоряет перебор. Успешный вход обнуляет пару «логин + адрес», но не адрес: иначе при переборе
 * по многим логинам достаточно было бы изредка входить своим паролем.
 */
export interface ThrottleLimits {
  /** Неудач на пару «логин + адрес» за окно. */
  maxFailures: number;
  /** Неудач с одного адреса по всем логинам за окно. */
  maxFailuresPerIp: number;
  windowMs: number;
}

/** Выше этого числа ключей при очередной записи выметаем устаревшие — память не растёт от перебора. */
const PRUNE_ABOVE = 10_000;

export class LoginThrottle {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly limits: ThrottleLimits,
    private readonly now: () => number = Date.now,
  ) {}

  /** Сколько секунд ещё ждать, если вход с этого адреса под этим логином сейчас закрыт; иначе 0. */
  retryAfter(login: string, ip: string): number {
    const waits = [
      this.wait(pairKey(login, ip), this.limits.maxFailures),
      this.wait(ipKey(ip), this.limits.maxFailuresPerIp),
    ];
    return Math.max(0, ...waits);
  }

  fail(login: string, ip: string): void {
    if (this.failures.size > PRUNE_ABOVE) this.prune();
    for (const key of [pairKey(login, ip), ipKey(ip)]) {
      const list = this.recent(key);
      list.push(this.now());
      this.failures.set(key, list);
    }
  }

  succeed(login: string, ip: string): void {
    this.failures.delete(pairKey(login, ip));
  }

  private wait(key: string, limit: number): number {
    const list = this.recent(key);
    if (list.length < limit) return 0;
    // окно скользящее: откроется, когда из него выпадет самая старая из последних `limit` неудач
    const opensAt = list[list.length - limit] + this.limits.windowMs;
    return Math.max(1, Math.ceil((opensAt - this.now()) / 1000));
  }

  private recent(key: string): number[] {
    const since = this.now() - this.limits.windowMs;
    const list = (this.failures.get(key) ?? []).filter((t) => t > since);
    if (list.length === 0) this.failures.delete(key);
    return list;
  }

  private prune(): void {
    for (const key of [...this.failures.keys()]) this.recent(key);
  }
}

// регистр логина не важен для подбора: `Inspector` и `inspector` — одна попытка
const pairKey = (login: string, ip: string) => `login:${login.trim().toLowerCase()}|${ip}`;
const ipKey = (ip: string) => `ip:${ip}`;
