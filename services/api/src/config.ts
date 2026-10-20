import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Корень репозитория: services/api/src → ../../.. (работает и из dist/). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// Локальный .env из корня репозитория (если есть). Переменные окружения процесса важнее.
const envFile = path.join(REPO_ROOT, '.env');
if (existsSync(envFile) && !process.env.INSPECTOR_SKIP_DOTENV) {
  process.loadEnvFile(envFile);
}

const str = (name: string, def: string): string => process.env[name]?.trim() || def;
const num = (name: string, def: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== '' && process.env[name] !== undefined ? v : def;
};
const bool = (name: string, def: boolean): boolean => {
  const v = process.env[name]?.trim().toLowerCase();
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v);
};
const resolvePath = (p: string): string => (path.isAbsolute(p) ? p : path.join(REPO_ROOT, p));

export type MlTransportKind = 'stub' | 'http';

export interface AppConfig {
  port: number;
  host: string;
  /** Базовый URL, по которому ml достучится до api (для reply_to). */
  publicUrl: string;
  logLevel: string;
  jwtSecret: string;
  jwtTtlSeconds: number;
  /** Ограничение неудачных попыток входа (auth/throttle.ts). */
  login: { maxFailures: number; maxFailuresPerIp: number; windowMs: number };
  /**
   * Вход без пароля под любой активной учётной записью (`OPEN_ACCESS`). Только на время экспертизы: организаторы
   * попросили открыть стенд без пароля (29.09). Роли и журнал действий остаются. По умолчанию выключен.
   */
  openAccess: boolean;
  /**
   * Сколько прокси перед api заслуживают доверия (X-Forwarded-For). 0 — адрес клиента берётся из
   * соединения: так при `npm run dev`, где api открыт напрямую и заголовок подделать может кто угодно.
   * В образах api стоит за Caddy — там 1.
   */
  trustProxy: number;
  dbPath: string;
  storageDir: string;
  contractsDir: string;
  matrixCsv: string;
  uploadMaxFileBytes: number;
  uploadMaxBatchBytes: number;
  /** Гипотезы свободного поиска ниже этой уверенности не попадают в выгрузку submission (FREE-*) — баланс precision и recall. */
  submissionFreeMinConfidence: number;
  clamav: { enabled: boolean; host: string; port: number };
  ml: {
    transport: MlTransportKind;
    url: string;
    jobTimeoutMs: number;
    maxRetries: number;
    /**
     * Сколько задача должна пробыть отправленной, прежде чем сверять её с ML: только что отданную
     * ML может ещё не успеть принять, и сверка приняла бы её за потерянную.
     */
    probeGraceMs: number;
    /** Задержка ответа заглушки — чтобы в UI был виден прогресс. */
    stubDelayMs: number;
  };
  /** MLflow с префиксом пути (`http://mlflow:5000/mlflow`) — витрина ML-контура. Пусто — выключен. */
  mlflowUrl: string;
  versions: { datasetVersion: string };
  /** Активные параметры при первом сиде (остальные из CSV — выключены); `all` — вся матрица. */
  initialActiveParams: string[];
  corsOrigin: string;
  sweepIntervalMs: number;
  /** Токен для callback от ml (заголовок x-internal-token). Пусто — принимаем только с localhost. */
  internalToken: string;
  /**
   * Куда дублировать журнал действий, кроме базы.
   * Файл — по умолчанию, вебхук и Telegram выключены: в закрытом контуре 152-ФЗ
   * отправлять действия пользователей наружу нельзя, это осознанный выбор развёртывания.
   */
  audit: {
    /** Путь к журналу в формате JSON Lines; пусто — не писать. */
    file: string;
    /** Произвольный вебхук: POST с телом записи; пусто — выключен. */
    webhookUrl: string;
    /** Telegram-бот: токен и чат; пусто — выключен. */
    telegramToken: string;
    telegramChat: string;
  };
  /** Папка на сервере, из которой разрешён импорт комплектов (POST /documents/import). */
  importRoot: string;
  /** Пароль демо-пользователей при первом запуске; пусто — пароль совпадает с логином (только для разработки). */
  demoPassword: string;
  /** Обмен с внешней ИС надзора (ИАИС «РиН»), API — contracts/openapi/rin-external.v1.yaml. */
  rin: {
    /** Базовый URL внешней ИС; пусто — интеграция выключена. */
    url: string;
    /** Bearer-токен, выданный нам внешней ИС (мок клиентского сертификата УКЭП). */
    token: string;
    /** Общий секрет подписи запросов (x-signature = HMAC-SHA256 тела). */
    secret: string;
    /** Название системы в сообщениях (в ТЗ — ИАИС «РиН», на встрече — «ИАС СТРИН»). */
    systemName: string;
    /** Период автозабора пакетов документов, с; 0 — только вручную (POST /integration/pull). */
    pollIntervalS: number;
    /** Отправлять результаты сразу после финализации. */
    autoPush: boolean;
    /** Паузы перед повторами отправки, с (REQ-INT-03: 1, 5 и 15 минут). */
    retryDelaysS: number[];
    timeoutMs: number;
    /** Как часто проверять очередь отправки, мс. */
    outboxTickMs: number;
    /** Предел одного файла пакета, байт: больше — пакет не принимается. */
    maxFileBytes: number;
    /** Предел пакета целиком, байт: пакет скачивается на диск стенда, и без предела его заполнит один пакет. */
    maxPackageBytes: number;
  };
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const port = num('API_PORT', 3000);
  const transport = str('ML_TRANSPORT', bool('ML_STUB', true) ? 'stub' : 'http') as MlTransportKind;
  const base: AppConfig = {
    port,
    host: str('API_HOST', '127.0.0.1'),
    publicUrl: str('API_PUBLIC_URL', `http://localhost:${port}`),
    logLevel: str('LOG_LEVEL', 'info'),
    jwtSecret: str('JWT_SECRET', 'change-me-dev-only'),
    jwtTtlSeconds: num('JWT_TTL_SECONDS', 8 * 3600),
    login: {
      maxFailures: num('LOGIN_MAX_FAILURES', 5),
      maxFailuresPerIp: num('LOGIN_MAX_FAILURES_PER_IP', 20),
      windowMs: num('LOGIN_WINDOW_S', 15 * 60) * 1000,
    },
    openAccess: bool('OPEN_ACCESS', false),
    trustProxy: num('TRUST_PROXY', 0),
    dbPath: resolvePath(str('DB_PATH', 'var/inspector.sqlite')),
    storageDir: resolvePath(str('STORAGE_DIR', 'var/storage')),
    contractsDir: resolvePath(str('CONTRACTS_DIR', 'contracts/dist')),
    matrixCsv: resolvePath(str('MATRIX_CSV', 'data/matrix/params.csv')),
    uploadMaxFileBytes: num('UPLOAD_MAX_FILE_MB', 50) * 1024 * 1024,
    uploadMaxBatchBytes: num('UPLOAD_MAX_BATCH_MB', 200) * 1024 * 1024,
    submissionFreeMinConfidence: num('SUBMISSION_FREE_MIN_CONFIDENCE', 0.5),
    clamav: {
      enabled: bool('CLAMAV_ENABLED', false),
      host: str('CLAMAV_HOST', 'localhost'),
      port: num('CLAMAV_PORT', 3310),
    },
    ml: {
      transport: transport === 'http' ? 'http' : 'stub',
      url: str('ML_URL', 'http://localhost:8000'),
      jobTimeoutMs: num('ML_JOB_TIMEOUT_S', 600) * 1000,
      maxRetries: num('ML_MAX_RETRIES', 2),
      probeGraceMs: num('ML_PROBE_GRACE_S', 30) * 1000,
      stubDelayMs: num('ML_STUB_DELAY_MS', 1500),
    },
    mlflowUrl: str('MLFLOW_URL', ''),
    versions: { datasetVersion: str('DATASET_VERSION', 'none') },
    initialActiveParams: str('MATRIX_ACTIVE_PARAMS', 'all')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    corsOrigin: str('CORS_ORIGIN', '*'),
    sweepIntervalMs: num('ML_SWEEP_INTERVAL_MS', 15_000),
    internalToken: str('INTERNAL_TOKEN', ''),
    audit: {
      file: str('AUDIT_FILE', ''),
      webhookUrl: str('AUDIT_WEBHOOK_URL', ''),
      telegramToken: str('AUDIT_TELEGRAM_TOKEN', ''),
      telegramChat: str('AUDIT_TELEGRAM_CHAT', ''),
    },
    importRoot: resolvePath(str('IMPORT_ROOT', 'dataset')),
    demoPassword: process.env.DEMO_PASSWORD ?? '',
    rin: {
      url: str('RIN_URL', '').replace(/\/+$/, ''),
      token: str('RIN_TOKEN', ''),
      secret: str('RIN_SECRET', ''),
      systemName: str('RIN_SYSTEM_NAME', 'ИАИС «РиН»'),
      pollIntervalS: num('RIN_POLL_INTERVAL_S', 60),
      autoPush: bool('RIN_AUTO_PUSH', true),
      retryDelaysS: str('RIN_RETRY_DELAYS_S', '60,300,900')
        .split(',')
        .map(Number)
        .filter((n) => Number.isFinite(n) && n >= 0),
      timeoutMs: num('RIN_TIMEOUT_S', 30) * 1000,
      outboxTickMs: num('RIN_OUTBOX_TICK_MS', 5000),
      maxFileBytes: num('RIN_MAX_FILE_MB', 1024) * 1024 * 1024,
      maxPackageBytes: num('RIN_MAX_PACKAGE_MB', 4096) * 1024 * 1024,
    },
  };
  return {
    ...base,
    ...overrides,
    ml: { ...base.ml, ...(overrides.ml ?? {}) },
    clamav: { ...base.clamav, ...(overrides.clamav ?? {}) },
    versions: { ...base.versions, ...(overrides.versions ?? {}) },
    rin: { ...base.rin, ...(overrides.rin ?? {}) },
  };
}
