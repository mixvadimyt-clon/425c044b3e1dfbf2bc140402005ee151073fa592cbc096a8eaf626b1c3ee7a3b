import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import { HttpTransport } from '../src/modules/transport/http.js';
import { StubTransport } from '../src/modules/transport/stub.js';
import type { JobProbe, MlTransport } from '../src/modules/transport/types.js';
import type { E, Envelope } from '../src/types.js';
import { login, makePdf, makeTestApp, multipart } from './helpers.js';

/**
 * ML, которым управляет тест. Как настоящий, помнит отданные задачи (`GET /v1/jobs/{id}`) и
 * теряет их при перезапуске; правильные по контракту результаты считает штатная заглушка api.
 */
class FakeMl implements MlTransport {
  readonly kind = 'fake';
  readonly sent: Envelope[] = [];
  readonly jobs = new Map<string, NonNullable<JobProbe>>();
  down = false;
  private ctx!: AppContext;

  bind(ctx: AppContext): this {
    this.ctx = ctx;
    return this;
  }

  async send(env: Envelope): Promise<void> {
    this.sent.push(env);
    this.jobs.set(env.message_id, { state: 'QUEUED', result: null });
  }

  async status(messageId: string): Promise<JobProbe> {
    if (this.down) throw new Error('connect ECONNREFUSED');
    return this.jobs.get(messageId) ?? null;
  }

  restart(): void {
    this.jobs.clear();
  }

  parses(): Envelope[] {
    return this.sent.filter((e) => e.type === 'ml.parse.request');
  }

  compares(): Envelope[] {
    return this.sent.filter((e) => e.type === 'ml.compare.request');
  }

  /** Закончить задачу; `deliver = false` — результат готов, но callback до api не дошёл. */
  async finish(request: Envelope, deliver = true): Promise<void> {
    const result = await new Promise<Envelope>((resolve) => {
      void new StubTransport(this.ctx.db, async (env) => resolve(env), 0).send(request);
    });
    await this.settle(request, result, deliver);
  }

  /** ML сам снял разбор по таймауту — как `jobs/runner.py`: ошибка TIMEOUT, retryable = true. */
  async timeout(request: Envelope): Promise<void> {
    const p = request.payload as E['ParseRequest'];
    const result: Envelope = {
      message_id: randomUUID(),
      type: 'ml.parse.result',
      schema_version: request.schema_version,
      correlation_id: request.correlation_id,
      attempt: request.attempt,
      created_at: new Date().toISOString(),
      payload: {
        process_id: p.process_id,
        file_id: p.file.file_id,
        sha256: p.file.sha256,
        status: 'FAILED',
        error: { code: 'TIMEOUT', message: 'Задача не уложилась в отведённое время', retryable: true },
        parser_version: 'test',
      },
    };
    await this.settle(request, result, true);
  }

  private async settle(request: Envelope, result: Envelope, deliver: boolean): Promise<void> {
    const failed = (result.payload as { status?: string }).status === 'FAILED';
    this.jobs.set(request.message_id, { state: failed ? 'FAILED' : 'DONE', result });
    if (deliver) await this.ctx.orchestrator.handleEnvelope(result);
  }
}

async function setup(ml: Partial<AppConfig['ml']> = {}) {
  const fake = new FakeMl();
  const t = await makeTestApp(
    { ml: { transport: 'http', probeGraceMs: 0, jobTimeoutMs: 3_600_000, maxRetries: 2, ...ml } } as never,
    { transport: (ctx) => fake.bind(ctx) },
  );
  const headers = await login(t.app, 'inspector');
  const upload = async (names: string[]) => {
    const obj = await t.app.inject({ method: 'POST', url: '/api/v1/objects', headers, payload: { name: 'Сверка с ML' } });
    const parts = [{ name: 'object_id', value: obj.json().id as string }];
    const files = await Promise.all(names.map(async (n, i) => ({ name: 'files', filename: n, content: await makePdf(1, `file ${i}`) })));
    const mp = multipart([...parts, ...files]);
    const up = await t.app.inject({ method: 'POST', url: '/api/v1/documents/upload', headers: { ...headers, ...mp.headers }, payload: mp.payload });
    expect(up.statusCode).toBe(202);
    return up.json().process_id as string;
  };
  const status = async (processId: string) => (await t.app.inject({ url: `/api/v1/processes/${processId}/status`, headers })).json();
  const job = (messageId: string) => t.ctx.db.get<{ status: string; deadline_at: string }>('SELECT status, deadline_at FROM ml_jobs WHERE message_id = ?', messageId)!;
  const file = (fileId: string) => t.ctx.db.get<{ processing_status: string; error: string | null }>('SELECT processing_status, error FROM files WHERE id = ?', fileId)!;
  return { ...t, fake, upload, status, job, file };
}

const fileOf = (env: Envelope) => (env.payload as E['ParseRequest']).file.file_id;

describe('сверка задач с ML (зависший разбор)', () => {
  it('ML перезапустился и забыл задачу — она уходит заново сразу, не дожидаясь дедлайна', async () => {
    const t = await setup();
    try {
      const pid = await t.upload(['Раздел 4 КР.pdf']);
      const [first] = t.fake.parses();
      t.fake.restart();

      await t.ctx.orchestrator.sweep();

      expect(t.fake.parses()).toHaveLength(2);
      const second = t.fake.parses()[1];
      expect(second.attempt).toBe(2);
      expect(fileOf(second)).toBe(fileOf(first));
      expect(t.job(first.message_id).status).toBe('FAILED');
      expect(t.file(fileOf(first)).processing_status).toBe('PARSING');

      await t.fake.finish(second);
      await t.fake.finish(t.fake.compares()[0]);
      expect((await t.status(pid)).status).toBe('READY');
    } finally {
      await t.cleanup();
    }
  });

  it('результат готов, но callback не дошёл — сверка забирает его сама', async () => {
    const t = await setup();
    try {
      await t.upload(['Раздел 4 КР.pdf']);
      const [parse] = t.fake.parses();
      await t.fake.finish(parse, false);
      expect(t.file(fileOf(parse)).processing_status).toBe('PARSING');

      await t.ctx.orchestrator.sweep();

      expect(t.file(fileOf(parse)).processing_status).toBe('PARSED');
      expect(t.job(parse.message_id).status).toBe('DONE');
      expect(t.fake.parses()).toHaveLength(1);
      expect(t.fake.compares()).toHaveLength(1);
    } finally {
      await t.cleanup();
    }
  });

  it('задача ждёт в очереди ML дольше дедлайна api — её не снимают и не отправляют второй раз', async () => {
    const t = await setup({ jobTimeoutMs: 1 });
    try {
      await t.upload(['Раздел 4 КР.pdf']);
      const [parse] = t.fake.parses();
      await new Promise((r) => setTimeout(r, 10));
      const before = t.job(parse.message_id).deadline_at;

      await t.ctx.orchestrator.sweep();

      expect(t.fake.parses()).toHaveLength(1);
      expect(t.job(parse.message_id).status).toBe('SENT');
      expect(t.job(parse.message_id).deadline_at > before).toBe(true);
    } finally {
      await t.cleanup();
    }
  });

  it('ML недоступен — сверка ничего не трогает, пока не истёк дедлайн', async () => {
    const t = await setup();
    try {
      await t.upload(['Раздел 4 КР.pdf']);
      const [parse] = t.fake.parses();
      t.fake.down = true;

      await t.ctx.orchestrator.sweep();

      expect(t.fake.parses()).toHaveLength(1);
      expect(t.job(parse.message_id).status).toBe('SENT');
    } finally {
      await t.cleanup();
    }
  });

  it('ML недоступен дольше дедлайна — задача повторяется, как и раньше', async () => {
    const t = await setup({ jobTimeoutMs: 1 });
    try {
      await t.upload(['Раздел 4 КР.pdf']);
      t.fake.down = true;
      await new Promise((r) => setTimeout(r, 10));

      await t.ctx.orchestrator.sweep();

      expect(t.fake.parses()).toHaveLength(2);
      expect(t.fake.parses()[1].attempt).toBe(2);
    } finally {
      await t.cleanup();
    }
  });

  it('разбор, снятый ML по таймауту, не повторяется: файл в ошибке, проверка идёт дальше', async () => {
    const t = await setup();
    try {
      await t.upload(['Раздел 4 КР.pdf', 'Раздел 3 АР.pdf']);
      const [heavy, light] = t.fake.parses();

      await t.fake.timeout(heavy);
      await t.fake.finish(light);

      expect(t.fake.parses()).toHaveLength(2);
      expect(t.file(fileOf(heavy)).processing_status).toBe('FAILED');
      expect(t.file(fileOf(heavy)).error).toContain('не уложился в 60 мин');
      expect(t.file(fileOf(light)).processing_status).toBe('PARSED');
      expect(t.fake.compares()).toHaveLength(1);
    } finally {
      await t.cleanup();
    }
  });
});

describe('HttpTransport.status — запрос состояния задачи у ML', () => {
  // ML закрывает GET /v1/jobs/{id} тем же токеном, что и приём задач; без него отвечал 401,
  // и сверка молча считала ML недоступным. Сервер ведёт себя как services/ml/.../api/app.py.
  const KNOWN = '11111111-1111-4111-8111-111111111111';

  async function withMl(run: (url: string) => Promise<void>) {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.headers['x-internal-token'] !== 'stand-token') {
        res.statusCode = 401;
        return res.end(JSON.stringify({ detail: 'Неверный internal token' }));
      }
      const id = (req.url ?? '').split('/').pop();
      if (id !== KNOWN) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ detail: 'Нет такой задачи' }));
      }
      res.end(JSON.stringify({ message_id: id, state: 'RUNNING', progress: 0, result: null }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    } finally {
      server.close();
    }
  }

  it('с токеном: известная задача — её состояние, забытая — null', async () => {
    await withMl(async (url) => {
      const ml = new HttpTransport(url, 'http://api/internal/ml/results', 'stand-token');
      expect(await ml.status(KNOWN)).toMatchObject({ state: 'RUNNING' });
      expect(await ml.status('22222222-2222-4222-8222-222222222222')).toBeNull();
    });
  });

  it('без токена — ошибка, а не «задача потеряна»: иначе api гнал бы задачи в ML по кругу', async () => {
    await withMl(async (url) => {
      const ml = new HttpTransport(url, 'http://api/internal/ml/results', '');
      await expect(ml.status(KNOWN)).rejects.toThrow('401');
    });
  });
});

describe('модель скорера в запросе сравнения', () => {
  it('без одобренной модели — null (только правила), после одобрения — её версия', async () => {
    const t = await setup();
    try {
      const modelOf = (env: Envelope) => (env.payload as E['CompareRequest']).versions?.model_version;

      await t.upload(['Раздел 4 КР.pdf']);
      await t.fake.finish(t.fake.parses()[0]);
      expect(modelOf(t.fake.compares()[0])).toBeNull();

      const now = new Date().toISOString();
      // отклонённая и ожидающая модели не текущие — берётся только одобренная
      t.ctx.db.insert('model_versions', { model_version: 'scorer-draft', dataset_version: 'ds-1', approval_status: 'PENDING', created_at: now });
      t.ctx.db.insert('model_versions', { model_version: 'scorer-7', dataset_version: 'ds-1', approval_status: 'APPROVED', deployed_at: now, created_at: now });

      await t.upload(['Раздел 5 КР.pdf']);
      await t.fake.finish(t.fake.parses()[1]);
      expect(modelOf(t.fake.compares()[1])).toBe('scorer-7');
    } finally {
      await t.cleanup();
    }
  });
});
