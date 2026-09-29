import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import type { AppContext } from '../context.js';
import type { Db, Row } from '../db/sqlite.js';
import { nowIso, parseJson } from '../db/sqlite.js';
import { ApiError, badRequest, conflict, notFound } from '../errors.js';
import type { AuthUser, DocStage, ProcessStatus, S } from '../types.js';
import type { RegistryFormat } from './registry.js';
import { UPLOADABLE, activeRegistry, completenessOf, completenessSummary, getProcessRow, listFiles } from './repo.js';
import { computeScenario, entryKey, guessDiscipline, guessDocumentCode, guessRevision, guessStage } from './stages.js';
import { type ReceivedFile, type UploadErrorCode, checkFile, uploadMessages } from './upload.js';

/**
 * Приём файлов в проверку — общий для загрузки через интерфейс и серверного импорта.
 * Приоритет метаданных: реестр файлов → явная подсказка пользователя → папка комплекта → имя файла (ML уточнит позже).
 * Реестр обязателен по «Перечню ИД» ред. 1.1: без него комплект получает статус полноты CLARIFICATION_REQUIRED.
 */
export interface IntakeFile extends ReceivedFile {
  /**
   * Серверный импорт: файл неподдерживаемого формата (архив, DWG…) принимается карточкой — формат OTHER,
   * статус SKIPPED, без анализа. Так строка реестра закрыта, а полнота не блокируется (у организаторов FORMAT_CARD_ONLY).
   */
  allowCardOnly?: boolean;
  /** Отказ, известный до проверки формата: например, архив из формы не распаковался. */
  rejection?: { code: UploadErrorCode; message: string };
}

export interface RegistryInput {
  format: RegistryFormat;
  manifest: S['UploadManifest'];
  originalName: string | null;
  /** Исходные байты реестра — сохраняются в хранилище для аудита. */
  content: Buffer;
  sha256: string;
}

export interface IntakeOptions {
  user: AuthUser;
  processId?: string | null;
  objectId?: string | null;
  files: IntakeFile[];
  hints?: Record<string, string>;
  registry?: RegistryInput | null;
  autoStart: boolean;
}

type Entry = S['ManifestFile'];
const STAGES: DocStage[] = ['PD', 'RD', 'ID'];

/**
 * Строка реестра для файла. Контрольная сумма точнее имени: одинаково названные файлы разных стадий
 * («Общие данные.pdf» в ПД и РД) не должны занимать одну строку. Порядок: имя и сумма → сумма → путь при импорте → имя
 * (последнее — чтобы заметить SHA256_MISMATCH у изменённого файла).
 */
export function matchEntry(manifest: S['UploadManifest'] | null, f: { name: string; relPath?: string | null; sha256: string }): Entry | null {
  const files = manifest?.files ?? [];
  const named = (e: Entry) => Boolean(e.file_name) && (e.file_name === f.name || e.file_name === f.relPath);
  return (
    files.find((e) => named(e) && e.sha256 === f.sha256) ??
    files.find((e) => e.sha256 && e.sha256 === f.sha256) ??
    files.find((e) => Boolean(f.relPath) && e.file_name === f.relPath) ??
    files.find(named) ??
    null
  );
}

/** Поля файла из строки реестра (null-поля реестра не затирают оценку). */
function registryColumns(e: Entry): Record<string, string | number | null> {
  return {
    in_registry: 1,
    registry_key: entryKey(e),
    registry_sha256: e.sha256 ?? null,
    external_file_id: e.file_id ?? null,
    sheet_page_range: e.sheet_page_range ?? null,
    signature_status: e.signature_status ?? 'UNKNOWN',
    external_predecessor_id: e.predecessor_id ?? null,
    external_successor_id: e.successor_id ?? null,
    metadata_source: 'MANIFEST',
  };
}

function conflictingFileId(db: Db, objectId: string, externalId: string, sha256: string): boolean {
  return Boolean(db.get('SELECT 1 FROM files WHERE object_id = ? AND external_file_id = ? AND file_hash <> ?', objectId, externalId, sha256));
}

function saveRegistry(ctx: AppContext, processId: string, reg: RegistryInput, user: AuthUser): void {
  const key = `registries/${reg.sha256}`;
  if (!ctx.storage.exists(key)) {
    const tmp = ctx.storage.tmpPath(randomUUID());
    writeFileSync(tmp, reg.content);
    ctx.storage.commit(tmp, key);
  }
  ctx.db.insert('registries', {
    id: randomUUID(),
    process_id: processId,
    original_name: reg.originalName,
    format: reg.format,
    file_path: key,
    sha256: reg.sha256,
    entries: JSON.stringify(reg.manifest),
    entries_total: reg.manifest.files?.length ?? 0,
    created_by: user.id,
    created_at: nowIso(),
  });
}

function saveExpected(db: Db, processId: string, expected: S['ExpectedDocument'][], replace: boolean): void {
  if (replace) db.run('DELETE FROM expected_documents WHERE process_id = ?', processId);
  for (const e of expected) {
    const exists = db.get(
      `SELECT 1 FROM expected_documents WHERE process_id = ? AND doc_stage = ?
       AND IFNULL(discipline,'') = ? AND IFNULL(document_code,'') = ? AND IFNULL(file_name,'') = ?`,
      processId,
      e.doc_stage,
      e.discipline ?? '',
      e.document_code ?? '',
      e.file_name ?? '',
    );
    if (!exists) {
      db.insert('expected_documents', {
        id: randomUUID(),
        process_id: processId,
        doc_stage: e.doc_stage,
        discipline: e.discipline ?? null,
        document_code: e.document_code ?? null,
        file_name: e.file_name ?? null,
        title: e.title ?? null,
        created_at: nowIso(),
      });
    }
  }
}

/**
 * Связи редакций по реестру: predecessor_id/successor_id (file_id заказчика) и predecessor_file_name.
 * Связи строятся заново по действующему реестру — исправленный реестр снимает ошибочную связь.
 * Ручной выбор инспектора (authoritative_basis) не перетираем.
 */
export function linkRevisions(db: Db, processId: string, manifest: S['UploadManifest'] | null): void {
  const files = db.all(
    'SELECT id, original_name, registry_key, external_file_id, external_predecessor_id, external_successor_id, predecessor_id, authoritative_basis FROM files WHERE process_id = ? AND duplicate_of IS NULL',
    processId,
  );
  const byExternal = new Map(files.filter((f) => f.external_file_id).map((f) => [f.external_file_id as string, f.id as string]));
  const byName = new Map(files.map((f) => [f.original_name as string, f.id as string]));
  const linked = new Map<string, string>();
  for (const f of files) {
    const entry = f.registry_key ? (manifest?.files ?? []).find((e) => entryKey(e) === f.registry_key) : undefined;
    const extPred = f.external_predecessor_id as string | null;
    const pred =
      (extPred ? byExternal.get(extPred) : undefined) ??
      (entry?.predecessor_file_name ? byName.get(entry.predecessor_file_name) : undefined) ??
      null;
    if (pred && pred !== f.id) linked.set(f.id as string, pred);
  }
  for (const f of files) {
    const extSucc = f.external_successor_id as string | null;
    const succ = extSucc ? byExternal.get(extSucc) : undefined;
    if (succ && succ !== f.id && !linked.has(succ)) linked.set(succ, f.id as string);
  }
  for (const f of files) {
    if (f.authoritative_basis) continue;
    const next = linked.get(f.id as string) ?? null;
    if (((f.predecessor_id as string | null) ?? null) !== next) db.update('files', { predecessor_id: next }, 'id = ?', f.id as string);
  }
}

interface FileUpdate {
  id: string;
  sha256: string;
  values: Record<string, string | number | null>;
}

/**
 * Сопоставление уже загруженных файлов проверки с новым реестром: поля реестра для найденных,
 * возврат к оценке ML или по имени для выпавших. file_id, занятый другим содержимым, — FILE_ID_CONFLICT.
 */
function registryUpdates(db: Db, objectId: string, rows: Row[], manifest: S['UploadManifest']): FileUpdate[] {
  const conflicts: string[] = [];
  const updates: FileUpdate[] = [];
  for (const f of rows) {
    const sha256 = f.file_hash as string;
    const entry = matchEntry(manifest, { name: f.original_name as string, sha256 });
    if (!entry) {
      if (f.in_registry === 1) {
        // файл выпал из реестра — возвращаемся к подсказке пользователя или папке, оценке ML или имени файла
        const ml = parseJson<Record<string, string | null>>(f.metadata, {});
        const name = f.original_name as string;
        updates.push({
          id: f.id as string,
          sha256,
          values: {
            in_registry: 0,
            registry_key: null,
            registry_sha256: null,
            external_file_id: null,
            sheet_page_range: null,
            signature_status: 'UNKNOWN',
            external_predecessor_id: null,
            external_successor_id: null,
            stage_hint: (f.base_stage_hint as string | null) ?? null,
            title: null,
            discipline: ml.discipline ?? guessDiscipline(name),
            document_code: ml.document_code ?? guessDocumentCode(name),
            revision: ml.revision ?? guessRevision(name),
            approval_status: ml.approval_status ?? 'UNKNOWN',
            approval_date: ml.approval_date ?? null,
            metadata_source: f.metadata ? 'ML' : 'FILENAME',
          },
        });
      }
      continue;
    }
    if (entry.file_id && conflictingFileId(db, objectId, entry.file_id, sha256)) {
      conflicts.push(`${entry.file_id} → ${f.original_name as string}`);
      continue;
    }
    updates.push({
      id: f.id as string,
      sha256,
      values: {
        ...registryColumns(entry),
        stage_hint: entry.doc_stage ?? (f.stage_hint as string | null),
        title: entry.title ?? (f.title as string | null),
        discipline: entry.discipline ?? (f.discipline as string | null),
        document_code: entry.document_code ?? (f.document_code as string | null),
        revision: entry.revision ?? (f.revision as string | null),
        approval_status: entry.approval_status ?? (f.approval_status as string),
        approval_date: entry.approval_date ?? (f.approval_date as string | null),
      },
    });
  }
  if (conflicts.length) {
    throw conflict(
      'В реестре указаны file_id, которые уже заняты файлами с другим содержимым. Перезапись под тем же file_id запрещена.',
      'FILE_ID_CONFLICT',
      { conflicts },
    );
  }
  return updates;
}

export async function intakeFiles(ctx: AppContext, opts: IntakeOptions): Promise<{ response: S['UploadResponse']; objectId: string; accepted: string[] }> {
  const { db, config, storage, orchestrator } = ctx;
  const discard = () => opts.files.forEach((f) => rmSync(f.tmpPath, { force: true }));
  if (opts.files.length === 0) {
    throw badRequest('Не выбрано ни одного файла', undefined, 'NO_FILES');
  }

  let processId = opts.processId ?? null;
  let objectId: string;
  let isNew = false;
  if (processId) {
    const proc = db.get('SELECT * FROM processes WHERE id = ?', processId);
    if (!proc) {
      discard();
      throw notFound('Проверка');
    }
    const status = proc.status as ProcessStatus;
    if (!UPLOADABLE.includes(status)) {
      discard();
      throw conflict(
        status === 'FINALIZED'
          ? 'Протокол финализирован, дозагрузка невозможна. Создайте новую проверку.'
          : 'Идёт обработка документов, дозагрузка станет доступна после её завершения.',
        'PROCESS_LOCKED',
      );
    }
    objectId = proc.object_id as string;
  } else {
    if (!opts.objectId) {
      discard();
      throw badRequest('Укажите object_id (объект) или process_id (проверку для дозагрузки)');
    }
    if (!db.get('SELECT 1 FROM objects WHERE id = ?', opts.objectId)) {
      discard();
      throw notFound('Объект');
    }
    objectId = opts.objectId;
    processId = randomUUID();
    isNew = true;
  }

  // при дозагрузке без нового реестра действует ранее загруженный
  const manifest = opts.registry?.manifest ?? (isNew ? null : (activeRegistry(db, processId)?.manifest ?? null));
  const results: S['UploadedFileResult'][] = [];
  const accepted: { row: Record<string, string | number | null>; result: S['UploadedFileResult'] }[] = [];
  const batchBySha = new Map<string, string>();
  const batchExternal = new Map<string, string>();
  // новый реестр при дозагрузке относится ко всему комплекту — сопоставляем и ранее загруженные файлы
  let existingUpdates: FileUpdate[] = [];
  if (!isNew && opts.registry) {
    try {
      existingUpdates = registryUpdates(db, objectId, db.all('SELECT * FROM files WHERE process_id = ?', processId), opts.registry.manifest);
    } catch (err) {
      discard();
      throw err;
    }
    for (const u of existingUpdates) {
      if (u.values.external_file_id) batchExternal.set(u.values.external_file_id as string, u.sha256);
    }
  }

  for (const f of opts.files) {
    const reject = (error: NonNullable<S['UploadedFileResult']['error']>) => {
      rmSync(f.tmpPath, { force: true });
      results.push({ file_id: null, original_name: f.originalName, size_bytes: f.sizeBytes, sha256: f.sha256, status: 'REJECTED', error });
    };
    if (f.rejection) {
      reject(f.rejection);
      continue;
    }
    let checked = await checkFile(f, config);
    const cardOnly = checked.error?.code === 'UNSUPPORTED_FORMAT' && Boolean(f.allowCardOnly);
    if (cardOnly) checked = { ...checked, format: 'OTHER', error: null };
    if (checked.error) {
      reject(checked.error);
      continue;
    }
    const entry = matchEntry(manifest, { name: f.originalName, relPath: f.relPath, sha256: f.sha256 });
    const externalId = entry?.file_id ?? null;
    if (externalId) {
      const inBatch = batchExternal.get(externalId);
      if ((inBatch && inBatch !== f.sha256) || conflictingFileId(db, objectId, externalId, f.sha256)) {
        reject({ code: 'FILE_ID_CONFLICT', message: uploadMessages.FILE_ID_CONFLICT(externalId) });
        continue;
      }
      batchExternal.set(externalId, f.sha256);
    }
    const warnings: S['RegistryIssue'][] = [];
    // повторная загрузка того же содержимого: новая запись, но в сравнение идёт только первый экземпляр
    const original =
      batchBySha.get(f.sha256) ??
      (isNew ? undefined : db.get<{ id: string }>('SELECT id FROM files WHERE process_id = ? AND file_hash = ? AND duplicate_of IS NULL ORDER BY uploaded_at LIMIT 1', processId, f.sha256)?.id);
    if (original) {
      warnings.push({ code: 'DUPLICATE_CONTENT', message: 'Такое содержимое уже загружено в эту проверку: файл сохранён, но в сравнение не пойдёт', file_id: original });
    }
    if (manifest && !entry) {
      warnings.push({ code: 'NOT_IN_REGISTRY', message: 'Файла нет в реестре комплекта', file_name: f.originalName });
    }
    if (entry?.sha256 && entry.sha256 !== f.sha256) {
      warnings.push({ code: 'SHA256_MISMATCH', message: 'Контрольная сумма файла не совпадает с реестром', file_name: f.originalName, external_file_id: externalId });
    }
    if (cardOnly) {
      warnings.push({ code: 'FORMAT_CARD_ONLY', message: 'Формат без анализа, файл принят карточкой', file_name: f.originalName, external_file_id: externalId });
    }

    storage.commit(f.tmpPath, `raw/${f.sha256}`);
    const hint = opts.hints?.[f.originalName];
    const baseStageHint = (hint && STAGES.includes(hint as DocStage) ? (hint as DocStage) : null) ?? f.folderStage ?? null;
    const stageHint = entry?.doc_stage ?? baseStageHint;
    const id = randomUUID();
    if (!original) batchBySha.set(f.sha256, id);
    const row: Record<string, string | number | null> = {
      id,
      object_id: objectId,
      process_id: processId,
      original_name: f.originalName,
      format: checked.format,
      size_bytes: f.sizeBytes,
      file_hash: f.sha256,
      file_path: `raw/${f.sha256}`,
      pages_count: checked.pagesCount,
      stage_hint: stageHint,
      base_stage_hint: baseStageHint,
      doc_stage: guessStage(f.originalName),
      discipline: entry?.discipline ?? guessDiscipline(f.originalName),
      document_code: entry?.document_code ?? guessDocumentCode(f.originalName),
      revision: entry?.revision ?? guessRevision(f.originalName),
      approval_status: entry?.approval_status ?? 'UNKNOWN',
      approval_date: entry?.approval_date ?? null,
      metadata_source: 'FILENAME',
      duplicate_of: original ?? null,
      title: entry?.title ?? null,
      uploaded_by: opts.user.id,
      processing_status: cardOnly ? 'SKIPPED' : 'UPLOADED',
      quality: JSON.stringify(checked.pagesCount ? { pages_total: checked.pagesCount } : {}),
      uploaded_at: nowIso(),
      ...(entry ? registryColumns(entry) : {}),
    };
    const result: S['UploadedFileResult'] = {
      file_id: id,
      original_name: f.originalName,
      size_bytes: f.sizeBytes,
      sha256: f.sha256,
      status: 'UPLOADED',
      external_file_id: externalId,
      duplicate_of: original ?? null,
      warnings,
      error: null,
    };
    accepted.push({ row, result });
    results.push(result);
  }

  if (isNew && accepted.length === 0) {
    throw new ApiError(400, 'ALL_FILES_REJECTED', 'Ни один файл не принят', { files: results });
  }

  const now = nowIso();
  db.tx(() => {
    if (isNew) {
      db.insert('processes', { id: processId, object_id: objectId, status: 'PENDING', created_by: opts.user.id, created_at: now, updated_at: now });
    }
    for (const u of existingUpdates) db.update('files', u.values, 'id = ?', u.id);
    for (const a of accepted) db.insert('files', a.row);
    if (opts.registry) {
      saveRegistry(ctx, processId!, opts.registry, opts.user);
      saveExpected(db, processId!, opts.registry.manifest.expected ?? [], true);
    }
    linkRevisions(db, processId!, manifest);
    const externalObject = opts.registry?.manifest.object_external_id;
    if (externalObject) {
      db.run('UPDATE objects SET external_id = ? WHERE id = ? AND external_id IS NULL', externalObject, objectId);
    }
    db.update('objects', { updated_at: now }, 'id = ?', objectId);
  });

  refreshCompleteness(ctx, processId!);
  orchestrator.updateProgress(processId!, 'upload');
  if (opts.autoStart && accepted.length > 0) {
    await orchestrator.startAnalysis(processId!, {
      trigger: getProcessRow(db, processId!).current_protocol_id ? 'INCREMENTAL_UPLOAD' : 'INITIAL',
      changedFileIds: [...accepted.map((a) => a.row.id as string), ...existingUpdates.map((u) => u.id)],
    });
  }
  for (const a of accepted) {
    a.result.status = (db.get<{ s: string }>('SELECT processing_status AS s FROM files WHERE id = ?', a.row.id as string)?.s ??
      'UPLOADED') as S['FileProcessingStatus'];
  }
  const proc = getProcessRow(db, processId!);
  return {
    objectId,
    accepted: accepted.map((a) => a.row.id as string),
    response: {
      process_id: processId!,
      process_status: proc.status as ProcessStatus,
      files: results,
      upload_status: JSON.parse(proc.upload_status as string),
    },
  };
}

/**
 * Загрузка (замена) реестра в существующую проверку: метаданные файлов из реестра,
 * пересчёт полноты и новое сравнение, чтобы версия протокола учла реестр.
 */
export async function applyRegistry(
  ctx: AppContext,
  processId: string,
  reg: RegistryInput,
  user: AuthUser,
  autoStart: boolean,
): Promise<S['RegistryApplyResult']> {
  const { db, orchestrator } = ctx;
  const proc = getProcessRow(db, processId);
  const status = proc.status as ProcessStatus;
  if (status === 'FINALIZED') throw conflict('Протокол финализирован, реестр изменить нельзя. Создайте новую проверку.', 'PROCESS_FINALIZED');
  if (status === 'PARSING') throw conflict('Идёт обработка документов, загрузите реестр после её завершения.', 'PROCESS_LOCKED');
  const objectId = proc.object_id as string;
  const rows = db.all('SELECT * FROM files WHERE process_id = ?', processId);
  const updates = registryUpdates(db, objectId, rows, reg.manifest);

  db.tx(() => {
    for (const u of updates) db.update('files', u.values, 'id = ?', u.id);
    saveRegistry(ctx, processId, reg, user);
    saveExpected(db, processId, reg.manifest.expected ?? [], true);
    linkRevisions(db, processId, reg.manifest);
    if (reg.manifest.object_external_id) {
      db.run('UPDATE objects SET external_id = ? WHERE id = ? AND external_id IS NULL', reg.manifest.object_external_id, objectId);
    }
    db.update('processes', { updated_at: nowIso() }, 'id = ?', processId);
  });
  refreshCompleteness(ctx, processId);

  let started = false;
  const current = getProcessRow(db, processId);
  if ((current.current_protocol_id || autoStart) && rows.length > 0 && current.status !== 'PARSING') {
    await orchestrator.startAnalysis(processId, {
      trigger: current.current_protocol_id ? 'METADATA_CHANGE' : 'INITIAL',
      changedFileIds: listFiles(db, processId).map((f) => f.id),
    });
    started = true;
  }
  return {
    process_id: processId,
    registry_file_name: reg.originalName,
    entries_total: reg.manifest.files?.length ?? 0,
    matched_files: updates.filter((u) => u.values.in_registry === 1).length,
    completeness: completenessSummary(db, processId),
    analysis_started: started,
  };
}

/** Пересчитать статусы полноты и сценарий проверки (до сравнения). */
export function refreshCompleteness(ctx: AppContext, processId: string) {
  const c = completenessOf(ctx.db, processId);
  ctx.db.update(
    'processes',
    { upload_status: JSON.stringify(c.upload_status), scenario: computeScenario(c.upload_status, c.known_gap), updated_at: nowIso() },
    'id = ?',
    processId,
  );
  return c;
}

