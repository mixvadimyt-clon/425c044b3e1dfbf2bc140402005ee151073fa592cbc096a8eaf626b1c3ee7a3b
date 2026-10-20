import { readFileSync } from 'node:fs';
import path from 'node:path';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import type { Ajv } from 'ajv';
import Fastify, { LogController, type FastifyInstance, type FastifyError } from 'fastify';
import openapiGlue, { type FastifyOpenapiGlueOptions } from 'fastify-openapi-glue';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { type AppConfig, loadConfig } from './config.js';
import type { AppContext, Handler } from './context.js';
import { Db } from './db/sqlite.js';
import { seed } from './db/seed.js';
import { ApiError } from './errors.js';
import { adminHandlers } from './handlers/admin.js';
import { coreHandlers } from './handlers/core.js';
import { integrationHandlers } from './handlers/integration.js';
import { mlHandlers } from './handlers/ml.js';
import { protocolHandlers } from './handlers/protocols.js';
import { Integration } from './modules/integration/index.js';
import { MLFLOW_COOKIE, MlflowClient, cookieValue, verifySession } from './modules/mlops/mlflow.js';
import { audit, auditFinish, auditStart, setAuditSinks } from './modules/notify.js';
import { Orchestrator } from './modules/orchestrator.js';
import { LocalStorage } from './modules/storage.js';
import { ContractValidator } from './modules/validate.js';
import { HttpTransport } from './modules/transport/http.js';
import { StubTransport } from './modules/transport/stub.js';
import type { MlTransport } from './modules/transport/types.js';
import type { Envelope } from './types.js';

export interface BuildOptions {
  config?: AppConfig;
  /** Подменить транспорт (тесты). */
  transport?: (ctx: AppContext) => MlTransport;
  logger?: boolean;
}

/** Операции контракта, которые ещё не реализованы — отвечают 501 с понятным сообщением. */
const PLANNED: Record<string, string> = {};
/** Предел тела результата от ML (`/internal/ml/results`): с запасом на большой комплект из 132 параметров. */
export const ML_RESULT_MAX_BYTES = 64 * 1024 * 1024;

export async function buildApp(opts: BuildOptions = {}): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const config = opts.config ?? loadConfig();
  const app = Fastify({
    // Адрес клиента для ограничения попыток входа. За Caddy доверяем ровно config.trustProxy ближайшим
    // хопам: тогда req.ip — адрес, который дописал сам Caddy, а не подставленный клиентом в заголовок.
    trustProxy: config.trustProxy > 0 ? (_address: string, hop: number) => hop < config.trustProxy : false,
    logger:
      opts.logger === false
        ? false
        : {
            level: config.logLevel,
            // REQ-MON-01: JSON-логи с полями timestamp, level, service, message, request_id, user_id
            base: { service: 'api' },
            messageKey: 'message',
            timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
            formatters: { level: (label) => ({ level: label.toUpperCase() }) },
          },
    logController: new LogController({ requestIdLogLabel: 'request_id', disableRequestLogging: (req) => req.url === '/health' || req.url === '/metrics' }),
    genReqId: (req) => (req.headers['x-request-id'] as string) || crypto.randomUUID(),
    ajv: {
      customOptions: { allErrors: false },
      // ключевые слова OpenAPI, которых нет в JSON Schema
      plugins: [
        (ajv: Ajv) => {
          for (const k of ['example', 'xml', 'externalDocs']) ajv.addKeyword(k);
          return ajv;
        },
      ],
    },
  });

  const db = new Db(config.dbPath);
  db.migrate();
  await seed(db, config);
  const storage = new LocalStorage(config.storageDir);
  const orchestrator = new Orchestrator(db, config, storage, app.log);
  const validator = new ContractValidator(config.contractsDir);
  const ctx = { db, config, storage, orchestrator, validator, log: app.log } as AppContext;
  ctx.integration = new Integration(ctx);
  ctx.mlflow = new MlflowClient(config.mlflowUrl, app.log);
  orchestrator.transport = opts.transport
    ? opts.transport(ctx)
    : config.ml.transport === 'http'
      ? new HttpTransport(config.ml.url, `${config.publicUrl}/internal/ml/results`, config.internalToken)
      : new StubTransport(db, (env) => orchestrator.handleEnvelope(env), config.ml.stubDelayMs);
  app.log.info({ transport: orchestrator.transport.kind, db: config.dbPath }, 'api: конфигурация');

  await app.register(cors, {
    origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(','),
    // @fastify/cors 11 по умолчанию разрешает только безопасные методы (GET, HEAD, POST). Контракт
    // использует ещё PATCH, PUT и DELETE — без явного списка браузер отменяет их на предпроверке.
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE'],
    exposedHeaders: ['content-disposition'],
  });
  await app.register(jwt, { secret: config.jwtSecret });
  // Журнал действий пишется в базу всегда; файл и вебхук — по настройке
  setAuditSinks(config, app.log);
  await app.register(multipart, { throwFileSizeLimit: false });
  // Типы ответов (PDF/DOCX/XML) попадают в список парсеров openapi-glue — регистрируем «сырой» приём, чтобы не было предупреждений
  app.addContentTypeParser(
    ['application/pdf', 'application/octet-stream', 'application/xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    { parseAs: 'buffer', bodyLimit: 1024 },
    (_req, body, done) => done(null, body),
  );

  // ------------------------------------------------------------------ метрики
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, labels: { service: 'api' } });
  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Длительность HTTP-запросов',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.01, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
    registers: [registry],
  });
  const httpTotal = new Counter({
    name: 'http_requests_total',
    help: 'Число HTTP-запросов',
    labelNames: ['method', 'route', 'status_code'],
    registers: [registry],
  });
  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });

  // ------------------------------------------------------ ошибки и аудит
  app.setErrorHandler((err: FastifyError & { errors?: unknown[] }, req, reply) => {
    const requestId = req.id;
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send({ code: err.code, message: err.message, details: err.details, request_id: requestId });
    }
    if (err.validation) {
      return reply.code(400).send({
        code: 'VALIDATION_ERROR',
        message: `Некорректный запрос: ${err.message}`,
        details: { errors: err.validation },
        request_id: requestId,
      });
    }
    if (err.name === 'SecurityError' || err.statusCode === 401) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Требуется вход в систему', request_id: requestId });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ code: err.code ?? 'BAD_REQUEST', message: err.message, request_id: requestId });
    }
    req.log.error({ err }, 'Необработанная ошибка');
    return reply.code(500).send({ code: 'INTERNAL', message: 'Внутренняя ошибка сервера', request_id: requestId });
  });

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unknown';
    httpDuration.observe({ method: req.method, route, status_code: reply.statusCode }, reply.elapsedTime / 1000);
    httpTotal.inc({ method: req.method, route, status_code: reply.statusCode });
    const operationId = (req.routeOptions.schema as { operationId?: string } | undefined)?.operationId;
    const isMutation = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
    const isExport = operationId === 'exportProtocol';
    if (!operationId || (!isMutation && !isExport)) return;
    try {
      const params = (req.params ?? {}) as Record<string, string>;
      // строка, начатая до действия, получает итог; иначе (выгрузка, отказ до обработчика) — новая
      const write = req.auditId ? (entry: Parameters<typeof audit>[1]) => auditFinish(db, req.auditId!, entry) : (entry: Parameters<typeof audit>[1]) => audit(db, entry);
      write({
        user_id: req.user?.sub ?? null,
        user_role: req.user?.role ?? null,
        action: operationId,
        object_id: req.audit?.object_id ?? params.object_id ?? null,
        entity_type: req.audit?.entity_type ?? null,
        entity_id: req.audit?.entity_id ?? params.process_id ?? params.finding_id ?? params.file_id ?? null,
        details: { status_code: reply.statusCode, ...(req.audit?.details ?? {}) },
        ip_address: req.ip,
        user_agent: (req.headers['user-agent'] as string) ?? null,
      });
    } catch (err) {
      req.log.error({ err }, 'Не удалось записать аудит');
    }
  });

  // ------------------------------------------------------------ REST из OpenAPI
  // Журнал до действия: обёртка работает после проверки токена (preHandler маршрута),
  // поэтому пользователь уже известен. Не записался журнал — обработчик не выполняется.
  const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  const withAudit =
    (operationId: string, handler: Handler): Handler =>
    async (req, reply) => {
      if (MUTATING.has(req.method)) {
        const params = (req.params ?? {}) as Record<string, string>;
        req.auditId = auditStart(db, {
          user_id: req.user?.sub ?? null,
          user_role: req.user?.role ?? null,
          action: operationId,
          object_id: params.object_id ?? null,
          entity_id: params.process_id ?? params.finding_id ?? params.file_id ?? null,
          ip_address: req.ip,
          user_agent: (req.headers['user-agent'] as string) ?? null,
        });
      }
      return handler(req, reply);
    };
  const handlers: Record<string, Handler> = { ...coreHandlers(ctx), ...protocolHandlers(ctx), ...adminHandlers(ctx), ...integrationHandlers(ctx), ...mlHandlers(ctx) };
  const spec = JSON.parse(readFileSync(path.join(config.contractsDir, 'inspector-api.v1.json'), 'utf8'));
  await app.register(openapiGlue, {
    specification: spec,
    // Типы библиотеки требуют полный RouteOptions, но в рантайме частичные опции сливаются с маршрутом (index.js)
    operationResolver: ((operationId: string) => {
      const handler = handlers[operationId] && withAudit(operationId, handlers[operationId]);
      if (operationId === 'uploadDocuments' || operationId === 'uploadRegistry' || operationId === 'attachSignature') {
        // multipart разбирается в обработчике потоково (лимиты 50/200 МБ), тело не валидируем схемой
        return { handler, schema: { operationId, tags: ['documents'], params: { type: 'object', properties: { file_id: { type: 'string' } } } } };
      }
      if (handler) return handler;
      return async () => {
        throw new ApiError(501, 'NOT_IMPLEMENTED', `Операция ${operationId} ещё не реализована (${PLANNED[operationId] ?? 'в плане'})`);
      };
    }) as unknown as FastifyOpenapiGlueOptions['operationResolver'],
    securityHandlers: {
      async bearerAuth(req: import('fastify').FastifyRequest) {
        await req.jwtVerify();
      },
      // mTLS для внешних ИС (REQ-INT-02) — в локальном режиме принимаем тот же JWT
      async mtls(req: import('fastify').FastifyRequest) {
        await req.jwtVerify();
      },
    },
  });

  // ------------------------------------------ внутренний callback от ml (HTTP-транспорт)
  const validators = {
    'ml.parse.result': validator.schema('events', 'ParseResult'),
    'ml.compare.result': validator.schema('events', 'CompareResult'),
  };
  const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  // CompareResult несёт все проверки, гипотезы и пары листов комплекта — больше 1 МиБ Fastify по умолчанию
  // (413, результат забирал только reconcile с опозданием). Приём внутренний: токен или loopback.
  app.post('/internal/ml/results', { bodyLimit: ML_RESULT_MAX_BYTES }, async (req, reply) => {
    const token = req.headers['x-internal-token'];
    const trusted = config.internalToken ? token === config.internalToken : LOOPBACK.has(req.ip);
    if (!trusted) return reply.code(403).send({ code: 'FORBIDDEN', message: 'Доступ к внутреннему API запрещён' });
    const env = req.body as Envelope;
    const payloadValidator = validators[env?.type as 'ml.parse.result' | 'ml.compare.result'];
    if (!payloadValidator) {
      return reply.code(400).send({ code: 'VALIDATION_ERROR', message: `Неизвестный тип сообщения: ${env?.type}` });
    }
    if (!payloadValidator(env.payload)) {
      // ml повторит отправку и сдастся — без этой записи причину не найти
      req.log.warn({ type: env.type, message_id: env.message_id, errors: payloadValidator.errors }, 'Сообщение ml не соответствует контракту');
      return reply.code(400).send({ code: 'VALIDATION_ERROR', message: 'Сообщение не соответствует контракту', details: { errors: payloadValidator.errors } });
    }
    await orchestrator.handleEnvelope(env);
    return reply.code(204).send();
  });

  // ------------------------------- MLflow за Caddy: forward_auth на каждый запрос /mlflow/*
  // Caddy сам MLflow не защищает: спрашивает здесь. Сессию выдаёт POST /admin/mlflow/session
  // (cookie на путь /mlflow), наружу /internal/* Caddy не отдаёт — сюда он ходит напрямую.
  app.get('/internal/auth/mlflow', async (req, reply) => {
    if (!ctx.mlflow.enabled) return reply.code(404).send({ code: 'NOT_FOUND', message: 'MLflow на этом стенде выключен' });
    const session = verifySession(config.jwtSecret, cookieValue(req.headers.cookie, MLFLOW_COOKIE));
    if (!session) {
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Откройте MLflow из админки «Инспектора ИИ»: вход только для администратора и ML-инженера' });
    }
    return reply.code(204).send();
  });

  // --------------------------------------------------------------- таймауты ML
  const sweepTimer = setInterval(() => {
    orchestrator.sweep().catch((err) => app.log.error({ err }, 'Ошибка проверки таймаутов ML'));
  }, config.sweepIntervalMs);
  sweepTimer.unref();

  // ------------------------------------------------ обмен с внешней ИС (RIN_URL)
  ctx.integration.start();

  app.addHook('onClose', async () => {
    clearInterval(sweepTimer);
    await ctx.integration.stop();
    await orchestrator.transport.close?.();
    db.close();
  });

  return { app, ctx };
}
