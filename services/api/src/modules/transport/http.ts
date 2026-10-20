import type { Envelope } from '../../types.js';
import type { JobProbe, MlTransport } from './types.js';

/** Сверка идёт по таймеру и по многим задачам подряд — ждать ответа долго незачем. */
const PROBE_TIMEOUT_MS = 3_000;

/** HTTP-транспорт (по умолчанию для реального ML): POST {ML_URL}/v1/jobs, результат — на reply_to. */
export class HttpTransport implements MlTransport {
  readonly kind = 'http';

  constructor(
    private readonly mlUrl: string,
    private readonly replyTo: string,
    /** Передаётся в ml; ml возвращает его в заголовке x-internal-token при callback. */
    private readonly internalToken = '',
    private readonly timeoutMs = 10_000,
  ) {}

  async send(envelope: Envelope): Promise<void> {
    const res = await fetch(`${this.mlUrl.replace(/\/$/, '')}/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.internalToken ? { 'x-internal-token': this.internalToken } : {}) },
      body: JSON.stringify({ ...envelope, reply_to: this.replyTo }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ML-сервис ответил ${res.status}: ${text.slice(0, 300)}`);
    }
  }

  /**
   * GET {ML_URL}/v1/jobs/{id}: 404 — ML задачу не знает (перезапускался), остальное — ошибка связи.
   *
   * Токен нужен и здесь: в контракте у операции `security: []`, но ML закрывает её тем же
   * `x-internal-token`, что и приём задач, — в ответе лежит результат разбора. Без токена ML
   * отвечал 401, сверка считала его недоступным и молча ничего не делала (поймано живым
   * прогоном с перезапуском ML 23.09 — тест с подменным транспортом этого не видел).
   */
  async status(messageId: string): Promise<JobProbe> {
    const res = await fetch(`${this.mlUrl.replace(/\/$/, '')}/v1/jobs/${encodeURIComponent(messageId)}`, {
      headers: this.internalToken ? { 'x-internal-token': this.internalToken } : {},
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`ML-сервис ответил ${res.status} на запрос состояния задачи`);
    return (await res.json()) as JobProbe;
  }
}
