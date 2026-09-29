import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MLFLOW_COOKIE, MlflowClient, signSession, verifySession } from '../src/modules/mlops/mlflow.js';
import type { S } from '../src/types.js';
import { login, makeTestApp } from './helpers.js';

/** MLflow, которым управляет тест: отвечает как REST API MLflow 3 и запоминает вызовы. */
class FakeMlflow {
  readonly calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
  private server!: Server;
  private experiments = new Map<string, string>();
  url = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://x');
        const path = url.pathname.replace('/mlflow/api/2.0/mlflow/', '');
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        this.calls.push({ method: req.method ?? 'GET', path, body });
        res.setHeader('content-type', 'application/json');
        const send = (status: number, data: unknown) => {
          res.statusCode = status;
          res.end(JSON.stringify(data));
        };
        if (url.pathname === '/mlflow/health') return send(200, 'OK');
        if (path === 'experiments/get-by-name') {
          const id = this.experiments.get(url.searchParams.get('experiment_name') ?? '');
          return id ? send(200, { experiment: { experiment_id: id } }) : send(404, { error_code: 'RESOURCE_DOES_NOT_EXIST' });
        }
        if (path === 'experiments/create') {
          const id = String(this.experiments.size + 1);
          this.experiments.set(String(body.name), id);
          return send(200, { experiment_id: id });
        }
        if (path === 'runs/create') return send(200, { run: { info: { run_id: `run-${this.calls.length}` } } });
        if (path === 'runs/search') return send(200, { runs: [{ info: { run_id: 'run-found' } }] });
        return send(200, {});
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/mlflow`;
  }

  stop(): void {
    this.server.close();
  }

  async until(path: string, count = 1, timeoutMs = 3_000): Promise<void> {
    const started = Date.now();
    while (this.calls.filter((c) => c.path === path).length < count) {
      if (Date.now() - started > timeoutMs) throw new Error(`MLflow не получил ${path}: ${JSON.stringify(this.calls.map((c) => c.path))}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

const quiet = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as never;

describe('MLflow за Caddy: сессия из админки и проверка на каждый запрос', () => {
  const ml = new FakeMlflow();
  beforeAll(() => ml.start());
  afterAll(() => ml.stop());

  const setup = (mlflowUrl: string) => makeTestApp({ mlflowUrl });
  const auth = (app: Awaited<ReturnType<typeof setup>>['app'], cookie?: string) =>
    app.inject({ url: '/internal/auth/mlflow', headers: cookie ? { cookie } : {} });

  it('сессию выдают только администратору и ML-инженеру', async () => {
    const t = await setup(ml.url);
    try {
      const inspector = await t.app.inject({ method: 'POST', url: '/api/v1/admin/mlflow/session', headers: await login(t.app, 'inspector') });
      expect(inspector.statusCode).toBe(403);
      for (const who of ['admin', 'ml']) {
        const res = await t.app.inject({ method: 'POST', url: '/api/v1/admin/mlflow/session', headers: await login(t.app, who) });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ url: '/mlflow/', expires_in: expect.any(Number) });
      }
    } finally {
      await t.cleanup();
    }
  });

  it('cookie — только на путь /mlflow, недоступна скриптам и не уходит с чужих сайтов', async () => {
    const t = await setup(ml.url);
    try {
      const res = await t.app.inject({ method: 'POST', url: '/api/v1/admin/mlflow/session', headers: await login(t.app, 'admin') });
      const cookie = String(res.headers['set-cookie']);
      expect(cookie).toMatch(new RegExp(`^${MLFLOW_COOKIE}=[^;]+; Path=/mlflow; HttpOnly; SameSite=Strict; Max-Age=\\d+$`));
    } finally {
      await t.cleanup();
    }
  });

  it('Caddy пускает по выданной cookie и не пускает без неё, с поддельной или с JWT входа', async () => {
    const t = await setup(ml.url);
    try {
      const headers = await login(t.app, 'admin');
      const res = await t.app.inject({ method: 'POST', url: '/api/v1/admin/mlflow/session', headers });
      const pair = String(res.headers['set-cookie']).split(';')[0];
      expect((await auth(t.app, pair)).statusCode).toBe(204);
      expect((await auth(t.app, `lang=ru; ${pair}`)).statusCode).toBe(204);

      expect((await auth(t.app)).statusCode).toBe(401);
      expect((await auth(t.app, `${pair}x`)).statusCode).toBe(401);
      // JWT входа — другой токен: MLflow им не открыть
      expect((await auth(t.app, `${MLFLOW_COOKIE}=${headers.authorization.replace('Bearer ', '')}`)).statusCode).toBe(401);
      // токен сессии — не вход в api
      const token = pair.split('=')[1];
      expect((await t.app.inject({ url: '/api/v1/auth/me', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    } finally {
      await t.cleanup();
    }
  });

  it('MLflow не запущен — сессия 503 с подсказкой; выключен совсем — проверка отвечает 404', async () => {
    const down = await setup('http://127.0.0.1:9/mlflow');
    try {
      const res = await down.app.inject({ method: 'POST', url: '/api/v1/admin/mlflow/session', headers: await login(down.app, 'admin') });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: 'MLFLOW_UNAVAILABLE', message: expect.stringContaining('--mlflow') });
    } finally {
      await down.cleanup();
    }
    const off = await setup('');
    try {
      expect((await auth(off.app, `${MLFLOW_COOKIE}=${signSession(off.ctx.config.jwtSecret, 'u', 'ADMIN', 60)}`)).statusCode).toBe(404);
    } finally {
      await off.cleanup();
    }
  });
});

describe('токен сессии MLflow', () => {
  const secret = 'секрет-стенда';

  it('просроченный, с чужой подписью или с ролью без доступа — не пускает', () => {
    const now = Date.now();
    expect(verifySession(secret, signSession(secret, 'u', 'ADMIN', 60, now), now)).toMatchObject({ sub: 'u', role: 'ADMIN' });
    expect(verifySession(secret, signSession(secret, 'u', 'ADMIN', 60, now), now + 61_000)).toBeNull();
    expect(verifySession('другой', signSession(secret, 'u', 'ADMIN', 60, now), now)).toBeNull();
    expect(verifySession(secret, signSession(secret, 'u', 'INSPECTOR', 60, now), now)).toBeNull();
    expect(verifySession(secret, undefined, now)).toBeNull();
  });
});

describe('запись ML-контура в MLflow', () => {
  const ml = new FakeMlflow();
  beforeAll(() => ml.start());
  afterAll(() => ml.stop());

  const model = {
    model_version: 'scorer-2026-09-24',
    artifact_hash: 'abc',
    dataset_version: 'gold-v3',
    matrix_version: 'm-0.1',
    approval_status: 'PENDING',
    thresholds_passed: true,
    created_at: '2026-09-24T00:00:00Z',
    metrics: { precision: 0.93, recall: 0.84, f1: 0.88, false_positive_rate: 0.06, per_category: { 'Площади и объёмы': { recall: 0.9 } } },
  } as unknown as S['ModelVersion'];

  it('модель — прогон в эксперименте inspector-models с метриками §14 и по категориям', async () => {
    const client = new MlflowClient(ml.url, quiet);
    client.modelRegistered(model);
    await ml.until('runs/update');

    expect(ml.calls.find((c) => c.path === 'experiments/create')?.body).toMatchObject({ name: 'inspector-models' });
    expect(ml.calls.find((c) => c.path === 'runs/create')?.body).toMatchObject({ run_name: 'scorer-2026-09-24' });
    const batch = ml.calls.find((c) => c.path === 'runs/log-batch')!.body as { metrics: { key: string; value: number }[]; params: { key: string }[] };
    expect(batch.metrics.map((m) => m.key)).toEqual(
      expect.arrayContaining(['precision', 'recall', 'f1', 'false_positive_rate', 'category/Площади и объёмы/recall']),
    );
    expect(batch.params.map((p) => p.key)).toEqual(expect.arrayContaining(['dataset_version', 'artifact_hash']));
    expect(ml.calls.find((c) => c.path === 'runs/update')?.body).toMatchObject({ status: 'FINISHED' });
  });

  it('решение по модели — метки на её прогоне; версия набора — прогон в inspector-datasets', async () => {
    const client = new MlflowClient(ml.url, quiet);
    client.modelDecided({ ...model, approval_status: 'APPROVED' } as S['ModelVersion'], 'APPROVE', 'пороги пройдены', 'admin');
    await ml.until('runs/set-tag', 4);
    const tags = ml.calls.filter((c) => c.path === 'runs/set-tag').map((c) => [c.body.key, c.body.value]);
    expect(tags).toEqual(expect.arrayContaining([['decision', 'APPROVE'], ['approval_status', 'APPROVED'], ['decision_by', 'admin']]));

    client.datasetReleased({ version: 'gold-v3', items_count: 120, positives: 40, negatives: 80, split_counts: { TRAIN: 90 }, split_hashes: { TRAIN: 'h' }, created_at: '' } as S['DatasetVersion']);
    await ml.until('runs/update', 2);
    expect(ml.calls.some((c) => c.path === 'experiments/create' && c.body.name === 'inspector-datasets')).toBe(true);
  });

  it('MLflow недоступен — запись молча пропускается, исключений наружу нет', async () => {
    const client = new MlflowClient('http://127.0.0.1:9/mlflow', quiet, 500);
    expect(() => client.modelRegistered(model)).not.toThrow();
    expect(await client.healthy()).toBe(false);
    expect(new MlflowClient('', quiet).enabled).toBe(false);
  });
});
