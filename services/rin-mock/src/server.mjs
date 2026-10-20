// Мок внешней ИС надзора (ИАИС «РиН») по контракту contracts/openapi/rin-external.v1.yaml.
// Без зависимостей: node:http + файловая система. Пакеты документов — подпапки packagesDir,
// принятые результаты — в памяти и (если задан resultsDir) JSON-файлами на диске.
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

/** Файл метаданных пакета (объект, заголовок) — в выдачу как файл пакета не попадает. */
export const PACKAGE_META = 'package.meta.json';
/** Реестр файлов в корне пакета — по имени, как у api (modules/registry.ts::looksLikeRegistry). */
const REGISTRY_NAME = /^(document_)?(registry|manifest|реестр|перечень)[^/]*\.(csv|xlsx|json|jsonl)$/i;
const MAX_BODY = 50 * 1024 * 1024;

const hashCache = new Map();

function sha256File(full, st) {
  const key = `${full}|${st.size}|${st.mtimeMs}`;
  const cached = hashCache.get(key);
  if (cached) return cached;
  const hash = createHash('sha256');
  const fd = openSync(full, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  const digest = hash.digest('hex');
  hashCache.set(key, digest);
  return digest;
}

/** Пакеты из папки: каждая подпапка — пакет, файлы внутри (рекурсивно) — его документы. */
export function scanPackages(packagesDir) {
  if (!packagesDir || !existsSync(packagesDir)) return [];
  const packages = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const root = path.join(packagesDir, entry.name);
    if (!statSync(root).isDirectory()) continue;
    const metaPath = path.join(root, PACKAGE_META);
    const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
    const packageId = String(meta.package_id ?? entry.name);
    const files = [];
    let registry = null;
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        const st = statSync(full); // ссылки (make-package) разыменовываются
        if (st.isDirectory()) {
          walk(full);
          continue;
        }
        if (!st.isFile() || full === metaPath) continue;
        const relPath = path.relative(root, full).split(path.sep).join('/');
        const item = { name: e.name, rel_path: relPath, size_bytes: st.size, sha256: sha256File(full, st), full };
        if (!registry && dir === root && REGISTRY_NAME.test(e.name)) registry = item;
        else files.push(item);
      }
    };
    walk(root);
    const object = meta.object ?? {};
    packages.push({
      package_id: packageId,
      created_at: meta.created_at ?? statSync(root).mtime.toISOString(),
      title: meta.title ?? null,
      object: {
        object_id: String(object.object_id ?? entry.name),
        name: object.name ?? entry.name,
        address: object.address ?? null,
        customer: object.customer ?? null,
        contractor: object.contractor ?? null,
        permit_number: object.permit_number ?? null,
      },
      registry,
      files,
    });
  }
  return packages.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.package_id.localeCompare(b.package_id));
}

function publicPackage(p) {
  const url = (index) => `/api/v1/packages/${encodeURIComponent(p.package_id)}/files/${index}`;
  const strip = ({ full: _full, ...rest }, index) => ({ ...rest, url: url(index) });
  return { ...p, registry: p.registry ? strip(p.registry, 'registry') : null, files: p.files.map((f, i) => strip(f, i)) };
}

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length });
  res.end(data);
}

const error = (res, status, code, message) => sendJson(res, status, { code, message });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Слишком большое тело запроса'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function signatureOk(secret, body, header) {
  if (!secret) return true;
  if (typeof header !== 'string' || !/^[0-9a-f]{64}$/i.test(header)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(header, 'hex'));
}

/**
 * Мок внешней ИС. Опции:
 * - packagesDir — папка пакетов (подпапка = пакет, `package.meta.json` — объект и заголовок);
 * - resultsDir — куда сохранять принятые результаты (JSON), необязательно;
 * - token — ожидаемый bearer-токен (пусто — без проверки); secret — общий секрет подписи (пусто — без проверки);
 * - systemName — название системы в /health.
 * Управление для тестов и демо: `state.failNext(mode, count)`, `POST /__control/failures`.
 */
export function createRinMock(opts = {}) {
  const state = {
    /** Очередь сбоев: error — 503, timeout — нет ответа, reject — 400, corrupt — искажённое содержимое файла. */
    failures: [],
    receipts: new Map(),
    results: [],
    seq: 0,
    requests: [],
    failNext(mode, count = 1) {
      for (let i = 0; i < count; i++) this.failures.push(mode);
    },
    reset() {
      this.failures = [];
      this.receipts.clear();
      this.results = [];
      this.requests = [];
    },
  };
  const hanging = new Set();

  const takeFailure = (modes) => {
    const i = state.failures.findIndex((m) => modes.includes(m));
    return i === -1 ? null : state.failures.splice(i, 1)[0];
  };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://mock');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    state.requests.push({ method: req.method, path: url.pathname, at: new Date().toISOString() });

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { status: 'ok', system: `${opts.systemName ?? 'ИАИС «РиН»'} (мок)` });
    }

    // ---------------------------------------------------------------- управление моком
    if (parts[0] === '__control') {
      if (req.method === 'GET' && parts[1] === 'state') {
        return sendJson(res, 200, { failures: state.failures, results: state.results.length, packages_dir: opts.packagesDir ?? null });
      }
      if (req.method === 'POST' && parts[1] === 'failures') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const mode = body.mode ?? 'error';
        if (!['error', 'timeout', 'reject', 'corrupt'].includes(mode)) return error(res, 400, 'BAD_MODE', 'mode: error | timeout | reject | corrupt');
        state.failNext(mode, Number(body.count ?? 1));
        return sendJson(res, 200, { failures: state.failures });
      }
      if (req.method === 'POST' && parts[1] === 'reset') {
        state.reset();
        return sendJson(res, 200, { ok: true });
      }
      return error(res, 404, 'NOT_FOUND', 'Нет такой команды управления');
    }

    if (parts[0] !== 'api') return error(res, 404, 'NOT_FOUND', 'Не найдено');
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) {
      return error(res, 401, 'UNAUTHORIZED', 'Нет или неверный токен');
    }

    // ------------------------------------------------------------------- пакеты
    if (req.method === 'GET' && url.pathname === '/api/v1/packages') {
      const since = url.searchParams.get('since');
      const items = scanPackages(opts.packagesDir).filter((p) => !since || p.created_at > since);
      return sendJson(res, 200, { items: items.map(publicPackage) });
    }
    if (req.method === 'GET' && parts.length === 6 && parts[2] === 'packages' && parts[4] === 'files') {
      const pkg = scanPackages(opts.packagesDir).find((p) => p.package_id === parts[3]);
      const file = !pkg ? null : parts[5] === 'registry' ? pkg.registry : pkg.files[Number(parts[5])];
      if (!file) return error(res, 404, 'NOT_FOUND', 'Нет такого пакета или файла');
      if (takeFailure(['corrupt'])) {
        const data = Buffer.from('%PDF-1.4 искажено при передаче');
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length });
        return res.end(data);
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': file.size_bytes });
      createReadStream(file.full).pipe(res);
      return;
    }

    // ---------------------------------------------------------------- результаты
    if (url.pathname === '/api/v1/results' && req.method === 'GET') {
      return sendJson(res, 200, state.results.map((r) => r.receipt));
    }
    if (url.pathname === '/api/v1/results' && req.method === 'POST') {
      const body = await readBody(req);
      const failure = takeFailure(['error', 'timeout', 'reject']);
      if (failure === 'timeout') {
        hanging.add(res);
        res.on('close', () => hanging.delete(res));
        return; // не отвечаем — клиент уйдёт по таймауту
      }
      if (failure === 'error') return error(res, 503, 'UNAVAILABLE', 'Внешняя ИС временно недоступна');
      if (failure === 'reject') return error(res, 400, 'REJECTED', 'Пакет отклонён внешней ИС');
      if (!signatureOk(opts.secret, body, req.headers['x-signature'])) return error(res, 400, 'BAD_SIGNATURE', 'Подпись запроса не сходится');
      const key = req.headers['x-idempotency-key'];
      if (!key) return error(res, 400, 'NO_IDEMPOTENCY_KEY', 'Нужен заголовок x-idempotency-key');
      let result;
      try {
        result = JSON.parse(body.toString('utf8'));
      } catch {
        return error(res, 400, 'BAD_JSON', 'Тело — не JSON');
      }
      const missing = ['process_id', 'protocol_version', 'versions', 'confirmed_violations', 'input_files', 'finalized_at'].filter((k) => result?.[k] === undefined);
      if (missing.length || !Array.isArray(result.confirmed_violations) || !Array.isArray(result.input_files)) {
        return error(res, 400, 'BAD_RESULT', `Результат не по контракту InspectionResult: нет ${missing.join(', ') || 'массивов'}`);
      }
      const known = state.receipts.get(key);
      if (known) return sendJson(res, 200, { ...known, duplicate: true });
      state.seq += 1;
      const now = new Date();
      const violations = result.confirmed_violations.length;
      const receipt = {
        receipt_id: `RIN-${now.getUTCFullYear()}-${String(state.seq).padStart(5, '0')}`,
        received_at: now.toISOString(),
        process_id: result.process_id,
        protocol_version: result.protocol_version,
        confirmed_violations: violations,
        duplicate: false,
        prescription: violations > 0 ? { prescription_id: `ПР-${randomUUID().slice(0, 8).toUpperCase()}`, status: 'ISSUED' } : null,
      };
      state.receipts.set(key, receipt);
      state.results.push({ key, receipt, result, signature: req.headers['x-signature'] ?? null });
      if (opts.resultsDir) {
        mkdirSync(opts.resultsDir, { recursive: true });
        writeFileSync(path.join(opts.resultsDir, `${receipt.receipt_id}.json`), JSON.stringify({ key, receipt, result }, null, 2));
      }
      return sendJson(res, 201, receipt);
    }
    return error(res, 404, 'NOT_FOUND', 'Не найдено');
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) error(res, err.status ?? 500, 'INTERNAL', err.message);
    });
  });

  return {
    server,
    state,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const addr = server.address();
          resolve(`http://${host}:${addr.port}`);
        });
      });
    },
    close() {
      for (const res of hanging) res.destroy();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
