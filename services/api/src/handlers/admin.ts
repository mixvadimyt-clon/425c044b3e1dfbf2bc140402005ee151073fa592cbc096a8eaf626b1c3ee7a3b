import { randomUUID } from 'node:crypto';
import { type AppContext, type Handlers, currentUser, paging, requireRole } from '../context.js';
import { type Row, nowIso, parseJson } from '../db/sqlite.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { listParams, mapParam, snapshotMatrix } from '../modules/matrix.js';
import { RuleSyntaxError, parseRule } from '../modules/rules-dsl.js';
import type { S } from '../types.js';

const mapNormative = (r: Row): S['NormativeDoc'] => ({
  id: r.id as string,
  document_name: r.document_name as string,
  document_number: r.document_number as string,
  section: (r.section as string) ?? null,
  parameter_name: (r.parameter_name as string) ?? null,
  min_value: (r.min_value as number) ?? null,
  max_value: (r.max_value as number) ?? null,
  effective_from: (r.effective_from as string) ?? null,
  effective_to: (r.effective_to as string) ?? null,
});

const mapRule = (r: Row): S['LogicalRule'] => ({
  id: r.id as string,
  rule_name: r.rule_name as string,
  condition: r.condition as string,
  expected: r.expected as string,
  normative_base: (r.normative_base as string) ?? null,
  review_priority: r.review_priority as S['ReviewPriority'],
  is_active: r.is_active === 1,
});

const mapDatasetItem = (r: Row): S['DatasetItem'] => ({
  id: r.id as string,
  evidence_group_id: r.evidence_group_id as string,
  finding_id: r.check_id as string,
  param_code: r.param_code as string,
  gold_label: r.gold_label as S['GoldLabel'],
  expert_id: r.expert_id as string,
  reason_code: (r.reason_code as S['ReasonCode']) ?? null,
  curation_status: r.curation_status as S['CurationStatus'],
  dataset_version: (r.dataset_version as string) ?? null,
  split: (r.split as S['DatasetSplit']) ?? null,
  object_group_id: r.object_group_id as string,
  created_at: r.created_at as string,
});

function paramValues(body: S['MatrixParamInput']) {
  if (!/^[A-ZА-Я0-9]+-\d+[A-Za-z0-9.]*$/u.test(body.code)) throw badRequest('Код параметра должен быть вида M-055');
  if (body.min_value != null && body.max_value != null && body.min_value > body.max_value) {
    throw badRequest('min_value не может быть больше max_value');
  }
  if (body.regex_pattern) {
    // Выражения исполняет ML (синтаксис Python re). Грубая проверка через JS: без inline-флагов вида (?i)
    try {
      new RegExp(body.regex_pattern.replace(/^\(\?[aiLmsux]+\)/, ''), 'u');
    } catch {
      throw badRequest('regex_pattern: некорректное регулярное выражение');
    }
  }
  return {
    code: body.code,
    external_code: body.external_code ?? null,
    section: body.section,
    parameter_name: body.parameter_name,
    unit: body.unit ?? null,
    source_pd: body.source_pd ?? null,
    source_rd: body.source_rd ?? null,
    source_id: body.source_id ?? null,
    trigger_logic: body.trigger_logic ?? null,
    review_priority: body.review_priority,
    sp_reference: body.sp_reference ?? null,
    gost_reference: body.gost_reference ?? null,
    fz_reference: body.fz_reference ?? null,
    other_normative: body.other_normative ?? null,
    data_type: body.data_type,
    min_value: body.min_value ?? null,
    max_value: body.max_value ?? null,
    regex_pattern: body.regex_pattern ?? null,
    semantic_anchors: JSON.stringify(body.semantic_anchors ?? []),
    enum_values: JSON.stringify(body.enum_values ?? []),
    is_active: body.is_active === false ? 0 : 1,
    updated_at: nowIso(),
  };
}

/**
 * Правило проверяется при сохранении: движок молча пропускает неверное
 * правило, и опечатка жила бы незамеченной. Неизвестный код параметра — тоже отказ: такое
 * правило никогда не сработает.
 */
function checkRule(db: AppContext['db'], body: S['LogicalRuleInput']): void {
  const known = new Set(db.all<{ code: string }>('SELECT code FROM params').map((r) => r.code.toUpperCase()));
  for (const [field, text] of [
    ['condition', body.condition],
    ['expected', body.expected],
  ] as const) {
    let refs: Set<string>;
    try {
      refs = parseRule(text);
    } catch (err) {
      if (err instanceof RuleSyntaxError) throw badRequest(`${field}: ${err.message}`, { field }, 'RULE_INVALID');
      throw err;
    }
    const unknown = [...refs].map((r) => r.slice(0, r.lastIndexOf('.'))).filter((code) => !known.has(code));
    if (unknown.length) {
      throw badRequest(`${field}: параметров нет в матрице: ${[...new Set(unknown)].join(', ')}`, { field, unknown }, 'RULE_INVALID');
    }
  }
}

export function adminHandlers(ctx: AppContext): Handlers {
  const { db } = ctx;
  const paramRow = (id: number): Row => {
    const r = db.get('SELECT * FROM params WHERE id = ?', id);
    if (!r) throw notFound('Параметр');
    return r;
  };

  return {
    // ------------------------------------------------------------- матрица
    async listParams(req) {
      const q = req.query as { section?: string; is_active?: boolean; q?: string };
      return listParams(db, q);
    },

    async getParam(req) {
      const { param_id } = req.params as { param_id: number };
      return mapParam(paramRow(Number(param_id)));
    },

    async createParam(req, reply) {
      const user = requireRole(req, 'ADMIN');
      const body = req.body as S['MatrixParamInput'];
      if (db.get('SELECT 1 FROM params WHERE code = ?', body.code)) throw conflict(`Параметр ${body.code} уже существует`, 'DUPLICATE');
      const { lastInsertRowid } = db.tx(() => {
        const res = db.insert('params', { ...paramValues(body), created_at: nowIso() });
        const version = snapshotMatrix(db, `Добавлен параметр ${body.code}`, user.id);
        req.audit = { entity_type: 'param', entity_id: body.code, details: { matrix_version: version } };
        return res;
      });
      reply.code(201);
      return mapParam(paramRow(lastInsertRowid));
    },

    async updateParam(req) {
      const user = requireRole(req, 'ADMIN');
      const { param_id } = req.params as { param_id: number };
      const body = req.body as S['MatrixParamInput'];
      const prev = paramRow(Number(param_id));
      const clash = db.get<{ id: number }>('SELECT id FROM params WHERE code = ?', body.code);
      if (clash && clash.id !== Number(param_id)) throw conflict(`Код ${body.code} уже занят`, 'DUPLICATE');
      db.tx(() => {
        db.update('params', paramValues(body), 'id = ?', Number(param_id));
        const version = snapshotMatrix(db, `Изменён параметр ${body.code}`, user.id);
        req.audit = { entity_type: 'param', entity_id: body.code, details: { matrix_version: version, before: mapParam(prev), after: body } };
      });
      return mapParam(paramRow(Number(param_id)));
    },

    async deactivateParam(req, reply) {
      const user = requireRole(req, 'ADMIN');
      const { param_id } = req.params as { param_id: number };
      const prev = paramRow(Number(param_id));
      db.tx(() => {
        db.update('params', { is_active: 0, updated_at: nowIso() }, 'id = ?', Number(param_id));
        const version = snapshotMatrix(db, `Деактивирован параметр ${prev.code as string}`, user.id);
        req.audit = { entity_type: 'param', entity_id: prev.code as string, details: { matrix_version: version } };
      });
      reply.code(204);
      return null;
    },

    async listMatrixVersions() {
      return db.all('SELECT * FROM matrix_versions ORDER BY created_at DESC, rowid DESC').map(
        (r): S['MatrixVersion'] => ({
          version: r.version as string,
          params_count: r.params_count as number,
          comment: (r.comment as string) ?? undefined,
          created_by: (r.created_by as string) ?? undefined,
          created_at: r.created_at as string,
        }),
      );
    },

    // ---------------------------------------------------- нормативная база
    async listNormativeDocs() {
      return db.all('SELECT * FROM normative_base ORDER BY document_name').map(mapNormative);
    },

    async createNormativeDoc(req, reply) {
      requireRole(req, 'ADMIN');
      const body = req.body as S['NormativeDocInput'];
      const id = randomUUID();
      db.insert('normative_base', { id, ...body, created_at: nowIso(), updated_at: nowIso() });
      req.audit = { entity_type: 'normative_doc', entity_id: id, details: { ...body } };
      reply.code(201);
      return mapNormative(db.get('SELECT * FROM normative_base WHERE id = ?', id)!);
    },

    async updateNormativeDoc(req) {
      requireRole(req, 'ADMIN');
      const { normative_doc_id } = req.params as { normative_doc_id: string };
      const body = req.body as S['NormativeDocInput'];
      if (!db.update('normative_base', { ...body, updated_at: nowIso() }, 'id = ?', normative_doc_id)) throw notFound('Нормативный документ');
      req.audit = { entity_type: 'normative_doc', entity_id: normative_doc_id, details: { ...body } };
      return mapNormative(db.get('SELECT * FROM normative_base WHERE id = ?', normative_doc_id)!);
    },

    async deactivateNormativeDoc(req, reply) {
      requireRole(req, 'ADMIN');
      const { normative_doc_id } = req.params as { normative_doc_id: string };
      const today = nowIso().slice(0, 10);
      if (!db.update('normative_base', { effective_to: today, updated_at: nowIso() }, 'id = ?', normative_doc_id)) throw notFound('Нормативный документ');
      req.audit = { entity_type: 'normative_doc', entity_id: normative_doc_id };
      reply.code(204);
      return null;
    },

    // --------------------------------------------------- логические правила
    async listLogicalRules() {
      return db.all('SELECT * FROM logical_rules ORDER BY rule_name').map(mapRule);
    },

    async createLogicalRule(req, reply) {
      requireRole(req, 'ADMIN');
      const body = req.body as S['LogicalRuleInput'];
      checkRule(db, body);
      const id = randomUUID();
      db.insert('logical_rules', {
        id,
        rule_name: body.rule_name,
        condition: body.condition,
        expected: body.expected,
        normative_base: body.normative_base ?? null,
        review_priority: body.review_priority ?? 'MEDIUM',
        is_active: body.is_active === false ? 0 : 1,
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      req.audit = { entity_type: 'logical_rule', entity_id: id, details: { ...body } };
      reply.code(201);
      return mapRule(db.get('SELECT * FROM logical_rules WHERE id = ?', id)!);
    },

    async updateLogicalRule(req) {
      requireRole(req, 'ADMIN');
      const { rule_id } = req.params as { rule_id: string };
      const body = req.body as S['LogicalRuleInput'];
      checkRule(db, body);
      const changed = db.update(
        'logical_rules',
        {
          rule_name: body.rule_name,
          condition: body.condition,
          expected: body.expected,
          normative_base: body.normative_base ?? null,
          review_priority: body.review_priority ?? 'MEDIUM',
          is_active: body.is_active === false ? 0 : 1,
          updated_at: nowIso(),
        },
        'id = ?',
        rule_id,
      );
      if (!changed) throw notFound('Правило');
      req.audit = { entity_type: 'logical_rule', entity_id: rule_id, details: { ...body } };
      return mapRule(db.get('SELECT * FROM logical_rules WHERE id = ?', rule_id)!);
    },

    async deactivateLogicalRule(req, reply) {
      requireRole(req, 'ADMIN');
      const { rule_id } = req.params as { rule_id: string };
      if (!db.update('logical_rules', { is_active: 0, updated_at: nowIso() }, 'id = ?', rule_id)) throw notFound('Правило');
      req.audit = { entity_type: 'logical_rule', entity_id: rule_id };
      reply.code(204);
      return null;
    },

    // ---------------------------------------------------------------- аудит
    async listAudit(req) {
      requireRole(req, 'ADMIN', 'SUPERVISOR');
      const q = req.query as {
        page?: number;
        page_size?: number;
        user_id?: string;
        object_id?: string;
        action?: string;
        actor_type?: S['AuditEntry']['actor_type'];
        date_from?: string;
        date_to?: string;
      };
      const { page, pageSize, offset } = paging(q);
      const where: string[] = [];
      const args: string[] = [];
      for (const [col, val] of [
        ['a.user_id = ?', q.user_id],
        ['a.object_id = ?', q.object_id],
        ['a.action = ?', q.action],
        ['a.timestamp >= ?', q.date_from],
        ['a.timestamp <= ?', q.date_to],
      ] as const) {
        if (val) {
          where.push(col);
          args.push(val);
        }
      }
      // действия системы пишутся с action = system.* (orchestrator), всё остальное — запросы пользователей
      if (q.actor_type === 'SYSTEM') where.push("a.action LIKE 'system.%'");
      if (q.actor_type === 'USER') where.push("a.action NOT LIKE 'system.%'");
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log a ${w}`, ...args)!.n;
      const rows = db.all(
        `SELECT a.*, u.full_name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ${w}
         ORDER BY a.timestamp DESC, a.rowid DESC LIMIT ? OFFSET ?`,
        ...args,
        pageSize,
        offset,
      );
      return {
        items: rows.map(
          (r): S['AuditEntry'] => ({
            id: r.id as string,
            user_id: (r.user_id as string) ?? null,
            user_name: (r.user_name as string) ?? (String(r.action).startsWith('system.') ? 'Система «Инспектор ИИ»' : null),
            user_role: (r.user_role as S['UserRole']) ?? null,
            actor_type: String(r.action).startsWith('system.') ? 'SYSTEM' : 'USER',
            action: r.action as string,
            object_id: (r.object_id as string) ?? null,
            entity_type: (r.entity_type as string) ?? null,
            entity_id: (r.entity_id as string) ?? null,
            details: parseJson<Record<string, unknown>>(r.details, {}),
            timestamp: r.timestamp as string,
            ip_address: (r.ip_address as string) ?? null,
            user_agent: (r.user_agent as string) ?? null,
          }),
        ),
        total,
        page,
        page_size: pageSize,
      } satisfies S['AuditPage'];
    },

    // ----------------------------------------------------------- уведомления
    async listNotifications(req) {
      const user = currentUser(req);
      const { unread_only } = req.query as { unread_only?: boolean };
      const rows = db.all(
        `SELECT * FROM notifications
         WHERE (user_id = ? OR (user_id IS NULL AND (role IS NULL OR role = ?)))
         ${unread_only ? 'AND is_read = 0' : ''}
         ORDER BY created_at DESC, rowid DESC LIMIT 100`,
        user.id,
        user.role,
      );
      return rows.map(
        (r): S['Notification'] => ({
          id: r.id as string,
          type: r.type as S['Notification']['type'],
          message: r.message as string,
          process_id: (r.process_id as string) ?? null,
          object_id: (r.object_id as string) ?? null,
          is_read: r.is_read === 1,
          created_at: r.created_at as string,
        }),
      );
    },

    async markNotificationRead(req, reply) {
      currentUser(req);
      const { notification_id } = req.params as { notification_id: string };
      if (!db.update('notifications', { is_read: 1 }, 'id = ?', notification_id)) throw notFound('Уведомление');
      reply.code(204);
      return null;
    },

    // --------------------------------------------------------------- GOLD
    async listDatasetItems(req) {
      requireRole(req, 'ML_ENGINEER', 'ADMIN');
      const q = req.query as { page?: number; page_size?: number; curation_status?: string; dataset_version?: string };
      const { page, pageSize, offset } = paging(q);
      const where: string[] = [];
      const args: string[] = [];
      if (q.curation_status) {
        where.push('curation_status = ?');
        args.push(q.curation_status);
      }
      if (q.dataset_version) {
        where.push('dataset_version = ?');
        args.push(q.dataset_version);
      }
      const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM dataset_items ${w}`, ...args)!.n;
      const rows = db.all(`SELECT * FROM dataset_items ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...args, pageSize, offset);
      return { items: rows.map(mapDatasetItem), total, page, page_size: pageSize } satisfies S['DatasetItemPage'];
    },

    async curateDatasetItem(req) {
      const user = requireRole(req, 'ML_ENGINEER', 'ADMIN');
      const { item_id } = req.params as { item_id: string };
      const body = req.body as S['CurateRequest'];
      const released = db.get<{ dataset_version: string | null }>('SELECT dataset_version FROM dataset_items WHERE id = ?', item_id);
      if (released?.dataset_version) {
        throw conflict(`Запись уже выпущена в версии набора ${released.dataset_version}, выпущенные версии не меняются`, 'ITEM_RELEASED');
      }
      const changed = db.update(
        'dataset_items',
        { curation_status: body.curation_status, curated_by: user.id, curated_at: nowIso() },
        'id = ?',
        item_id,
      );
      if (!changed) throw notFound('Запись GOLD');
      req.audit = { entity_type: 'dataset_item', entity_id: item_id, details: { ...body } };
      return mapDatasetItem(db.get('SELECT * FROM dataset_items WHERE id = ?', item_id)!);
    },
  };
}
