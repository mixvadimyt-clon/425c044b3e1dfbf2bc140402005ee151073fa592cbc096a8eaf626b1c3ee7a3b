import type { AppContext } from '../../context.js';
import { nowIso } from '../../db/sqlite.js';
import type { S } from '../../types.js';
import { RinClient, RinError } from './client.js';
import { applyPackage, listPackages, pullPackages } from './inbox.js';
import { deliverDue, enqueueResult, syncInfo } from './outbox.js';

export { RinError } from './client.js';
export { inspectionResult } from './outbox.js';

/**
 * Обмен с внешней ИС надзора: таймеры опроса и доставки, защита от параллельных запусков.
 * Выключен, пока не задан RIN_URL, — тогда эндпоинты интеграции отвечают INTEGRATION_DISABLED.
 */
export class Integration {
  readonly client: RinClient;
  private timers: NodeJS.Timeout[] = [];
  private delivering: Promise<void> | null = null;
  private deliverAgain = false;
  private pulling: Promise<S['IntegrationPackage'][]> | null = null;

  constructor(private readonly ctx: AppContext) {
    this.client = new RinClient(ctx.config.rin);
  }

  get enabled(): boolean {
    return this.client.enabled;
  }

  private get cfg() {
    return this.ctx.config.rin;
  }

  start(): void {
    if (!this.enabled) return;
    const outbox = setInterval(() => this.kick(), this.cfg.outboxTickMs);
    outbox.unref();
    this.timers.push(outbox);
    if (this.cfg.pollIntervalS > 0) {
      const poll = setInterval(() => {
        this.pull(null).catch(() => undefined); // ошибка уже записана в состояние обмена
      }, this.cfg.pollIntervalS * 1000);
      poll.unref();
      this.timers.push(poll);
    }
    this.ctx.log.info({ url: this.cfg.url, poll_s: this.cfg.pollIntervalS, auto_push: this.cfg.autoPush }, `интеграция: ${this.cfg.systemName}`);
    this.kick(); // недоставленное до перезапуска
  }

  async stop(): Promise<void> {
    this.timers.forEach(clearInterval);
    this.timers = [];
    await Promise.allSettled([this.delivering, this.pulling]);
  }

  /** Поставить результат в очередь и сразу попробовать доставить. */
  enqueue(processId: string, source: 'FINALIZED' | 'MANUAL'): S['SyncInfo'] {
    const info = enqueueResult(this.ctx.db, this.cfg, processId, source);
    this.kick();
    return info;
  }

  /** Запустить доставку в фоне; если она уже идёт — повторить проход после неё (новые записи не потеряются). */
  kick(): void {
    this.deliver().catch((err) => this.ctx.log.error({ err }, 'Ошибка доставки результатов во внешнюю ИС'));
  }

  deliver(): Promise<void> {
    if (this.delivering) {
      this.deliverAgain = true;
      return this.delivering;
    }
    this.delivering = (async () => {
      // Флаг снимаем внутри try/finally, а не в .finally() промиса: там он снимается отдельной
      // микрозадачей, и между выходом из цикла и снятием остаётся окно, в котором новый kick()
      // поставит deliverAgain, увидит «доставка идёт» и уйдёт — а цикл уже не повторится.
      try {
        do {
          this.deliverAgain = false;
          await deliverDue(this.ctx.db, this.cfg, this.client);
        } while (this.deliverAgain);
      } finally {
        this.delivering = null;
      }
    })();
    return this.delivering;
  }

  /** Забрать новые пакеты (одновременно — один опрос). Ошибку связи запоминает для GET /integration/status и пробрасывает. */
  pull(requestedBy: string | null): Promise<S['IntegrationPackage'][]> {
    if (this.pulling) return this.pulling;
    this.pulling = (async () => {
      try {
        const packages = await pullPackages(this.ctx, this.client, requestedBy);
        this.setState({ last_pull_at: nowIso(), last_pull_error: null });
        return packages;
      } catch (err) {
        const message = err instanceof RinError ? `${this.cfg.systemName}: ${err.message}` : (err as Error).message;
        this.setState({ last_pull_at: nowIso(), last_pull_error: message });
        this.ctx.log.warn({ err: message }, 'Не удалось забрать пакеты из внешней ИС');
        throw err;
      }
    })().finally(() => {
      this.pulling = null;
    });
    return this.pulling;
  }

  apply(recordId: string): Promise<S['IntegrationPackage']> {
    return applyPackage(this.ctx, this.client, recordId);
  }

  packages(status?: S['IntegrationPackageStatus']): S['IntegrationPackage'][] {
    return listPackages(this.ctx.db, status);
  }

  sync(processId: string): S['SyncInfo'] {
    return syncInfo(this.ctx.db, processId, this.cfg.systemName);
  }

  status(): S['IntegrationStatus'] {
    const { db } = this.ctx;
    const count = (status: string) => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM integration_outbox WHERE sync_status = ?', status)!.n;
    const state = (key: string) => db.get<{ value: string | null }>('SELECT value FROM integration_state WHERE key = ?', key)?.value ?? null;
    return {
      enabled: this.enabled,
      external_system: this.cfg.systemName,
      base_url: this.cfg.url || null,
      poll_interval_s: this.cfg.pollIntervalS,
      auto_push: this.cfg.autoPush,
      retry_delays_s: this.cfg.retryDelaysS,
      last_pull_at: state('last_pull_at'),
      last_pull_error: state('last_pull_error'),
      outbox: { pending: count('PENDING_SYNC'), synced: count('SYNCED'), failed: count('SYNC_FAILED') },
    };
  }

  private setState(values: Record<string, string | null>): void {
    const now = nowIso();
    for (const [key, value] of Object.entries(values)) {
      this.ctx.db.run(
        'INSERT INTO integration_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        key,
        value,
        now,
      );
    }
  }
}
