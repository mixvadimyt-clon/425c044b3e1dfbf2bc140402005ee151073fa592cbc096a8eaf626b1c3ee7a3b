import { randomUUID } from 'node:crypto';
import type { Db, Row } from '../db/sqlite.js';
import { nowIso } from '../db/sqlite.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import type { AuthUser, ProcessStatus, S } from '../types.js';
import { notify } from './notify.js';
import { syncVerificationStatus } from './orchestrator.js';
import { DECIDABLE, countsForProtocol, getCheckRow, getProcessRow, mapFinding } from './repo.js';

const RESULT: Record<S['InspectorAction'], S['InspectorStatus']> = {
  CONFIRM: 'CONFIRMED_VIOLATION',
  REJECT: 'NEGATIVE_VERIFIED',
  CLARIFY: 'CLARIFICATION_REQUIRED',
};
/** По каким исходным статусам модели инспектор принимает решение. */
const DECIDABLE_MODEL_STATUSES = ['CANDIDATE', 'CLARIFICATION_REQUIRED', 'NEGATIVE_VERIFIED'];

function assertEditable(db: Db, check: Row): Row {
  const proc = getProcessRow(db, check.process_id as string);
  const status = proc.status as ProcessStatus;
  if (status === 'FINALIZED') throw conflict('Протокол финализирован, изменение решений невозможно', 'PROCESS_FINALIZED');
  if (!DECIDABLE.includes(status)) throw conflict('Решения недоступны, пока идёт обработка документов', 'PROCESS_LOCKED');
  if (proc.current_protocol_id !== check.protocol_id) {
    throw conflict('Это устаревшая версия протокола, откройте текущую версию', 'STALE_PROTOCOL');
  }
  return proc;
}

export function decide(db: Db, checkId: string, user: AuthUser, body: S['DecisionRequest']): S['Finding'] {
  const check = getCheckRow(db, checkId);
  assertEditable(db, check);
  if (check.is_split === 1) throw conflict('Кандидат разделён на части, примите решение по каждой части', 'FINDING_SPLIT');
  if (!DECIDABLE_MODEL_STATUSES.includes(check.model_finding_status as string)) {
    throw badRequest('По этой записи решение не требуется: это статус комплектности, а не кандидат', undefined, 'NOT_DECIDABLE');
  }
  const comment = body.comment?.trim() || null;
  if (body.action === 'REJECT' && (!body.reason_code || !comment)) {
    throw badRequest('Для отклонения укажите причину (reason_code) и комментарий', undefined, 'REASON_REQUIRED');
  }
  const status = RESULT[body.action];
  const protocolVersion = db.get<{ version: number }>('SELECT version FROM protocols WHERE id = ?', check.protocol_id as string)!.version;
  const now = nowIso();

  db.tx(() => {
    db.update(
      'checks',
      {
        finding_status: status,
        inspector_status: status,
        evidence_changed: 0,
        approved_change_ref: body.approved_change_ref ?? (check.approved_change_ref as string) ?? null,
        updated_at: now,
      },
      'id = ?',
      checkId,
    );
    db.insert('finding_decisions', {
      id: randomUUID(),
      check_id: checkId,
      action: body.action,
      resulting_status: status,
      reason_code: body.action === 'REJECT' ? body.reason_code : body.reason_code ?? null,
      comment,
      approved_change_ref: body.approved_change_ref ?? null,
      user_id: user.id,
      decided_at: now,
      protocol_version: protocolVersion,
    });

    // GOLD-черновик (REQ-ML-01/02): только подтверждённые и отклонённые
    const existing = db.get<Row>('SELECT * FROM dataset_items WHERE check_id = ?', checkId);
    if (existing?.dataset_version) {
      // запись уже в выпущенной версии набора — версии неизменны (REQ-ML-05); новое решение остаётся в журнале решений
    } else if (body.action === 'CLARIFY') {
      if (existing?.curation_status === 'DRAFT') db.run('DELETE FROM dataset_items WHERE id = ?', existing.id as string);
      else if (existing) db.update('dataset_items', { curation_status: 'EXCLUDED' }, 'id = ?', existing.id as string);
      db.insert('dispute_log', {
        id: randomUUID(),
        violation_id: checkId,
        inspector_comment: comment,
        ai_comment:
          'Статус: CLARIFICATION_REQUIRED. Показаны точные страницы и доказательные фрагменты. До повторного решения инспектора запись не включается в GOLD и не передаётся во внешнюю систему.',
        resolution_status: 'OPEN',
        created_at: now,
      });
    } else {
      const item = {
        evidence_group_id: check.evidence_group_id as string,
        param_code: check.param_code as string,
        gold_label: body.action === 'CONFIRM' ? 'POSITIVE' : 'NEGATIVE',
        expert_id: user.id,
        reason_code: body.action === 'REJECT' ? body.reason_code : null,
        curation_status: 'DRAFT',
        curated_by: null,
        curated_at: null,
        object_group_id: check.object_id as string,
      };
      if (existing) db.update('dataset_items', item, 'id = ?', existing.id as string);
      else db.insert('dataset_items', { id: randomUUID(), check_id: checkId, ...item, created_at: now });
      // Отказ ждёт решения администратора в «Разборе для дообучения» — без уведомления он узнавал
      // об этом, только открыв дашборд
      if (body.action === 'REJECT' && (existing?.gold_label as string | undefined) !== 'NEGATIVE') {
        const object = db.get<{ name: string }>('SELECT name FROM objects WHERE id = ?', check.object_id as string);
        notify(db, {
          type: 'RETRAIN_ITEM_PENDING',
          role: 'ADMIN',
          message: `Параметр ${check.param_code as string}, проект «${object?.name ?? ''}»: отказ инспектора ждёт решения по дообучению`,
          process_id: check.process_id as string,
          object_id: check.object_id as string,
        });
      }
    }
    if (body.action === 'REJECT') {
      db.insert('rejection_log', {
        id: randomUUID(),
        violation_id: checkId,
        rejection_reason: body.reason_code!,
        ai_verdict: check.model_finding_status as string,
        suggested_fix: comment,
        retraining_status: 'DRAFT',
        created_at: now,
      });
    }
    syncVerificationStatus(db, check.process_id as string);
  });
  return mapFinding(db, getCheckRow(db, checkId));
}

export function split(db: Db, checkId: string, body: S['SplitRequest']): S['Finding'][] {
  const check = getCheckRow(db, checkId);
  assertEditable(db, check);
  if (check.is_split === 1) throw conflict('Кандидат уже разделён', 'FINDING_SPLIT');
  if (check.model_finding_status !== 'CANDIDATE') throw badRequest('Разделить можно только кандидата', undefined, 'NOT_DECIDABLE');
  if (check.inspector_status !== 'PENDING') throw conflict('По кандидату уже принято решение, разделение невозможно', 'ALREADY_DECIDED');
  const fragments = db.all<Row>('SELECT * FROM evidence_fragments WHERE evidence_group_id = ?', check.evidence_group_id as string);
  const known = new Set(fragments.map((f) => f.id as string));
  const keys = new Set<string>();
  for (const part of body.parts) {
    if (!part.rule_key?.trim()) throw badRequest('У каждой части должен быть rule_key');
    if (keys.has(part.rule_key)) throw badRequest(`Повторяющийся rule_key: ${part.rule_key}`);
    keys.add(part.rule_key);
    for (const id of part.fragment_ids) if (!known.has(id)) throw badRequest(`Фрагмент ${id} не относится к этому кандидату`);
  }
  const now = nowIso();
  const ids: string[] = [];
  db.tx(() => {
    for (const part of body.parts) {
      const groupId = randomUUID();
      db.insert('evidence_groups', { id: groupId, object_id: check.object_id as string, param_code: check.param_code as string, rule_key: part.rule_key, created_at: now });
      for (const f of fragments.filter((x) => part.fragment_ids.includes(x.id as string))) {
        db.insert('evidence_fragments', { ...(f as Record<string, string | number | null>), id: randomUUID(), evidence_group_id: groupId });
      }
      const id = randomUUID();
      ids.push(id);
      const { id: _i, ...rest } = check;
      db.insert('checks', {
        ...(rest as Record<string, string | number | null>),
        id,
        finding_key: `${check.finding_key as string}#${part.rule_key}`,
        rule_key: part.rule_key,
        expected_value: part.expected_value ?? (check.expected_value as string) ?? null,
        actual_value: part.actual_value ?? (check.actual_value as string) ?? null,
        stage_comparisons: '[]',
        rationale: part.comment ? `${part.comment}. ${(check.rationale as string) ?? ''}`.trim() : (check.rationale as string),
        finding_status: 'CANDIDATE',
        model_finding_status: 'CANDIDATE',
        inspector_status: 'PENDING',
        evidence_group_id: groupId,
        parent_check_id: checkId,
        is_split: 0,
        evidence_changed: 0,
        created_at: now,
        updated_at: now,
      });
    }
    db.update('checks', { is_split: 1, updated_at: now }, 'id = ?', checkId);
    syncVerificationStatus(db, check.process_id as string);
  });
  return ids.map((id) => mapFinding(db, getCheckRow(db, id)));
}

export function finalize(db: Db, processId: string, user: AuthUser): void {
  const proc = getProcessRow(db, processId);
  const status = proc.status as ProcessStatus;
  if (status === 'FINALIZED') throw conflict('Протокол уже финализирован', 'PROCESS_FINALIZED');
  if (!DECIDABLE.includes(status)) throw conflict('Финализация невозможна: протокол ещё не сформирован', 'INVALID_STATUS');
  const counts = countsForProtocol(db, proc.current_protocol_id as string);
  if ((counts.candidates_pending ?? 0) > 0) {
    throw conflict(
      `Остались необработанные кандидаты: ${counts.candidates_pending}. Примите решение или переведите их в «Требует уточнения».`,
      'PENDING_CANDIDATES',
      { candidates_pending: counts.candidates_pending },
    );
  }
  const now = nowIso();
  db.tx(() => {
    db.update('processes', { status: 'FINALIZED', finalized_at: now, finalized_by: user.id, updated_at: now }, 'id = ?', processId);
    db.update('protocols', { status: 'PROTOCOL_FINALIZED', finalized_at: now }, 'id = ?', proc.current_protocol_id as string);
  });
}

export function unfinalize(db: Db, processId: string, user: AuthUser, reason: string): void {
  if (user.role !== 'ADMIN' && user.role !== 'SUPERVISOR') {
    throw forbidden('Отменить финализацию может только администратор или супервизор');
  }
  if (!reason?.trim()) throw badRequest('Укажите причину отмены финализации', undefined, 'REASON_REQUIRED');
  const proc = getProcessRow(db, processId);
  if (proc.status !== 'FINALIZED') throw conflict('Протокол не финализирован', 'INVALID_STATUS');
  const now = nowIso();
  db.tx(() => {
    db.update('processes', { status: 'COMPLETED', finalized_at: null, finalized_by: null, updated_at: now }, 'id = ?', processId);
    db.update('protocols', { status: 'VERIFICATION_COMPLETED', finalized_at: null }, 'id = ?', proc.current_protocol_id as string);
    db.run(
      `UPDATE unfinalize_requests SET status = 'DONE', resolved_by = ?, resolved_at = ?, resolution_comment = ?
        WHERE process_id = ? AND status = 'OPEN'`,
      user.id,
      now,
      reason.trim(),
      processId,
    );
  });
}

// ------------------------------------------------ запросы на откат финализации (0.19.0)

function mapUnfinalizeRequest(db: Db, r: Row): S['UnfinalizeRequest'] {
  const name = (id: unknown) => (id ? (db.get<{ full_name: string }>('SELECT full_name FROM users WHERE id = ?', id as string)?.full_name ?? null) : null);
  return {
    id: r.id as string,
    process_id: r.process_id as string,
    object_id: r.object_id as string,
    object_name: db.get<{ name: string }>('SELECT name FROM objects WHERE id = ?', r.object_id as string)?.name ?? null,
    requested_by: (r.requested_by as string) ?? null,
    requested_by_name: name(r.requested_by),
    reason: r.reason as string,
    status: r.status as S['UnfinalizeRequestStatus'],
    created_at: r.created_at as string,
    resolved_by_name: name(r.resolved_by),
    resolved_at: (r.resolved_at as string) ?? null,
    resolution_comment: (r.resolution_comment as string) ?? null,
  };
}

/**
 * Инспектор просит откат финализации: отменить её сам он не может (REQ-VER-09), а просить голосом —
 * значит без следа в системе. Запрос с причиной, уведомление ADMIN и SUPERVISOR; открытый на процесс — один.
 */
export function requestUnfinalize(db: Db, processId: string, user: AuthUser, reason: string): S['UnfinalizeRequest'] {
  const text = reason?.trim();
  if (!text) throw badRequest('Укажите причину, по которой проверку нужно вернуть в работу', undefined, 'REASON_REQUIRED');
  const proc = getProcessRow(db, processId);
  if (proc.status !== 'FINALIZED') throw conflict('Протокол не финализирован, откат не нужен', 'INVALID_STATUS');
  if (db.get('SELECT 1 FROM unfinalize_requests WHERE process_id = ? AND status = ?', processId, 'OPEN')) {
    throw conflict('Запрос на откат этой проверки уже ждёт решения', 'REQUEST_EXISTS');
  }
  const id = randomUUID();
  const objectId = proc.object_id as string;
  const object = db.get<{ name: string }>('SELECT name FROM objects WHERE id = ?', objectId);
  db.tx(() => {
    db.insert('unfinalize_requests', { id, process_id: processId, object_id: objectId, requested_by: user.id, reason: text, status: 'OPEN', created_at: nowIso() });
    for (const role of ['ADMIN', 'SUPERVISOR'] as const) {
      notify(db, {
        type: 'UNFINALIZE_REQUESTED',
        role,
        message: `${user.full_name} просит вернуть в работу проверку проекта «${object?.name ?? ''}»: ${text}`,
        process_id: processId,
        object_id: objectId,
      });
    }
  });
  return mapUnfinalizeRequest(db, db.get<Row>('SELECT * FROM unfinalize_requests WHERE id = ?', id)!);
}

export function listUnfinalizeRequests(db: Db, status?: S['UnfinalizeRequestStatus']): S['UnfinalizeRequest'][] {
  const rows = status
    ? db.all<Row>('SELECT * FROM unfinalize_requests WHERE status = ? ORDER BY created_at DESC', status)
    : db.all<Row>('SELECT * FROM unfinalize_requests ORDER BY created_at DESC');
  return rows.map((r) => mapUnfinalizeRequest(db, r));
}

export function rejectUnfinalizeRequest(db: Db, requestId: string, user: AuthUser, reason: string): S['UnfinalizeRequest'] {
  const text = reason?.trim();
  if (!text) throw badRequest('Укажите причину отказа', undefined, 'REASON_REQUIRED');
  const row = db.get<Row>('SELECT * FROM unfinalize_requests WHERE id = ?', requestId);
  if (!row) throw notFound('Запрос на откат');
  if (row.status !== 'OPEN') throw conflict('Запрос уже закрыт', 'INVALID_STATUS');
  db.update('unfinalize_requests', { status: 'REJECTED', resolved_by: user.id, resolved_at: nowIso(), resolution_comment: text }, 'id = ?', requestId);
  return mapUnfinalizeRequest(db, db.get<Row>('SELECT * FROM unfinalize_requests WHERE id = ?', requestId)!);
}

/**
 * Правка доказательств инспектором: новая версия группы, машинный результат сохраняется.
 */
export function editEvidence(db: Db, checkId: string, user: AuthUser, body: S['EvidenceEditRequest']): S['Finding'] {
  const check = getCheckRow(db, checkId);
  assertEditable(db, check);
  if (check.is_split === 1) throw conflict('Кандидат разделён, правьте доказательства частей', 'FINDING_SPLIT');
  const reason = body.reason?.trim();
  if (!reason) throw badRequest('Укажите причину изменения доказательств', undefined, 'REASON_REQUIRED');
  const add = body.add ?? [];
  const remove = new Set(body.remove_fragment_ids ?? []);
  if (add.length === 0 && remove.size === 0) throw badRequest('Нет изменений');

  const currentGroup = db.get<Row>('SELECT * FROM evidence_groups WHERE id = ?', check.evidence_group_id as string)!;
  const current = db.all<Row>('SELECT * FROM evidence_fragments WHERE evidence_group_id = ?', currentGroup.id as string);
  for (const id of remove) {
    if (!current.some((f) => f.id === id)) throw badRequest(`Фрагмент ${id} не относится к текущей версии доказательств`);
  }
  const files = new Map(
    db.all<Row>('SELECT * FROM files WHERE process_id = ?', check.process_id as string).map((f) => [f.id as string, f]),
  );
  for (const f of add) {
    const file = files.get(f.file_id);
    if (!file) throw badRequest(`Файл ${f.file_id} не относится к этой проверке`);
    if (file.pages_count && f.page > (file.pages_count as number)) throw badRequest(`В файле «${file.original_name as string}» нет страницы ${f.page}`);
    const [x0, y0, x1, y1] = f.bbox;
    if (!(x0 < x1 && y0 < y1)) throw badRequest('Некорректная область: bbox должен быть [x0, y0, x1, y1] с x0 < x1 и y0 < y1');
  }
  const kept = current.filter((f) => !remove.has(f.id as string));
  if (kept.length + add.length === 0) throw badRequest('У кандидата должен остаться хотя бы один доказательный фрагмент');

  const now = nowIso();
  const groupId = randomUUID();
  db.tx(() => {
    db.insert('evidence_groups', {
      id: groupId,
      object_id: currentGroup.object_id as string,
      param_code: currentGroup.param_code as string,
      rule_key: (currentGroup.rule_key as string) ?? null,
      version: ((currentGroup.version as number) ?? 1) + 1,
      source: 'INSPECTOR',
      previous_group_id: currentGroup.id as string,
      created_by: user.id,
      reason,
      reference: body.reference ?? null,
      created_at: now,
    });
    for (const f of kept) {
      db.insert('evidence_fragments', { ...(f as Record<string, string | number | null>), id: randomUUID(), evidence_group_id: groupId });
    }
    for (const f of add) {
      const file = files.get(f.file_id)!;
      const sheets = (JSON.parse((file.metadata as string) || '{}') as { sheets?: { page: number; sheet?: string | null }[] }).sheets ?? [];
      db.insert('evidence_fragments', {
        id: randomUUID(),
        evidence_group_id: groupId,
        role: f.role,
        file_id: f.file_id,
        sha256: file.file_hash as string,
        stage: ((file.stage_hint ?? file.doc_stage) as string) ?? 'PD',
        document_code: (file.document_code as string) ?? null,
        revision: (file.revision as string) ?? null,
        approval_status: (file.approval_status as string) ?? null,
        page: f.page,
        sheet: sheets.find((x) => x.page === f.page)?.sheet ?? null,
        bbox: JSON.stringify(f.bbox),
        polygon: f.polygon ? JSON.stringify(f.polygon) : null,
        extracted_value: f.extracted_value ?? null,
        normalized_value: f.extracted_value ?? null,
        text_snippet: f.text_snippet ?? null,
        source: 'MANUAL',
        quality: 'OK',
        confidence: 1,
      });
    }
    db.update('checks', { evidence_group_id: groupId, evidence_changed: 0, updated_at: now }, 'id = ?', checkId);
  });
  return mapFinding(db, getCheckRow(db, checkId));
}

/** Массовое решение: только CONFIRM/CLARIFY и только кандидаты одного параметра одного протокола. */
export function bulkDecide(db: Db, ids: string[], user: AuthUser, body: S['BulkDecisionRequest']): S['Finding'][] {
  if ((body.action as string) === 'REJECT') {
    throw badRequest('Массовое отклонение недоступно: каждое расхождение отклоняется отдельно с причиной', undefined, 'BULK_REJECT_FORBIDDEN');
  }
  const unique = [...new Set(ids)];
  const rows = unique.map((id) => getCheckRow(db, id));
  const protocols = new Set(rows.map((r) => r.protocol_id));
  const params = new Set(rows.map((r) => r.param_code));
  if (protocols.size > 1 || params.size > 1) {
    throw badRequest('Массовое решение доступно только для кандидатов одного параметра в одном протоколе', undefined, 'BULK_MIXED');
  }
  return db.tx(() => unique.map((id) => decide(db, id, user, { action: body.action, comment: body.comment })));
}
