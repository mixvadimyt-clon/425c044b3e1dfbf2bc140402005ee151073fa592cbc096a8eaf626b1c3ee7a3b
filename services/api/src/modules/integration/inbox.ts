import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import type { AppContext } from '../../context.js';
import { INTEGRATION_LOGIN } from '../../db/seed.js';
import { type Db, type Row, nowIso, parseJson } from '../../db/sqlite.js';
import { ApiError, conflict, notFound } from '../../errors.js';
import type { AuthUser, R, S } from '../../types.js';
import { CARD_ONLY_EXT, UNZIP_MAX_BYTES, expandZip } from '../archive.js';
import { type IntakeFile, type RegistryInput, intakeFiles } from '../intake.js';
import { fixMojibakeName, stageFromFolder } from '../names.js';
import { notify } from '../notify.js';
import { parseRegistry } from '../registry.js';
import { UPLOADABLE } from '../repo.js';
import { REGISTRY_MAX_BYTES } from '../upload.js';
import { DownloadTooLargeError, type RinClient, RinError } from './client.js';
import { systemEvent } from './outbox.js';

/**
 * Автозабор пакетов документов из внешней ИС (REQ-INT-06). Пакет — объект, файлы и реестр («Перечень ИД»).
 * Нет проверки у объекта — создаётся новая и запускается анализ; есть незавершённая — файлы дозагружаются в неё;
 * протокол финализирован — проверка не запускается, пакет ждёт решения инспектора (DEFERRED + уведомление).
 * Обработанные пакеты запоминаются по package_id, поэтому повторная выдача пакета внешней ИС безопасна.
 */

const sha256Of = (buf: Uint8Array) => createHash('sha256').update(buf).digest('hex');

export function mapPackage(r: Row): S['IntegrationPackage'] {
  return {
    id: r.id as string,
    package_id: r.package_id as string,
    title: (r.title as string) ?? null,
    status: r.status as S['IntegrationPackageStatus'],
    external_object_id: r.external_object_id as string,
    object_id: (r.object_id as string) ?? null,
    process_id: (r.process_id as string) ?? null,
    files_count: r.files_count as number,
    accepted_count: (r.accepted_count as number) ?? null,
    has_registry: r.has_registry === 1,
    message: (r.message as string) ?? null,
    error: (r.error as string) ?? null,
    received_at: r.received_at as string,
    applied_at: (r.applied_at as string) ?? null,
  };
}

export function listPackages(db: Db, status?: S['IntegrationPackageStatus']): S['IntegrationPackage'][] {
  const rows = status
    ? db.all('SELECT * FROM integration_inbox WHERE status = ? ORDER BY received_at DESC, rowid DESC', status)
    : db.all('SELECT * FROM integration_inbox ORDER BY received_at DESC, rowid DESC');
  return rows.map(mapPackage);
}

function technicalUser(db: Db): AuthUser {
  const u = db.get<Record<string, string>>('SELECT * FROM users WHERE login = ?', INTEGRATION_LOGIN);
  if (!u) throw new ApiError(500, 'INTEGRATION_USER_MISSING', 'Нет технического пользователя автозабора, перезапустите api');
  return { id: u.id, login: u.login, full_name: u.full_name, role: u.role as AuthUser['role'] };
}

function findOrCreateObject(db: Db, o: R['ExternalObject']): string {
  const existing = db.get<{ id: string }>('SELECT id FROM objects WHERE external_id = ? ORDER BY created_at LIMIT 1', o.object_id);
  if (existing) return existing.id;
  const id = randomUUID();
  const now = nowIso();
  db.insert('objects', {
    id,
    name: o.name,
    address: o.address ?? null,
    customer: o.customer ?? null,
    contractor: o.contractor ?? null,
    permit_number: o.permit_number ?? null,
    external_id: o.object_id,
    created_at: now,
    updated_at: now,
  });
  return id;
}

class PackageError extends Error {}

/** Скачать файлы и реестр пакета; содержимое сверяется с sha256, который указала внешняя ИС. */
async function fetchPackage(ctx: AppContext, client: RinClient, pkg: R['Package']): Promise<{ files: IntakeFile[]; registry: RegistryInput | null }> {
  const files: IntakeFile[] = [];
  const tmps: string[] = [];
  // Пределы файла и пакета. Заявленные размеры проверяем до скачивания — чтобы не тянуть
  // гигабайты зря, а при скачивании обрываем на пределе: заявленному размеру верить нельзя.
  const { maxFileBytes, maxPackageBytes } = ctx.config.rin;
  const mb = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} КБ` : `${Math.round(bytes / 1024 / 1024)} МБ`);
  const declared = pkg.files.reduce((sum, f) => sum + (f.size_bytes ?? 0), 0);
  if (declared > maxPackageBytes) {
    throw new PackageError(`пакет ${mb(declared)}, больше предела ${mb(maxPackageBytes)} (RIN_MAX_PACKAGE_MB)`);
  }
  let used = 0;
  try {
    for (const f of pkg.files) {
      const relParts = f.rel_path.split('/').filter(Boolean).map(fixMojibakeName);
      const name = relParts[relParts.length - 1] ?? fixMojibakeName(f.name);
      if ((f.size_bytes ?? 0) > maxFileBytes) {
        throw new PackageError(`файл «${f.rel_path}» ${mb(f.size_bytes)}, больше предела ${mb(maxFileBytes)} (RIN_MAX_FILE_MB)`);
      }
      const tmpPath = ctx.storage.tmpPath(randomUUID());
      tmps.push(tmpPath);
      const limit = Math.min(maxFileBytes, maxPackageBytes - used);
      let got: { sizeBytes: number; sha256: string };
      try {
        got = await client.download(f.url, tmpPath, limit);
      } catch (err) {
        if (!(err instanceof DownloadTooLargeError)) throw err;
        const which = limit < maxFileBytes ? `пакет больше предела ${mb(maxPackageBytes)} (RIN_MAX_PACKAGE_MB)` : `больше предела ${mb(maxFileBytes)} (RIN_MAX_FILE_MB)`;
        throw new PackageError(`файл «${f.rel_path}»: ${which}, скачивание остановлено`);
      }
      used += got.sizeBytes;
      if (got.sha256 !== f.sha256) {
        throw new PackageError(`файл «${f.rel_path}» повреждён при передаче: контрольная сумма не совпала с указанной во внешней ИС`);
      }
      const folderStage = relParts.slice(0, -1).map(stageFromFolder).find(Boolean) ?? null;
      files.push({
        originalName: name,
        relPath: relParts.join('/'),
        folderStage,
        tmpPath,
        sizeBytes: got.sizeBytes,
        sha256: got.sha256,
        truncated: false,
        allowCardOnly: CARD_ONLY_EXT.test(name),
      });
      if (/\.zip$/i.test(name) && got.sizeBytes <= UNZIP_MAX_BYTES) {
        try {
          const inner = expandZip(ctx.storage, readFileSync(tmpPath), { relParts, folderStage }, true);
          tmps.push(...inner.map((x) => x.tmpPath));
          files.push(...inner);
        } catch {
          ctx.log.warn({ file: f.rel_path }, 'Архив из пакета не распаковывается — остаётся карточкой');
        }
      }
    }
    let registry: RegistryInput | null = null;
    if (pkg.registry) {
      let content: Buffer;
      try {
        content = await client.downloadBuffer(pkg.registry.url, REGISTRY_MAX_BYTES);
      } catch (err) {
        if (!(err instanceof DownloadTooLargeError)) throw err;
        throw new PackageError(`реестр «${pkg.registry.name}» больше ${mb(REGISTRY_MAX_BYTES)}`);
      }
      const sha256 = sha256Of(content);
      if (sha256 !== pkg.registry.sha256) throw new PackageError(`реестр «${pkg.registry.name}» повреждён при передаче: контрольная сумма не совпала`);
      const name = fixMojibakeName(pkg.registry.name);
      registry = { ...parseRegistry(content, name), originalName: name, content, sha256 };
    }
    return { files, registry };
  } catch (err) {
    tmps.forEach((p) => rmSync(p, { force: true }));
    throw err;
  }
}

function describeError(err: unknown, systemName: string): string {
  if (err instanceof RinError) return `${systemName}: ${err.message}`;
  if (err instanceof PackageError) return `Пакет не принят: ${err.message}`;
  return (err as Error).message;
}

/** Загрузить файлы пакета в проверку: target — дозагрузка в незавершённую, null — новая проверка объекта. */
async function applyInto(
  ctx: AppContext,
  client: RinClient,
  pkg: R['Package'],
  recordId: string,
  objectId: string,
  target: string | null,
): Promise<S['IntegrationPackage']> {
  const { db, config } = ctx;
  const now = nowIso();
  try {
    const { files, registry } = await fetchPackage(ctx, client, pkg);
    const { response, accepted } = await intakeFiles(ctx, { user: technicalUser(db), processId: target, objectId, files, registry, autoStart: true });
    const how = target ? 'дозагружены в текущую проверку' : 'создана новая проверка';
    const message = `Принято файлов: ${accepted.length} из ${files.length} (${how}), анализ запущен${registry ? '' : '. Реестра в пакете нет, полнота комплекта не подтверждена'}`;
    db.update(
      'integration_inbox',
      { status: 'APPLIED', process_id: response.process_id, accepted_count: accepted.length, message, error: null, applied_at: now },
      'id = ?',
      recordId,
    );
    const object = db.get<{ name: string }>('SELECT name FROM objects WHERE id = ?', objectId);
    notify(db, {
      type: 'NEW_DOCUMENTS_AVAILABLE',
      role: 'INSPECTOR',
      process_id: response.process_id,
      object_id: objectId,
      message: `${config.rin.systemName}: пакет «${pkg.title ?? pkg.package_id}» по объекту «${object?.name ?? pkg.object.name}»: ${message.charAt(0).toLowerCase()}${message.slice(1)}.`,
    });
    systemEvent(db, 'integration_package_applied', response.process_id, { package_id: pkg.package_id, files: files.length, accepted: accepted.length, follow_up: Boolean(target) });
  } catch (err) {
    const error = describeError(err, config.rin.systemName);
    db.update('integration_inbox', { status: 'FAILED', error, message: null }, 'id = ?', recordId);
    systemEvent(db, 'integration_package_failed', null, { package_id: pkg.package_id, error }, objectId);
  }
  return mapPackage(db.get('SELECT * FROM integration_inbox WHERE id = ?', recordId)!);
}

const latestProcess = (db: Db, objectId: string) =>
  db.get('SELECT * FROM processes WHERE object_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', objectId);

/** Новый пакет: запомнить и загрузить (или отложить, если протокол объекта финализирован). null — объект занят обработкой, пакет возьмём в следующий раз. */
async function receivePackage(ctx: AppContext, client: RinClient, pkg: R['Package'], requestedBy: string | null): Promise<S['IntegrationPackage'] | null> {
  const { db, config } = ctx;
  const objectId = findOrCreateObject(db, pkg.object);
  const latest = latestProcess(db, objectId);
  const status = latest?.status as S['ProcessStatus'] | undefined;
  if (status && status !== 'FINALIZED' && !UPLOADABLE.includes(status)) {
    ctx.log.info({ package_id: pkg.package_id, process_id: latest!.id }, 'Пакет отложен до следующего опроса: идёт обработка документов объекта');
    return null;
  }
  const id = randomUUID();
  const now = nowIso();
  const deferred = status === 'FINALIZED';
  db.insert('integration_inbox', {
    id,
    package_id: pkg.package_id,
    title: pkg.title ?? null,
    external_object_id: pkg.object.object_id,
    object_id: objectId,
    process_id: deferred ? (latest!.id as string) : null,
    status: deferred ? 'DEFERRED' : 'FAILED', // FAILED — до успешной загрузки
    files_count: pkg.files.length,
    has_registry: pkg.registry ? 1 : 0,
    message: deferred ? 'Протокол проверки объекта финализирован, новая проверка не запущена. Создайте её из пакета, если документы нужно проверить' : null,
    package: JSON.stringify(pkg),
    requested_by: requestedBy,
    received_at: now,
  });
  if (!deferred) return applyInto(ctx, client, pkg, id, objectId, latest ? (latest.id as string) : null);

  notify(db, {
    type: 'NEW_DOCUMENTS_AVAILABLE',
    role: 'INSPECTOR',
    process_id: latest!.id as string,
    object_id: objectId,
    message:
      `${config.rin.systemName}: новый пакет «${pkg.title ?? pkg.package_id}» по объекту «${pkg.object.name}» (файлов: ${pkg.files.length}). ` +
      'Протокол проверки финализирован, поэтому проверка не запущена. Создайте новую проверку из пакета.',
  });
  systemEvent(db, 'integration_package_deferred', latest!.id as string, { package_id: pkg.package_id, files: pkg.files.length });
  return mapPackage(db.get('SELECT * FROM integration_inbox WHERE id = ?', id)!);
}

/** Забрать новые пакеты. Ошибка связи с внешней ИС (RinError) пробрасывается — её показывает вызывающий. */
export async function pullPackages(ctx: AppContext, client: RinClient, requestedBy: string | null): Promise<S['IntegrationPackage'][]> {
  const packages = await client.listPackages();
  const known = new Set(ctx.db.all<{ package_id: string }>('SELECT package_id FROM integration_inbox').map((r) => r.package_id));
  const received: S['IntegrationPackage'][] = [];
  for (const pkg of packages) {
    if (known.has(pkg.package_id)) continue;
    const rec = await receivePackage(ctx, client, pkg, requestedBy);
    if (rec) received.push(rec);
  }
  return received;
}

/**
 * Применить отложенный (DEFERRED) или неудавшийся (FAILED) пакет по решению инспектора: файлы скачиваются заново.
 * Протокол объекта финализирован или проверок нет — новая проверка; есть незавершённая — дозагрузка в неё.
 */
export async function applyPackage(ctx: AppContext, client: RinClient, recordId: string): Promise<S['IntegrationPackage']> {
  const { db } = ctx;
  const rec = db.get('SELECT * FROM integration_inbox WHERE id = ?', recordId);
  if (!rec) throw notFound('Пакет');
  if (rec.status === 'APPLIED') throw conflict('Пакет уже загружен в проверку', 'PACKAGE_APPLIED');
  const pkg = parseJson<R['Package'] | null>(rec.package, null);
  if (!pkg) throw conflict('Пакет повреждён: нет его описания', 'PACKAGE_BROKEN');
  const objectId = (rec.object_id as string) ?? findOrCreateObject(db, pkg.object);
  const latest = latestProcess(db, objectId);
  const status = latest?.status as S['ProcessStatus'] | undefined;
  if (status && status !== 'FINALIZED' && !UPLOADABLE.includes(status)) {
    throw conflict('Идёт обработка документов объекта, примените пакет после её завершения', 'PROCESS_LOCKED');
  }
  db.update('integration_inbox', { object_id: objectId }, 'id = ?', recordId);
  const target = status && status !== 'FINALIZED' ? (latest!.id as string) : null;
  return applyInto(ctx, client, pkg, recordId, objectId, target);
}
