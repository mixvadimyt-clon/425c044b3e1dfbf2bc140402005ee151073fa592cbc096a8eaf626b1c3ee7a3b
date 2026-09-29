/**
 * MLflow: витрина ML-контура для вкладки в админке.
 *
 * Источник истины — по-прежнему api: версии GOLD-набора, реестр моделей и решения по ним живут
 * в базе. MLflow получает их копию прогонами, чтобы ML-инженер и администратор видели
 * метрики §14 по версиям моделей в привычном интерфейсе. Поэтому запись — «по возможности»:
 * MLflow выключен или не отвечает — api работает как работал, в логе предупреждение.
 *
 * MLflow стоит за Caddy по `/mlflow/` и своей авторизации не имеет. Пускает туда api: веб
 * запрашивает сессию (`POST /admin/mlflow/session`, только ADMIN и ML_ENGINEER), api ставит
 * cookie с подписанным токеном на путь `/mlflow`, Caddy на каждый запрос спрашивает
 * `GET /internal/auth/mlflow`. Токен отдельный от JWT входа — своя подпись, своё назначение:
 * им нельзя войти в api, а JWT входа не откроет MLflow.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Role, S } from '../../types.js';

export const MLFLOW_COOKIE = 'inspector_mlflow';
export const MLFLOW_ROLES: readonly Role[] = ['ADMIN', 'ML_ENGINEER'];

const EXPERIMENT_MODELS = 'inspector-models';
const EXPERIMENT_DATASETS = 'inspector-datasets';
/** Числовые метрики §14 из отчёта модели — их MLflow рисует графиками по версиям. */
const METRICS = [
  'precision',
  'recall',
  'f1',
  'false_positive_rate',
  'ocr_character_accuracy',
  'key_fields_exact_match',
  'linking_accuracy',
  'localization_accuracy',
  'coverage',
  'sample_size',
] as const;
/** Ключи MLflow: буквы, цифры, «_ - . / » и пробел; остальное в категориях заменяем. */
const KEY = /[^\p{L}\p{N}_\-./ ]/gu;

// ------------------------------------------------------------------ сессия

interface SessionClaims {
  sub: string;
  role: Role;
  exp: number;
}

const b64 = (s: string) => Buffer.from(s).toString('base64url');
const mac = (secret: string, data: string) => createHmac('sha256', `${secret}:mlflow-session`).update(data).digest('base64url');

/** Токен сессии MLflow: `payload.подпись`, подпись HMAC-SHA256 на производном от JWT_SECRET ключе. */
export function signSession(secret: string, sub: string, role: Role, ttlSeconds: number, now = Date.now()): string {
  const payload = b64(JSON.stringify({ sub, role, exp: Math.floor(now / 1000) + ttlSeconds } satisfies SessionClaims));
  return `${payload}.${mac(secret, payload)}`;
}

/** Проверка токена: подпись, срок и роль. `null` — не пускать. */
export function verifySession(secret: string, token: string | undefined, now = Date.now()): SessionClaims | null {
  if (!token) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(mac(secret, payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionClaims;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null;
    return MLFLOW_ROLES.includes(claims.role) ? claims : null;
  } catch {
    return null;
  }
}

/** Значение cookie из заголовка `Cookie` — без отдельного плагина: нужна ровно одна. */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

// ------------------------------------------------------------------ клиент

type Json = Record<string, unknown>;

export class MlflowClient {
  private readonly experiments = new Map<string, string>();

  constructor(
    /** Адрес вместе с префиксом: `http://mlflow:5000/mlflow`. Пусто — MLflow выключен. */
    private readonly url: string,
    private readonly log: FastifyBaseLogger,
    private readonly timeoutMs = 3_000,
  ) {}

  get enabled(): boolean {
    return Boolean(this.url);
  }

  async healthy(): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const res = await fetch(`${this.base}/health`, { signal: AbortSignal.timeout(2_000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Модель зарегистрирована (POST /ml/models): прогон с метриками §14 и итогом приёмочных проверок. */
  modelRegistered(model: S['ModelVersion']): void {
    this.background('model_registered', async () => {
      const metrics = (model.metrics ?? {}) as Json;
      await this.logRun(EXPERIMENT_MODELS, model.model_version, {
        params: {
          model_version: model.model_version,
          dataset_version: model.dataset_version,
          matrix_version: model.matrix_version ?? '',
          artifact_hash: model.artifact_hash ?? '',
        },
        metrics: { ...pick(metrics), ...perCategory(metrics.per_category) },
        tags: {
          model_version: model.model_version,
          approval_status: String(model.approval_status),
          thresholds_passed: String(model.thresholds_passed ?? ''),
        },
      });
    });
  }

  /** Решение по модели (APPROVE / REJECT / ROLLBACK) — метка на прогоне этой версии. */
  modelDecided(model: S['ModelVersion'], action: string, comment: string | undefined, by: string): void {
    this.background('model_decided', async () => {
      const experimentId = await this.experiment(EXPERIMENT_MODELS);
      const found = (await this.call('runs/search', {
        experiment_ids: [experimentId],
        filter: `tags.model_version = '${model.model_version.replace(/'/g, "\\'")}'`,
        max_results: 10,
      })) as { runs?: { info: { run_id: string } }[] };
      for (const run of found.runs ?? []) {
        for (const [key, value] of Object.entries({
          approval_status: String(model.approval_status),
          decision: action,
          decision_by: by,
          decision_comment: comment ?? '',
        })) {
          await this.call('runs/set-tag', { run_id: run.info.run_id, key, value });
        }
      }
    });
  }

  /** Выпущена версия GOLD-набора: размеры частей и их хеши. */
  datasetReleased(version: S['DatasetVersion']): void {
    this.background('dataset_released', async () => {
      const counts = (version.split_counts ?? {}) as Record<string, number>;
      await this.logRun(EXPERIMENT_DATASETS, version.version, {
        params: {
          version: version.version,
          ...Object.fromEntries(Object.entries(version.split_hashes ?? {}).map(([k, v]) => [`sha256_${k}`, String(v)])),
        },
        metrics: {
          items_count: version.items_count,
          positives: version.positives ?? 0,
          negatives: version.negatives ?? 0,
          ...Object.fromEntries(Object.entries(counts).map(([k, v]) => [`items_${k}`, v])),
        },
        tags: { dataset_version: version.version },
      });
    });
  }

  // ---------------------------------------------------------------- REST MLflow

  private get base(): string {
    return this.url.replace(/\/$/, '');
  }

  private background(what: string, work: () => Promise<void>): void {
    if (!this.enabled) return;
    work().catch((err) => this.log.warn({ err: String(err), what }, 'MLflow: запись не удалась — api работает дальше'));
  }

  private async call(path: string, body?: Json, method = 'POST'): Promise<Json> {
    const res = await fetch(`${this.base}/api/2.0/mlflow/${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`MLflow ${path}: ${res.status} ${text.slice(0, 200)}`);
    return text ? (JSON.parse(text) as Json) : {};
  }

  private async experiment(name: string): Promise<string> {
    const known = this.experiments.get(name);
    if (known) return known;
    let id: string | undefined;
    try {
      const found = await this.call(`experiments/get-by-name?experiment_name=${encodeURIComponent(name)}`, undefined, 'GET');
      id = (found.experiment as { experiment_id?: string } | undefined)?.experiment_id;
    } catch {
      // нет такого эксперимента — создадим; настоящая ошибка связи всплывёт на создании
    }
    if (!id) id = String((await this.call('experiments/create', { name })).experiment_id);
    this.experiments.set(name, id);
    return id;
  }

  private async logRun(
    experiment: string,
    runName: string,
    data: { params: Record<string, string>; metrics: Record<string, number>; tags: Record<string, string> },
  ): Promise<void> {
    const experimentId = await this.experiment(experiment);
    const now = Date.now();
    const created = (await this.call('runs/create', { experiment_id: experimentId, run_name: runName, start_time: now })) as {
      run: { info: { run_id: string } };
    };
    const runId = created.run.info.run_id;
    await this.call('runs/log-batch', {
      run_id: runId,
      params: Object.entries(data.params).map(([key, value]) => ({ key, value: value.slice(0, 6000) })),
      metrics: Object.entries(data.metrics)
        .filter(([, value]) => Number.isFinite(value))
        .map(([key, value]) => ({ key, value, timestamp: now, step: 0 })),
      tags: Object.entries(data.tags).map(([key, value]) => ({ key, value })),
    });
    await this.call('runs/update', { run_id: runId, status: 'FINISHED', end_time: Date.now() });
  }
}

function pick(metrics: Json): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of METRICS) {
    const value = metrics[key];
    if (typeof value === 'number') out[key] = value;
  }
  return out;
}

/** `per_category: {Площади: {recall: 0.9}}` → `category/Площади/recall` — графики по категориям. */
function perCategory(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [category, metrics] of Object.entries(value as Record<string, unknown>)) {
    if (!metrics || typeof metrics !== 'object') continue;
    for (const [key, number] of Object.entries(metrics as Record<string, unknown>)) {
      if (typeof number === 'number') out[`category/${category.replace(KEY, '_')}/${key.replace(KEY, '_')}`] = number;
    }
  }
  return out;
}
