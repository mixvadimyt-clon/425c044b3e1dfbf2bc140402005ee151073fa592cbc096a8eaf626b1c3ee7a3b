import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyPassword } from '../auth/passwords.js';
import { LoginThrottle } from '../auth/throttle.js';
import { type AppContext, type Handlers, currentUser, paging, requireRole } from '../context.js';
import { type Row, nowIso } from '../db/sqlite.js';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { CARD_ONLY_EXT, UNZIP_MAX_BYTES, expandZip, unpackUpload } from '../modules/archive.js';
import { type IntakeFile, type RegistryInput, applyRegistry, intakeFiles, refreshCompleteness } from '../modules/intake.js';
import { fixMojibakeName, stageFromFolder } from '../modules/names.js';
import {
  getFileRow,
  getObject,
  getProcessInfo,
  getProcessRow,
  getProcessStatus,
  listFiles,
  mapFile,
  mapObject,
  stageOfFile,
} from '../modules/repo.js';
import { looksLikeRegistry, parseManifestJson, parseRegistry } from '../modules/registry.js';
import { type RegistryUpload, type UploadFields, receiveMultipart } from '../modules/upload.js';
import type { ProcessStatus, S } from '../types.js';
const OPERATORS = ['INSPECTOR', 'SUPERVISOR', 'ADMIN'] as const;

/** Открепленная подпись — маленький файл; всё, что больше, приложено по ошибке. */
const SIGNATURE_MAX_BYTES = 256 * 1024;
const SIGNATURE_EXT = /\.(sig|p7s|sgn)$/i;

const sha256Of = (buf: Buffer | Uint8Array) => createHash('sha256').update(buf).digest('hex');

/** «14 мин», «1 мин» — для сообщения о закрытом входе; меньше минуты округляем вверх. */
const minutes = (seconds: number) => `${Math.max(1, Math.ceil(seconds / 60))} мин`;

/** Реестр из формы: файл registry (CSV/XLSX/JSON) важнее JSON-строки manifest. */
function registryFromForm(fields: UploadFields, file: RegistryUpload | null): RegistryInput | null {
  if (file) {
    const parsed = parseRegistry(file.buffer, file.originalName);
    return { ...parsed, originalName: file.originalName, content: file.buffer, sha256: file.sha256 };
  }
  if (fields.manifest) {
    const content = Buffer.from(fields.manifest, 'utf8');
    return { format: 'JSON', manifest: parseManifestJson(fields.manifest), originalName: null, content, sha256: sha256Of(content) };
  }
  return null;
}

export function coreHandlers(ctx: AppContext): Handlers {
  const { db, config, storage, orchestrator } = ctx;
  const loginThrottle = new LoginThrottle(config.login);

  /** Строка объекта; убранный объект снаружи не существует — 404, как и отсутствующий. */
  const objectRow = (objectId: string): Row => {
    const row = db.get<Row>('SELECT * FROM objects WHERE id = ? AND archived_at IS NULL', objectId);
    if (!row) throw notFound('Объект');
    return row;
  };

  return {
    // ------------------------------------------------------------------ system
    async getHealth() {
      let dbOk: 'ok' | 'down' = 'ok';
      try {
        db.get('SELECT 1');
      } catch {
        dbOk = 'down';
      }
      return {
        status: dbOk === 'ok' ? 'ok' : 'down',
        version: process.env.npm_package_version ?? '0.1.0',
        dependencies: { db: dbOk, storage: storage.exists('raw') ? 'ok' : 'down' },
      } satisfies S['Health'];
    },

    // -------------------------------------------------------------------- auth
    async login(req: FastifyRequest, reply: FastifyReply) {
      const body = req.body as S['LoginRequest'];
      // До проверки пароля: закрытый вход не тратит время на хеш и не подсказывает, верен ли пароль
      const wait = loginThrottle.retryAfter(body.login, req.ip);
      if (wait > 0) {
        req.audit = { details: { login: body.login, success: false, blocked: true } };
        reply.header('retry-after', String(wait));
        throw new ApiError(429, 'TOO_MANY_LOGIN_ATTEMPTS', `Слишком много неудачных попыток входа. Повторите через ${minutes(wait)}.`, {
          retry_after_s: wait,
        });
      }
      const user = db.get<Record<string, string | number>>('SELECT * FROM users WHERE login = ? AND is_active = 1', body.login);
      // Открытый вход (OPEN_ACCESS, на время экспертизы): пароль не проверяется, учётная запись — должна быть
      if (!user || (!config.openAccess && !(await verifyPassword(body.password, user.password_hash as string)))) {
        loginThrottle.fail(body.login, req.ip);
        req.audit = { details: { login: body.login, success: false } };
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'Неверный логин или пароль');
      }
      loginThrottle.succeed(body.login, req.ip);
      const payload = { sub: user.id as string, login: user.login as string, full_name: user.full_name as string, role: user.role as S['UserRole'] };
      const token = await reply.jwtSign(payload, { expiresIn: config.jwtTtlSeconds });
      req.user = payload;
      req.audit = {
        entity_type: 'user',
        entity_id: payload.sub,
        details: { login: payload.login, success: true, ...(config.openAccess ? { open_access: true } : {}) },
      };
      return {
        access_token: token,
        expires_in: config.jwtTtlSeconds,
        user: { id: payload.sub, login: payload.login, full_name: payload.full_name, role: payload.role },
      } satisfies S['LoginResponse'];
    },

    async getAuthOptions() {
      if (!config.openAccess) return { open_access: false, accounts: [] } satisfies S['AuthOptions'];
      const order: S['UserRole'][] = ['INSPECTOR', 'SUPERVISOR', 'ADMIN', 'ML_ENGINEER'];
      const accounts = db
        .all<{ login: string; full_name: string; role: S['UserRole'] }>('SELECT login, full_name, role FROM users WHERE is_active = 1 ORDER BY login')
        .sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
      return { open_access: true, accounts } satisfies S['AuthOptions'];
    },

    async getMe(req) {
      const u = currentUser(req);
      return { id: u.id, login: u.login, full_name: u.full_name, role: u.role } satisfies S['User'];
    },

    // ----------------------------------------------------------------- objects
    async listObjects(req) {
      const q = req.query as { page?: number; page_size?: number; indicator?: string; process_status?: string; section?: string; date_from?: string; date_to?: string; q?: string };
      const { page, pageSize, offset } = paging(q);
      const where: string[] = [];
      const args: string[] = [];
      if (q.q) {
        where.push('(name LIKE ? OR address LIKE ? OR permit_number LIKE ?)');
        args.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
      }
      if (q.date_from) {
        where.push('updated_at >= ?');
        args.push(q.date_from);
      }
      if (q.date_to) {
        where.push('substr(updated_at, 1, 10) <= ?');
        args.push(q.date_to);
      }
      where.push('archived_at IS NULL');  // убранные объекты в списке не показываем
      const rows = db.all(`SELECT * FROM objects WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`, ...args);
      let items = rows.map((r) => mapObject(db, r));
      if (q.indicator) items = items.filter((o) => o.indicator === q.indicator);
      if (q.process_status) items = items.filter((o) => o.last_process_status === q.process_status);
      if (q.section) {
        const withSection = new Set(
          db
            .all<{ object_id: string }>(
              `SELECT DISTINCT c.object_id FROM checks c JOIN params p ON p.code = c.param_code
               JOIN processes pr ON pr.current_protocol_id = c.protocol_id
               WHERE p.section = ? AND c.finding_status IN ('CANDIDATE','CONFIRMED_VIOLATION')`,
              q.section,
            )
            .map((r) => r.object_id),
        );
        items = items.filter((o) => withSection.has(o.id));
      }
      return { items: items.slice(offset, offset + pageSize), total: items.length, page, page_size: pageSize } satisfies S['ObjectPage'];
    },

    async createObject(req, reply) {
      requireRole(req, ...OPERATORS);
      const body = req.body as S['ObjectCreate'];
      if (!body.name?.trim()) throw badRequest('Укажите наименование объекта');
      const id = randomUUID();
      const now = nowIso();
      db.insert('objects', {
        id,
        created_by: currentUser(req)?.id ?? null,
        name: body.name.trim(),
        address: body.address ?? null,
        customer: body.customer ?? null,
        contractor: body.contractor ?? null,
        permit_number: body.permit_number ?? null,
        external_id: body.external_id ?? null,
        created_at: now,
        updated_at: now,
      });
      req.audit = { object_id: id, entity_type: 'object', entity_id: id, details: { name: body.name } };
      reply.code(201);
      return getObject(db, id);
    },

    async getObject(req) {
      const { object_id } = req.params as { object_id: string };
      objectRow(object_id);  // убранный объект снаружи выглядит удалённым
      return getObject(db, object_id);
    },

    async patchObject(req) {
      requireRole(req, ...OPERATORS);
      const { object_id } = req.params as { object_id: string };
      const body = (req.body ?? {}) as S['ObjectPatch'];
      objectRow(object_id);
      // Реквизиты уже вошли в финализированный протокол и в выгрузку во внешнюю ИС — расходиться им нельзя
      const last = db.get<{ status: string }>(
        'SELECT status FROM processes WHERE object_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
        object_id,
      );
      if (last?.status === 'FINALIZED') {
        throw conflict('Проверка финализирована: реквизиты объекта уже вошли в протокол', 'PROCESS_FINALIZED');
      }

      const text = (value: string | null | undefined): string | null => (value?.trim() ? value.trim() : null);
      const patch: Record<string, string | null> = {};
      if (body.name !== undefined) {
        if (!body.name?.trim()) throw badRequest('Наименование объекта не может быть пустым');
        patch.name = body.name.trim();
      }
      for (const field of ['address', 'customer', 'contractor', 'permit_number', 'external_id'] as const) {
        if (body[field] !== undefined) patch[field] = text(body[field]);
      }
      if (Object.keys(patch).length === 0) throw badRequest('Нет изменений');

      db.update('objects', { ...patch, updated_at: nowIso() }, 'id = ?', object_id);
      req.audit = { object_id, entity_type: 'object', entity_id: object_id, details: { fields: Object.keys(patch) } };
      return getObject(db, object_id);
    },

    async deleteObject(req, reply) {
      const user = requireRole(req, ...OPERATORS);
      const { object_id } = req.params as { object_id: string };
      const row = objectRow(object_id);
      // Инспектор убирает только свои объекты. У объектов, созданных до появления поля, автора нет —
      // такие считаем общими, иначе старые демо-проекты стало бы некому убрать.
      const owner = (row.created_by as string) ?? null;
      if (user.role === 'INSPECTOR' && owner && owner !== user.id) {
        throw forbidden('Инспектор может убрать только объект, который создал сам');
      }
      const now = nowIso();
      db.update('objects', { archived_at: now, archived_by: user.id, updated_at: now }, 'id = ?', object_id);
      req.audit = { object_id, entity_type: 'object', entity_id: object_id, details: { name: row.name as string } };
      reply.code(204);
      return null;
    },

    // --------------------------------------------------------------- documents
    async attachSignature(req) {
      const user = requireRole(req, ...OPERATORS);
      const { file_id } = req.params as { file_id: string };
      const file = getFileRow(db, file_id);
      const proc = getProcessRow(db, file.process_id as string);
      if (proc.status === 'FINALIZED') throw conflict('Проверка финализирована', 'PROCESS_FINALIZED');

      const part = await req.file({ limits: { fileSize: SIGNATURE_MAX_BYTES + 1 } });
      if (!part || part.fieldname !== 'signature') throw badRequest('Приложите файл подписи в поле signature');
      if (!SIGNATURE_EXT.test(part.filename)) {
        throw badRequest('Ожидается открепленная подпись: .sig, .p7s или .sgn', { file_name: part.filename });
      }

      const tmpPath = storage.tmpPath(randomUUID());
      const hash = createHash('sha256');
      let size = 0;
      await pipeline(
        part.file,
        new Transform({
          transform(chunk, _enc, done) {
            size += chunk.length;
            hash.update(chunk);
            done(null, chunk);
          },
        }),
        createWriteStream(tmpPath),
      );
      if (part.file.truncated || size > SIGNATURE_MAX_BYTES) {
        rmSync(tmpPath, { force: true });
        throw new ApiError(413, 'SIGNATURE_TOO_LARGE', `Файл подписи больше ${SIGNATURE_MAX_BYTES / 1024} КБ`);
      }
      const sha256 = hash.digest('hex');
      storage.commit(tmpPath, `signatures/${sha256}`);

      db.update(
        'files',
        {
          signature_name: part.filename,
          signature_sha256: sha256,
          signature_size_bytes: size,
          signature_uploaded_at: nowIso(),
          signature_uploaded_by: user.id,
        },
        'id = ?',
        file_id,
      );
      req.audit = {
        object_id: file.object_id as string,
        entity_type: 'file',
        entity_id: file_id,
        details: { signature: part.filename, sha256, size_bytes: size, verification: 'NOT_VERIFIED' },
      };
      return mapFile(getFileRow(db, file_id));
    },

    async uploadDocuments(req, reply) {
      const user = requireRole(req, ...OPERATORS);
      const received = await receiveMultipart(req, storage, config);
      const { fields, registry: registryFile } = received;
      // архив и папка целиком: содержимое — отдельными файлами, реестр из корня — реестром
      const { files, registry: foundRegistry } = unpackUpload(storage, received.files);
      const discard = () => files.forEach((f) => rmSync(f.tmpPath, { force: true }));
      let hints: Record<string, string> = {};
      let registry: RegistryInput | null = null;
      try {
        hints = fields.stage_hints ? (JSON.parse(fields.stage_hints) as Record<string, string>) : {};
      } catch {
        discard();
        throw badRequest('Поле stage_hints должно быть JSON-объектом {"имя файла": "PD|RD|ID"}');
      }
      try {
        registry = registryFromForm(fields, registryFile) ?? registryFromForm({}, foundRegistry);
      } catch (err) {
        discard();
        throw err;
      }
      const { response, objectId, accepted } = await intakeFiles(ctx, {
        user,
        processId: fields.process_id ?? null,
        objectId: fields.object_id ?? null,
        files,
        hints,
        registry,
        autoStart: fields.auto_start !== 'false',
      });
      req.audit = {
        object_id: objectId,
        entity_type: 'process',
        entity_id: response.process_id,
        details: {
          accepted: accepted.length,
          rejected: response.files.filter((r) => r.status === 'REJECTED').map((r) => ({ name: r.original_name, code: r.error?.code })),
          registry: registry ? { format: registry.format, name: registry.originalName, entries: registry.manifest.files?.length ?? 0 } : null,
          auto_start: fields.auto_start !== 'false',
        },
      };
      reply.code(202);
      return response;
    },

    async importDocuments(req, reply) {
      const user = requireRole(req, ...OPERATORS);
      const body = req.body as S['ImportRequest'];
      const fixNames = body.fix_names !== false;
      let root: string;
      try {
        root = realpathSync(config.importRoot);
      } catch {
        throw notFound('Папка импорта (IMPORT_ROOT)');
      }
      // путь может быть указан «исправленными» именами — сопоставляем сегменты с реальными (испорченными) именами на диске
      let dir = root;
      for (const seg of body.path.split(/[\\/]+/).filter((x) => x && x !== '.')) {
        if (seg === '..') throw forbidden('Путь вне разрешённой папки импорта');
        const entry = readdirSync(dir).find((name) => name === seg || (fixNames && fixMojibakeName(name) === seg.normalize('NFC')));
        if (!entry) throw notFound(`Папка «${seg}»`);
        dir = path.join(dir, entry);
      }
      dir = realpathSync(dir);
      if (dir !== root && !dir.startsWith(root + path.sep)) throw forbidden('Путь вне разрешённой папки импорта');
      if (!statSync(dir).isDirectory()) throw badRequest('Указанный путь не папка');

      let objectId = body.object_id ?? null;
      if (!objectId && !body.process_id) {
        const name = body.object_name?.trim() || (fixNames ? fixMojibakeName(path.basename(dir)) : path.basename(dir));
        objectId = randomUUID();
        const now = nowIso();
        db.insert('objects', { id: objectId, name, external_id: body.external_id ?? null, created_at: now, updated_at: now });
      }

      // реестр: явный путь или автопоиск в корне папки (registry.* / реестр* / manifest*)
      let registry: RegistryInput | null = null;
      let registryFull: string | null = null;
      if (body.registry_path) {
        try {
          registryFull = realpathSync(path.resolve(dir, body.registry_path));
        } catch {
          throw notFound(`Файл реестра «${body.registry_path}»`);
        }
        if (!registryFull.startsWith(dir + path.sep)) throw forbidden('Реестр должен лежать внутри импортируемой папки');
      } else {
        const found = readdirSync(dir).find((name) => looksLikeRegistry(fixNames ? fixMojibakeName(name) : name));
        if (found) registryFull = path.join(dir, found);
      }
      if (registryFull) {
        const content = readFileSync(registryFull);
        const name = fixNames ? fixMojibakeName(path.basename(registryFull)) : path.basename(registryFull);
        registry = { ...parseRegistry(content, name), originalName: name, content, sha256: sha256Of(content) };
      } else if (body.manifest) {
        const content = Buffer.from(JSON.stringify(body.manifest), 'utf8');
        registry = { format: 'JSON', manifest: parseManifestJson(content.toString('utf8')), originalName: null, content, sha256: sha256Of(content) };
      }

      const files: IntakeFile[] = [];
      const walk = async (current: string) => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          if (entry.name.startsWith('.')) continue;
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) {
            await walk(full);
            continue;
          }
          if (!entry.isFile() || full === registryFull) continue;
          const relParts = path.relative(dir, full).split(path.sep).map((x) => (fixNames ? fixMojibakeName(x) : x));
          const folderStage = relParts.slice(0, -1).map(stageFromFolder).find(Boolean) ?? stageFromFolder(fixNames ? fixMojibakeName(path.basename(dir)) : path.basename(dir));
          const tmpPath = storage.tmpPath(randomUUID());
          const hash = createHash('sha256');
          let size = 0;
          await pipeline(
            createReadStream(full),
            new Transform({
              transform(chunk: Buffer, _e, cb) {
                size += chunk.length;
                hash.update(chunk);
                cb(null, chunk);
              },
            }),
            createWriteStream(tmpPath),
          );
          files.push({
            originalName: relParts[relParts.length - 1],
            relPath: relParts.join('/'),
            folderStage: folderStage ?? null,
            tmpPath,
            sizeBytes: size,
            sha256: hash.digest('hex'),
            truncated: false,
            allowCardOnly: CARD_ONLY_EXT.test(entry.name),
          });
          // .zip: сам архив — карточкой, содержимое — отдельными файлами с путём «архив/файл»
          if (/\.zip$/i.test(entry.name) && size <= UNZIP_MAX_BYTES) {
            try {
              files.push(...expandZip(storage, readFileSync(full), { relParts, folderStage: folderStage ?? null }, fixNames));
            } catch {
              req.log.warn({ file: relParts.join('/') }, 'Архив не распаковывается — остаётся карточкой');
            }
          }
        }
      };
      await walk(dir);
      const { response, objectId: objId, accepted } = await intakeFiles(ctx, {
        user,
        processId: body.process_id ?? null,
        objectId,
        files,
        registry,
        autoStart: body.auto_start !== false,
      });
      req.audit = {
        object_id: objId,
        entity_type: 'process',
        entity_id: response.process_id,
        details: { path: body.path, accepted: accepted.length, registry: registry?.originalName ?? (registry ? 'manifest' : null) },
      };
      reply.code(202);
      return response;
    },

    async listProcessFiles(req) {
      const { process_id } = req.params as { process_id: string };
      getProcessRow(db, process_id);
      return listFiles(db, process_id);
    },

    async getFile(req) {
      const { file_id } = req.params as { file_id: string };
      const row = getFileRow(db, file_id);
      return listFiles(db, row.process_id as string).find((f) => f.id === file_id) ?? mapFile(row);
    },

    async updateFileMetadata(req) {
      const user = requireRole(req, 'INSPECTOR', 'SUPERVISOR', 'ADMIN');
      const { file_id } = req.params as { file_id: string };
      const body = req.body as S['FileMetadataPatch'] & Record<string, unknown>;
      const extra = Object.keys(body).filter((k) => !['is_authoritative', 'predecessor_id', 'comment', 'reference'].includes(k));
      if (extra.length) {
        throw badRequest(
          'Метаданные документа исправлять нельзя: доступен только выбор авторитетной редакции с основанием',
          { fields: extra },
          'METADATA_READONLY',
        );
      }
      if (body.is_authoritative === undefined && body.predecessor_id === undefined) throw badRequest('Нет изменений');
      const row = getFileRow(db, file_id);
      const proc = getProcessRow(db, row.process_id as string);
      if (proc.status === 'FINALIZED') throw conflict('Протокол финализирован, изменение невозможно', 'PROCESS_FINALIZED');
      if (proc.status === 'PARSING') throw conflict('Идёт обработка документов, повторите позже', 'PROCESS_LOCKED');
      if (body.predecessor_id) {
        if (body.predecessor_id === file_id) throw badRequest('Файл не может быть предшественником самого себя');
        const pred = db.get('SELECT process_id FROM files WHERE id = ?', body.predecessor_id);
        if (!pred || pred.process_id !== row.process_id) throw badRequest('Предшественник должен быть файлом этой же проверки');
      }
      const basis = `${body.comment.trim()}${body.reference ? ` (основание: ${body.reference})` : ''}. ${user.full_name}, ${nowIso()}`;
      const changes: Record<string, string | number | null> = { authoritative_basis: basis };
      if (body.predecessor_id !== undefined) changes.predecessor_id = body.predecessor_id ?? null;
      if (body.is_authoritative !== undefined) changes.is_authoritative = body.is_authoritative === null ? null : body.is_authoritative ? 1 : 0;
      db.update('files', changes, 'id = ?', file_id);
      req.audit = {
        object_id: row.object_id as string,
        entity_type: 'file',
        entity_id: file_id,
        details: { is_authoritative: body.is_authoritative, predecessor_id: body.predecessor_id, comment: body.comment, reference: body.reference },
      };
      refreshCompleteness(ctx, row.process_id as string);
      // Пересчёт затронутых параметров (REQ-PRS-09): только если протокол уже есть
      if (proc.current_protocol_id && row.processing_status === 'PARSED') {
        await orchestrator.startAnalysis(row.process_id as string, { trigger: 'METADATA_CHANGE', changedFileIds: [file_id] });
      }
      return listFiles(db, row.process_id as string).find((f) => f.id === file_id)!;
    },

    async uploadRegistry(req) {
      const user = requireRole(req, ...OPERATORS);
      const { process_id } = req.params as { process_id: string };
      const proc = getProcessRow(db, process_id);
      const { fields, files, registry: registryFile } = await receiveMultipart(req, storage, config);
      files.forEach((f) => rmSync(f.tmpPath, { force: true }));
      if (files.length) throw badRequest('Документы загружаются через /documents/upload, здесь только реестр', undefined, 'REGISTRY_INVALID');
      const registry = registryFromForm(fields, registryFile);
      if (!registry) throw badRequest('Передайте файл реестра (поле registry) или JSON (поле manifest)', undefined, 'REGISTRY_INVALID');
      const result = await applyRegistry(ctx, process_id, registry, user, fields.auto_start !== 'false');
      req.audit = {
        object_id: proc.object_id as string,
        entity_type: 'process',
        entity_id: process_id,
        details: { registry: registry.originalName, format: registry.format, entries: result.entries_total, matched: result.matched_files },
      };
      return result;
    },

    async getFileContent(req, reply) {
      const { file_id } = req.params as { file_id: string };
      const row = getFileRow(db, file_id);
      const types: Record<string, string> = {
        PDF: 'application/pdf',
        DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        XML: 'application/xml',
      };
      reply
        .header('content-type', types[row.format as string] ?? 'application/octet-stream')
        .header('content-length', String(storage.size(row.file_path as string)))
        .header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(row.original_name as string)}`)
        .header('cache-control', 'private, max-age=86400, immutable')
        .header('etag', `"${row.file_hash as string}"`);
      return reply.send(storage.stream(row.file_path as string));
    },

    // --------------------------------------------------------------- processes
    async listProcesses(req) {
      const q = req.query as { page?: number; page_size?: number; object_id?: string; status?: string };
      const { page, pageSize, offset } = paging(q);
      const where: string[] = [];
      const args: string[] = [];
      if (q.object_id) {
        where.push('object_id = ?');
        args.push(q.object_id);
      }
      if (q.status) {
        where.push('status = ?');
        args.push(q.status);
      }
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM processes ${w}`, ...args)!.n;
      const rows = db.all<{ id: string }>(`SELECT id FROM processes ${w} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`, ...args, pageSize, offset);
      return { items: rows.map((r) => getProcessInfo(db, r.id)), total, page, page_size: pageSize } satisfies S['ProcessPage'];
    },

    async getProcess(req) {
      const { process_id } = req.params as { process_id: string };
      return getProcessInfo(db, process_id);
    },

    async getProcessStatus(req) {
      const { process_id } = req.params as { process_id: string };
      return getProcessStatus(db, process_id);
    },

    async startProcess(req, reply) {
      requireRole(req, ...OPERATORS);
      const { process_id } = req.params as { process_id: string };
      const proc = getProcessRow(db, process_id);
      await orchestrator.startAnalysis(process_id, { trigger: proc.current_protocol_id ? 'MANUAL_RERUN' : 'INITIAL' });
      req.audit = { object_id: proc.object_id as string, entity_type: 'process', entity_id: process_id };
      reply.code(202);
      return getProcessStatus(db, process_id);
    },
  };
}

