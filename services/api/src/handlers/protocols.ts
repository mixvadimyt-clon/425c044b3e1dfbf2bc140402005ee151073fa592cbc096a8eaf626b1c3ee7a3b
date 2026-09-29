import { randomUUID } from 'node:crypto';
import { type AppContext, type Handlers, currentUser, paging, requireRole } from '../context.js';
import { type Row, nowIso } from '../db/sqlite.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { exportProtocol } from '../modules/export/index.js';
import { syncVerificationStatus } from '../modules/orchestrator.js';
import {
  getCheckRow,
  getProcessInfo,
  getProcessRow,
  getProtocol,
  getProtocolRow,
  listFiles,
  mapFinding,
  mapPagePair,
  mapProtocolVersion,
  mapSuspicion,
} from '../modules/repo.js';
import { findingKey } from '../modules/transport/stub.js';
import {
  bulkDecide,
  decide,
  editEvidence,
  finalize,
  listUnfinalizeRequests,
  rejectUnfinalizeRequest,
  requestUnfinalize,
  split,
  unfinalize,
} from '../modules/verification.js';
import type { S } from '../types.js';

const VERIFIERS = ['INSPECTOR', 'SUPERVISOR'] as const;

export function protocolHandlers(ctx: AppContext): Handlers {
  const { db } = ctx;

  const suspicionRow = (id: string): Row => {
    const r = db.get('SELECT * FROM suspicions WHERE id = ?', id);
    if (!r) throw notFound('Гипотеза');
    return r;
  };

  return {
    async finalizeProcess(req) {
      const user = requireRole(req, ...VERIFIERS);
      const { process_id } = req.params as { process_id: string };
      finalize(db, process_id, user);
      const proc = getProcessRow(db, process_id);
      req.audit = { object_id: proc.object_id as string, entity_type: 'process', entity_id: process_id };
      // REQ-INT-01: результат уходит во внешнюю ИС сам; сбой обмена финализацию не отменяет (REQ-INT-04)
      if (ctx.integration.enabled && ctx.config.rin.autoPush) {
        try {
          ctx.integration.enqueue(process_id, 'FINALIZED');
        } catch (err) {
          req.log.error({ err, process_id }, 'Не удалось поставить результаты в очередь отправки');
        }
      }
      return getProcessInfo(db, process_id);
    },

    async unfinalizeProcess(req) {
      const user = currentUser(req);
      const { process_id } = req.params as { process_id: string };
      const { reason } = req.body as S['ReasonRequest'];
      unfinalize(db, process_id, user, reason);
      const proc = getProcessRow(db, process_id);
      req.audit = { object_id: proc.object_id as string, entity_type: 'process', entity_id: process_id, details: { reason } };
      return getProcessInfo(db, process_id);
    },

    async requestUnfinalize(req, reply) {
      const user = requireRole(req, 'INSPECTOR', 'SUPERVISOR');
      const { process_id } = req.params as { process_id: string };
      const { reason } = req.body as S['ReasonRequest'];
      const created = requestUnfinalize(db, process_id, user, reason);
      req.audit = { object_id: created.object_id, entity_type: 'unfinalize_request', entity_id: created.id, details: { process_id, reason } };
      reply.code(201);
      return created;
    },

    async listUnfinalizeRequests(req) {
      requireRole(req, 'ADMIN', 'SUPERVISOR');
      const { status } = req.query as { status?: S['UnfinalizeRequestStatus'] };
      return listUnfinalizeRequests(db, status);
    },

    async rejectUnfinalizeRequest(req) {
      const user = requireRole(req, 'ADMIN', 'SUPERVISOR');
      const { request_id } = req.params as { request_id: string };
      const { reason } = req.body as S['ReasonRequest'];
      const done = rejectUnfinalizeRequest(db, request_id, user, reason);
      req.audit = { object_id: done.object_id, entity_type: 'unfinalize_request', entity_id: request_id, details: { reason } };
      return done;
    },

    async listProtocolVersions(req) {
      const { process_id } = req.params as { process_id: string };
      getProcessRow(db, process_id);
      return db.all('SELECT * FROM protocols WHERE process_id = ? ORDER BY version DESC', process_id).map(mapProtocolVersion);
    },

    async getProtocol(req) {
      const { protocol_id } = req.params as { protocol_id: string };
      return getProtocol(db, protocol_id);
    },

    async listFindings(req) {
      const { protocol_id } = req.params as { protocol_id: string };
      getProtocolRow(db, protocol_id);
      const q = req.query as {
        page?: number;
        page_size?: number;
        finding_status?: string;
        inspector_status?: string;
        section?: string;
        review_priority?: string;
        param_code?: string;
        file_id?: string;
        evidence_page?: number;
      };
      const { page, pageSize, offset } = paging(q);
      const where = ['c.protocol_id = ?', 'c.is_split = 0'];
      const args: (string | number)[] = [protocol_id];
      if (q.finding_status) {
        // «кандидаты» в очереди верификации = исходно CANDIDATE (включая уже решённые)
        where.push(q.finding_status === 'CANDIDATE' ? "c.model_finding_status = 'CANDIDATE'" : 'c.finding_status = ?');
        if (q.finding_status !== 'CANDIDATE') args.push(q.finding_status);
      }
      if (q.inspector_status) {
        where.push('c.inspector_status = ?');
        args.push(q.inspector_status);
      }
      if (q.section) {
        where.push('p.section = ?');
        args.push(q.section);
      }
      if (q.review_priority) {
        where.push('c.review_priority = ?');
        args.push(q.review_priority);
      }
      if (q.param_code) {
        where.push('c.param_code = ?');
        args.push(q.param_code);
      }
      if (q.file_id) {
        where.push(
          `EXISTS (SELECT 1 FROM evidence_fragments f WHERE f.evidence_group_id = c.evidence_group_id AND f.file_id = ?${q.evidence_page ? ' AND f.page = ?' : ''})`,
        );
        args.push(q.file_id);
        if (q.evidence_page) args.push(Number(q.evidence_page));
      }
      const from = `FROM checks c LEFT JOIN params p ON p.code = c.param_code WHERE ${where.join(' AND ')}`;
      const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n ${from}`, ...args)!.n;
      const order = `ORDER BY CASE c.inspector_status WHEN 'PENDING' THEN 0 ELSE 1 END,
        CASE c.review_priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, c.param_code, c.rule_key`;
      const rows = db.all(`SELECT c.* ${from} ${order} LIMIT ? OFFSET ?`, ...args, pageSize, offset);
      return { items: rows.map((r) => mapFinding(db, r)), total, page, page_size: pageSize } satisfies S['FindingPage'];
    },

    async listPagePairs(req) {
      const { protocol_id } = req.params as { protocol_id: string };
      const { file_id } = req.query as { file_id?: string };
      getProtocolRow(db, protocol_id);
      const rows = file_id
        ? db.all('SELECT * FROM page_pairs WHERE protocol_id = ? AND (left_file_id = ? OR right_file_id = ?) ORDER BY match_score DESC', protocol_id, file_id, file_id)
        : db.all('SELECT * FROM page_pairs WHERE protocol_id = ? ORDER BY match_score DESC', protocol_id);
      return rows.map((r) => mapPagePair(db, r));
    },

    async exportProtocol(req, reply) {
      const { protocol_id } = req.params as { protocol_id: string };
      const { format } = req.query as { format: S['ExportFormat'] };
      const started = Date.now();
      const out = await exportProtocol(db, ctx.storage, protocol_id, format, { freeMinConfidence: ctx.config.submissionFreeMinConfidence });
      const row = db.get<{ object_id: string }>('SELECT object_id FROM protocols WHERE id = ?', protocol_id);
      req.audit = {
        object_id: row?.object_id ?? null,
        entity_type: 'protocol',
        entity_id: protocol_id,
        details: { format, cached: out.cached, duration_ms: Date.now() - started },
      };
      reply
        .header('content-type', out.contentType)
        .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(out.fileName)}`);
      if (Buffer.isBuffer(out.body) || typeof out.body === 'string') return reply.send(out.body);
      return reply.serializer((v: unknown) => JSON.stringify(v)).send(out.body);
    },

    async getFinding(req) {
      const { finding_id } = req.params as { finding_id: string };
      return mapFinding(db, getCheckRow(db, finding_id));
    },

    async decideFinding(req) {
      const user = requireRole(req, ...VERIFIERS);
      const { finding_id } = req.params as { finding_id: string };
      const body = req.body as S['DecisionRequest'];
      const finding = decide(db, finding_id, user, body);
      req.audit = {
        object_id: finding.object_id,
        entity_type: 'finding',
        entity_id: finding_id,
        details: { action: body.action, reason_code: body.reason_code, comment: body.comment, param_code: finding.param_code },
      };
      return finding;
    },

    async splitFinding(req) {
      requireRole(req, ...VERIFIERS);
      const { finding_id } = req.params as { finding_id: string };
      const body = req.body as S['SplitRequest'];
      const parts = split(db, finding_id, body);
      req.audit = { entity_type: 'finding', entity_id: finding_id, details: { parts: body.parts.map((p) => p.rule_key) } };
      return parts;
    },

    async editFindingEvidence(req) {
      const user = requireRole(req, ...VERIFIERS);
      const { finding_id } = req.params as { finding_id: string };
      const body = req.body as S['EvidenceEditRequest'];
      const finding = editEvidence(db, finding_id, user, body);
      req.audit = {
        object_id: finding.object_id,
        entity_type: 'finding',
        entity_id: finding_id,
        details: { added: body.add?.length ?? 0, removed: body.remove_fragment_ids?.length ?? 0, reason: body.reason, reference: body.reference },
      };
      return finding;
    },

    async bulkDecideFindings(req) {
      const user = requireRole(req, ...VERIFIERS);
      const body = req.body as S['BulkDecisionRequest'];
      const items = bulkDecide(db, body.finding_ids, user, body);
      req.audit = {
        object_id: items[0]?.object_id ?? null,
        entity_type: 'finding',
        details: { action: body.action, count: items.length, param_code: items[0]?.param_code, comment: body.comment },
      };
      return items;
    },

    async listSuspicions(req) {
      const { process_id } = req.params as { process_id: string };
      const proc = getProcessRow(db, process_id);
      if (!proc.current_protocol_id) return [];
      return db
        .all(
          "SELECT * FROM suspicions WHERE protocol_id = ? ORDER BY CASE review_priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, confidence DESC",
          proc.current_protocol_id as string,
        )
        .map(mapSuspicion);
    },

    async decideSuspicion(req) {
      requireRole(req, ...VERIFIERS);
      const { suspicion_id } = req.params as { suspicion_id: string };
      const body = req.body as S['SuspicionDecisionRequest'];
      const s = suspicionRow(suspicion_id);
      const proc = getProcessRow(db, s.process_id as string);
      if (proc.status === 'FINALIZED') throw conflict('Протокол финализирован', 'PROCESS_FINALIZED');
      if (s.inspector_status === 'PROMOTED') throw conflict('Гипотеза уже переведена в кандидата');
      db.update(
        'suspicions',
        { inspector_status: body.action === 'DISMISS' ? 'DISMISSED' : 'CLARIFICATION_REQUIRED', comment: body.comment, updated_at: nowIso() },
        'id = ?',
        suspicion_id,
      );
      req.audit = { object_id: s.object_id as string, entity_type: 'suspicion', entity_id: suspicion_id, details: { ...body } };
      return mapSuspicion(suspicionRow(suspicion_id));
    },

    async promoteSuspicion(req) {
      requireRole(req, ...VERIFIERS);
      const { suspicion_id } = req.params as { suspicion_id: string };
      const body = req.body as S['PromoteSuspicionRequest'];
      const s = suspicionRow(suspicion_id);
      const proc = getProcessRow(db, s.process_id as string);
      if (proc.status === 'FINALIZED') throw conflict('Протокол финализирован', 'PROCESS_FINALIZED');
      if (proc.current_protocol_id !== s.protocol_id) throw conflict('Гипотеза из устаревшей версии протокола', 'STALE_PROTOCOL');
      if (s.inspector_status === 'PROMOTED') throw conflict('Гипотеза уже переведена в кандидата');
      if (!body.fragments?.length) throw badRequest('Для перевода в кандидата нужны доказательства с координатами');
      const fileIds = new Set(listFiles(db, s.process_id as string).map((f) => f.id));
      for (const f of body.fragments) if (!fileIds.has(f.file_id)) throw badRequest(`Файл ${f.file_id} не относится к проверке`);
      const param = db.get<{ id: number; review_priority: string }>('SELECT id, review_priority FROM params WHERE code = ?', body.param_code);
      const ruleKey = `suspicion:${s.suspicion_key as string}`;
      const checkId = randomUUID();
      const groupId = randomUUID();
      const now = nowIso();
      db.tx(() => {
        db.insert('evidence_groups', { id: groupId, object_id: s.object_id as string, param_code: body.param_code, rule_key: ruleKey, created_at: now });
        for (const f of body.fragments) {
          db.insert('evidence_fragments', {
            id: randomUUID(),
            evidence_group_id: groupId,
            role: f.role,
            file_id: f.file_id,
            sha256: f.sha256,
            stage: f.stage,
            document_code: f.document_code ?? null,
            revision: f.revision ?? null,
            approval_status: f.approval_status ?? null,
            page: f.page,
            sheet: f.sheet ?? null,
            bbox: JSON.stringify(f.bbox),
            polygon: f.polygon ? JSON.stringify(f.polygon) : null,
            extracted_value: f.extracted_value ?? null,
            normalized_value: f.normalized_value ?? null,
            text_snippet: f.text_snippet ?? null,
            source: f.source ?? 'TEXT_LAYER',
            extraction_method: f.extraction_method ?? null,
            quality: f.quality ?? 'OK',
            confidence: f.confidence ?? 1,
          });
        }
        db.insert('checks', {
          id: checkId,
          protocol_id: s.protocol_id as string,
          process_id: s.process_id as string,
          object_id: s.object_id as string,
          param_id: param?.id ?? null,
          param_code: body.param_code,
          finding_key: findingKey(s.object_id as string, body.param_code, ruleKey),
          rule_key: ruleKey,
          finding_status: 'CANDIDATE',
          model_finding_status: 'CANDIDATE',
          completeness_status: 'COMPLETE',
          inspector_status: 'PENDING',
          stages_compared: JSON.stringify([...new Set(body.fragments.map((f) => f.stage))]),
          expected_value: body.expected_value ?? null,
          actual_value: body.actual_value ?? null,
          review_priority: (param?.review_priority as string) ?? (s.review_priority as string),
          risk_level: s.review_priority as string,
          rationale: `Из гипотезы: ${s.description as string}${body.comment ? `. ${body.comment}` : ''}`,
          rationale_source: 'RULES',
          normative_reference: (s.normative_base as string) ?? null,
          confidence: s.confidence as number,
          evidence_group_id: groupId,
          page_pair_id: (s.page_pair_id as string) ?? null,
          created_at: now,
          updated_at: now,
        });
        db.update('suspicions', { inspector_status: 'PROMOTED', promoted_check_id: checkId, comment: body.comment ?? null, updated_at: now }, 'id = ?', suspicion_id);
        syncVerificationStatus(db, s.process_id as string);
      });
      req.audit = { object_id: s.object_id as string, entity_type: 'suspicion', entity_id: suspicion_id, details: { check_id: checkId } };
      return mapFinding(db, getCheckRow(db, checkId));
    },

  };
}
