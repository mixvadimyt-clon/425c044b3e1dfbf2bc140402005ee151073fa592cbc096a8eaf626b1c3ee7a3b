import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../../config.js';
import { type Db, type Row, nowIso } from '../../db/sqlite.js';
import { conflict } from '../../errors.js';
import type { S } from '../../types.js';
import { audit, notify } from '../notify.js';
import { getObject, getProcessRow, getProtocol } from '../repo.js';
import { type RinClient, RinError } from './client.js';

/**
 * Отправка результатов во внешнюю ИС (REQ-INT-01…05) через очередь integration_outbox:
 * снимок результата фиксируется при постановке в очередь, доставка — с повторами 1 / 5 / 15 минут на 5xx и таймаут.
 * Пока не доставлено — sync_status = PENDING_SYNC, после исчерпания повторов или на 4xx — SYNC_FAILED и уведомление.
 * Статус протокола и решения инспектора обмен не меняет (REQ-INT-04).
 */

/** Системное событие журнала (action = system.*), как у оркестратора. */
export function systemEvent(db: Db, action: string, processId: string | null, details: Record<string, unknown>, objectId?: string | null): void {
  const proc = processId ? db.get<{ object_id: string }>('SELECT object_id FROM processes WHERE id = ?', processId) : undefined;
  audit(db, {
    user_id: null,
    action: `system.${action}`,
    object_id: objectId ?? proc?.object_id ?? null,
    entity_type: processId ? 'process' : 'integration',
    entity_id: processId,
    details: processId ? { process_id: processId, ...details } : details,
  });
}

/** Пакет для внешней ИС: только подтверждённые нарушения, версии и реестр входных файлов (REQ-INT-05). */
export function inspectionResult(db: Db, processId: string): S['InspectionResult'] {
  const proc = getProcessRow(db, processId);
  if (proc.status !== 'FINALIZED') throw conflict('Результаты доступны только после финализации протокола', 'NOT_FINALIZED');
  const protocol = getProtocol(db, proc.current_protocol_id as string);
  const finalizer = db.get<Row>('SELECT * FROM users WHERE id = ?', proc.finalized_by as string);
  return {
    process_id: processId,
    object: getObject(db, proc.object_id as string),
    protocol_id: protocol.id,
    protocol_version: protocol.version,
    versions: protocol.versions,
    confirmed_violations: protocol.tables.confirmed_violations,
    input_files: protocol.input_files.map((f) => ({
      file_id: f.id,
      sha256: f.sha256,
      original_name: f.original_name,
      doc_stage: f.doc_stage ?? undefined,
      document_code: f.document_code ?? undefined,
      revision: f.revision ?? undefined,
    })),
    inspector: finalizer
      ? { id: finalizer.id as string, login: finalizer.login as string, full_name: finalizer.full_name as string, role: finalizer.role as S['UserRole'] }
      : undefined,
    finalized_at: proc.finalized_at as string,
  };
}

function mapSync(processId: string, row: Row | undefined, fallback: S['SyncStatus'], systemName: string): S['SyncInfo'] {
  return {
    process_id: processId,
    sync_status: (row?.sync_status as S['SyncStatus']) ?? fallback,
    protocol_version: (row?.protocol_version as number) ?? null,
    attempts: (row?.attempts as number) ?? 0,
    next_attempt_at: (row?.next_attempt_at as string) ?? null,
    last_error: (row?.last_error as string) ?? null,
    receipt_id: (row?.receipt_id as string) ?? null,
    external_system: systemName,
    updated_at: (row?.updated_at as string) ?? null,
  };
}

/** Последняя отправка проверки (без отправок — sync_status процесса, обычно NOT_SENT). */
export function syncInfo(db: Db, processId: string, systemName: string): S['SyncInfo'] {
  const proc = getProcessRow(db, processId);
  const row = db.get('SELECT * FROM integration_outbox WHERE process_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', processId);
  return mapSync(processId, row, (proc.sync_status as S['SyncStatus']) ?? 'NOT_SENT', systemName);
}

/**
 * Поставить текущую версию протокола в очередь отправки. Ключ идемпотентности — `<process_id>:v<версия>`:
 * внешняя ИС по нему не заведёт дубль, а если эта версия уже ждёт отправки — возвращается та же запись.
 */
export function enqueueResult(db: Db, cfg: AppConfig['rin'], processId: string, source: 'FINALIZED' | 'MANUAL'): S['SyncInfo'] {
  const proc = getProcessRow(db, processId);
  if (proc.status !== 'FINALIZED') throw conflict('Результаты передаются только после финализации протокола', 'NOT_FINALIZED');
  if (!cfg.url) throw conflict(`Обмен с ${cfg.systemName} не настроен (RIN_URL)`, 'INTEGRATION_DISABLED');
  const result = inspectionResult(db, processId);
  const key = `${processId}:v${result.protocol_version}`;
  const pending = db.get("SELECT * FROM integration_outbox WHERE idempotency_key = ? AND sync_status = 'PENDING_SYNC'", key);
  if (pending) return mapSync(processId, pending, 'PENDING_SYNC', cfg.systemName);
  const now = nowIso();
  const id = randomUUID();
  db.tx(() => {
    db.insert('integration_outbox', {
      id,
      process_id: processId,
      payload: JSON.stringify(result),
      sync_status: 'PENDING_SYNC',
      attempts: 0,
      next_attempt_at: now,
      last_error: null,
      protocol_id: result.protocol_id ?? null,
      protocol_version: result.protocol_version,
      idempotency_key: key,
      source,
      created_at: now,
      updated_at: now,
    });
    db.update('processes', { sync_status: 'PENDING_SYNC', updated_at: now }, 'id = ?', processId);
  });
  systemEvent(db, 'integration_queued', processId, { protocol_version: result.protocol_version, source, violations: result.confirmed_violations.length });
  return mapSync(processId, db.get('SELECT * FROM integration_outbox WHERE id = ?', id), 'PENDING_SYNC', cfg.systemName);
}

/** Доставить всё, чему подошло время. Возвращает число обработанных записей. */
export async function deliverDue(db: Db, cfg: AppConfig['rin'], client: RinClient): Promise<number> {
  const due = db.all(
    "SELECT * FROM integration_outbox WHERE sync_status = 'PENDING_SYNC' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at, rowid",
    nowIso(),
  );
  for (const row of due) {
    const id = row.id as string;
    const processId = row.process_id as string;
    const proc = db.get('SELECT * FROM processes WHERE id = ?', processId);
    if (!proc || proc.status !== 'FINALIZED') {
      const now = nowIso();
      db.update('integration_outbox', { sync_status: 'SYNC_FAILED', last_error: 'Финализация отменена, отправка остановлена', next_attempt_at: null, updated_at: now }, 'id = ?', id);
      if (proc) db.update('processes', { sync_status: 'NOT_SENT', updated_at: now }, 'id = ?', processId);
      systemEvent(db, 'integration_cancelled', processId, { protocol_version: row.protocol_version });
      continue;
    }
    const attempts = (row.attempts as number) + 1;
    try {
      const { receipt } = await client.pushResult(row.payload as string, row.idempotency_key as string);
      const now = nowIso();
      db.tx(() => {
        db.update(
          'integration_outbox',
          { sync_status: 'SYNCED', attempts, receipt_id: receipt.receipt_id, response: JSON.stringify(receipt), last_error: null, next_attempt_at: null, updated_at: now },
          'id = ?',
          id,
        );
        db.update('processes', { sync_status: 'SYNCED', updated_at: now }, 'id = ?', processId);
      });
      systemEvent(db, 'integration_delivered', processId, {
        protocol_version: row.protocol_version,
        attempts,
        receipt_id: receipt.receipt_id,
        duplicate: receipt.duplicate,
        prescription: receipt.prescription ?? null,
      });
    } catch (err) {
      const e = err instanceof RinError ? err : new RinError((err as Error).message, true);
      const now = nowIso();
      const delay = cfg.retryDelaysS[attempts - 1];
      if (e.retryable && delay !== undefined) {
        const next = new Date(Date.now() + delay * 1000).toISOString();
        db.update('integration_outbox', { attempts, last_error: e.message, next_attempt_at: next, updated_at: now }, 'id = ?', id);
        systemEvent(db, 'integration_retry', processId, { protocol_version: row.protocol_version, attempt: attempts, error: e.message, next_attempt_at: next });
        continue;
      }
      db.tx(() => {
        db.update('integration_outbox', { sync_status: 'SYNC_FAILED', attempts, last_error: e.message, next_attempt_at: null, updated_at: now }, 'id = ?', id);
        db.update('processes', { sync_status: 'SYNC_FAILED', updated_at: now }, 'id = ?', processId);
      });
      systemEvent(db, 'integration_failed', processId, { protocol_version: row.protocol_version, attempts, error: e.message, status: e.status });
      const object = db.get<{ name: string }>('SELECT name FROM objects WHERE id = ?', proc.object_id as string);
      notify(db, {
        type: 'SYNC_FAILED',
        user_id: (proc.finalized_by as string) ?? null,
        role: proc.finalized_by ? null : 'INSPECTOR',
        process_id: processId,
        object_id: proc.object_id as string,
        message:
          `Не удалось передать результаты проверки «${object?.name ?? processId}» в ${cfg.systemName} ` +
          `(попыток: ${attempts}; ${e.message}). Протокол остаётся финализированным, повторите отправку позже.`,
      });
    }
  }
  return due.length;
}
