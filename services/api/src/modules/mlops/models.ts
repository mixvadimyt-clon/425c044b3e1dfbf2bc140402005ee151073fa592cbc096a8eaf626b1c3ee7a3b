import { randomUUID } from 'node:crypto';
import { type Db, type Row, nowIso, parseJson } from '../../db/sqlite.js';
import { badRequest, conflict, notFound } from '../../errors.js';
import type { AuthUser, S } from '../../types.js';

/**
 * Реестр моделей и журнал дообучения (REQ-ML-04, REQ-ML-05): регистрация отчёта `inspector-ml train`,
 * приёмочные проверки (пороги §14 и регрессия не больше 2 п.п. против текущей модели), одобрение, отклонение, откат.
 * Текущая модель — последняя одобренная (по deployed_at); откат возвращает предыдущую или оставляет только правила.
 */

type Metrics = S['QualityMetrics'];
type Check = S['ThresholdCheck'];
const EPS = 1e-9;

/** Пороги §14 ТЗ (docs/TZ.md, «Приёмка качества»). Первые четыре обязательны для модели, остальные — если измерены. */
const LIMITS: { metric: keyof Metrics; kind: 'MIN' | 'MAX'; threshold: number; title: string; required: boolean }[] = [
  { metric: 'precision', kind: 'MIN', threshold: 0.9, title: 'Precision', required: true },
  { metric: 'recall', kind: 'MIN', threshold: 0.8, title: 'Recall', required: true },
  { metric: 'f1', kind: 'MIN', threshold: 0.85, title: 'F1', required: true },
  { metric: 'false_positive_rate', kind: 'MAX', threshold: 0.1, title: 'FPR', required: true },
  { metric: 'ocr_character_accuracy', kind: 'MIN', threshold: 0.95, title: 'OCR Character Accuracy', required: false },
  { metric: 'key_fields_exact_match', kind: 'MIN', threshold: 0.9, title: 'Exact Match ключевых полей', required: false },
  { metric: 'linking_accuracy', kind: 'MIN', threshold: 0.95, title: 'Связка документов', required: false },
  { metric: 'localization_accuracy', kind: 'MIN', threshold: 0.95, title: 'Локализация', required: false },
];
/** REQ-ML-04: Recall любой категории падает и FPR растёт не больше чем на 2 п.п. */
const MAX_REGRESSION = 0.02;

const fmt = (x: number) => x.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
const pp = (x: number) => `${(Math.abs(x) * 100).toFixed(1)} п.п.`;

function regression(metric: 'recall' | 'false_positive_rate', category: string | null, now: number | undefined, before: number): Check {
  const title = `${metric === 'recall' ? 'Recall' : 'FPR'}${category ? ` по категории «${category}»` : ''}`;
  const kind = metric === 'recall' ? 'MAX_DROP' : 'MAX_RISE';
  if (now === undefined || now === null) {
    return { metric, category, kind, value: null, threshold: MAX_REGRESSION, passed: false, message: `${title}: не измерен, а у текущей модели есть` };
  }
  const change = now - before;
  const bad = metric === 'recall' ? -change : change;
  const passed = bad <= MAX_REGRESSION + EPS;
  const verb = metric === 'recall' ? (change < 0 ? 'упал' : 'вырос') : change > 0 ? 'вырос' : 'снизился';
  return {
    metric,
    category,
    kind,
    value: change,
    threshold: MAX_REGRESSION,
    passed,
    message: `${title} ${verb} на ${pp(change)} против текущей модели (${fmt(before)} → ${fmt(now)})${passed ? '' : `, допустимо ${pp(MAX_REGRESSION)}`}`,
  };
}

/** Приёмочные проверки: пороги §14 и регрессия против текущей модели (если она есть). */
export function acceptanceChecks(metrics: Metrics, current: Metrics | null): Check[] {
  const checks: Check[] = [];
  for (const l of LIMITS) {
    const value = metrics[l.metric] as number | undefined;
    const sign = l.kind === 'MIN' ? '≥' : '≤';
    if (value === undefined || value === null) {
      if (l.required) checks.push({ metric: l.metric, category: null, kind: l.kind, value: null, threshold: l.threshold, passed: false, message: `${l.title}: не измерен` });
      continue;
    }
    const passed = l.kind === 'MIN' ? value >= l.threshold - EPS : value <= l.threshold + EPS;
    checks.push({
      metric: l.metric,
      category: null,
      kind: l.kind,
      value,
      threshold: l.threshold,
      passed,
      message: `${l.title} ${fmt(value)}${passed ? ` ${sign}` : `, а нужно ${sign}`} ${fmt(l.threshold)}`,
    });
  }
  if (current) {
    for (const metric of ['recall', 'false_positive_rate'] as const) {
      const before = current[metric];
      if (typeof before === 'number') checks.push(regression(metric, null, metrics[metric], before));
    }
    for (const [category, values] of Object.entries(current.per_category ?? {})) {
      for (const metric of ['recall', 'false_positive_rate'] as const) {
        const before = values?.[metric];
        if (typeof before === 'number') checks.push(regression(metric, category, metrics.per_category?.[category]?.[metric], before));
      }
    }
  }
  return checks;
}

export function currentModel(db: Db): Row | undefined {
  return db.get("SELECT * FROM model_versions WHERE approval_status = 'APPROVED' ORDER BY deployed_at DESC, rowid DESC LIMIT 1");
}

function mapModel(r: Row, currentVersion: string | null): S['ModelVersion'] {
  return {
    model_version: r.model_version as string,
    artifact_hash: (r.artifact_hash as string) ?? undefined,
    dataset_version: r.dataset_version as string,
    matrix_version: (r.matrix_version as string) ?? undefined,
    metrics: parseJson<Metrics>(r.metrics_json, {}),
    thresholds_passed: r.thresholds_passed === 1,
    approval_status: r.approval_status as S['ModelApprovalStatus'],
    approved_by: (r.approved_by as string) ?? null,
    deployed_at: (r.deployed_at as string) ?? null,
    rollback_to: (r.rollback_to as string) ?? null,
    previous_model_version: (r.previous_model_version as string) ?? null,
    training_params: parseJson<Record<string, unknown>>(r.training_params, {}),
    code_version: (r.code_version as string) ?? null,
    split_hashes: parseJson<Record<string, string>>(r.split_hashes, {}),
    threshold_checks: parseJson<Check[]>(r.threshold_checks, []),
    is_current: r.model_version === currentVersion,
    registered_by: (r.registered_by as string) ?? null,
    decided_at: (r.decided_at as string) ?? null,
    comment: (r.comment as string) ?? null,
    created_at: r.created_at as string,
  };
}

export function listModels(db: Db): S['ModelVersion'][] {
  const current = (currentModel(db)?.model_version as string) ?? null;
  return db.all('SELECT * FROM model_versions ORDER BY created_at DESC, rowid DESC').map((r) => mapModel(r, current));
}

function getModel(db: Db, version: string): S['ModelVersion'] {
  const row = db.get('SELECT * FROM model_versions WHERE model_version = ?', version);
  if (!row) throw notFound('Модель');
  return mapModel(row, (currentModel(db)?.model_version as string) ?? null);
}

function log(db: Db, row: Row, action: string, user: AuthUser, comment: string | null, details: Record<string, unknown>): void {
  const m = parseJson<Metrics>(row.metrics_json, {});
  db.insert('ml_retraining_log', {
    id: randomUUID(),
    model_version: row.model_version as string,
    dataset_version: row.dataset_version as string,
    split_hashes: (row.split_hashes as string) ?? null,
    precision: m.precision ?? null,
    recall: m.recall ?? null,
    f1: m.f1 ?? null,
    false_positive_rate: m.false_positive_rate ?? null,
    per_category_metrics: JSON.stringify(m.per_category ?? {}),
    approval_status: row.approval_status as string,
    approved_by: user.id,
    action,
    comment,
    details: JSON.stringify(details),
    created_at: nowIso(),
  });
}

const sameHashes = (a: Record<string, string>, b: Record<string, string>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);

export function registerModel(db: Db, user: AuthUser, body: S['ModelRegistration']): S['ModelVersion'] {
  const version = body.model_version?.trim() ?? '';
  if (!/^[\w.-]{1,64}$/.test(version)) throw badRequest('Версия модели: латиница, цифры, точка, дефис, до 64 символов (например scorer-2026.09.1)');
  if (db.get('SELECT 1 FROM model_versions WHERE model_version = ?', version)) throw conflict(`Модель ${version} уже зарегистрирована`, 'MODEL_EXISTS');
  const dataset = db.get('SELECT * FROM dataset_versions WHERE version = ?', body.dataset_version);
  if (!dataset) throw conflict(`Версии набора ${body.dataset_version} нет, обучать можно только на выпущенной версии`, 'DATASET_UNKNOWN');
  const expected = parseJson<Record<string, string>>(dataset.split_hashes, {});
  if (!sameHashes(expected, body.split_hashes ?? {})) {
    throw conflict(
      `Хеши частей набора не совпали с версией ${body.dataset_version}: модель обучена не на ней или выгрузка изменена`,
      'DATASET_HASH_MISMATCH',
      { expected, received: body.split_hashes },
    );
  }
  const current = currentModel(db);
  const checks = acceptanceChecks(body.metrics, current ? parseJson<Metrics>(current.metrics_json, {}) : null);
  const now = nowIso();
  db.tx(() => {
    db.insert('model_versions', {
      model_version: version,
      artifact_hash: body.artifact_hash,
      dataset_version: body.dataset_version,
      matrix_version: body.matrix_version ?? null,
      metrics_json: JSON.stringify(body.metrics),
      thresholds_passed: checks.every((c) => c.passed) ? 1 : 0,
      approval_status: 'PENDING',
      training_params: JSON.stringify(body.training_params ?? {}),
      code_version: body.code_version ?? null,
      split_hashes: JSON.stringify(body.split_hashes),
      threshold_checks: JSON.stringify(checks),
      registered_by: user.id,
      comment: body.comment ?? null,
      created_at: now,
    });
    log(db, db.get('SELECT * FROM model_versions WHERE model_version = ?', version)!, 'REGISTER', user, body.comment ?? null, {
      artifact_hash: body.artifact_hash,
      code_version: body.code_version ?? null,
      training_params: body.training_params ?? {},
      compared_with: current?.model_version ?? null,
      checks,
    });
  });
  return getModel(db, version);
}

export function decideModel(db: Db, user: AuthUser, version: string, body: S['ModelDecisionRequest']): S['ModelVersion'] {
  const comment = body.comment?.trim();
  if (!comment) throw badRequest('Решение по модели требует комментария (REQ-ML-04)', undefined, 'COMMENT_REQUIRED');
  const row = db.get('SELECT * FROM model_versions WHERE model_version = ?', version);
  if (!row) throw notFound('Модель');
  const current = currentModel(db);
  const now = nowIso();

  if (body.action === 'APPROVE' || body.action === 'REJECT') {
    if (row.approval_status !== 'PENDING') throw conflict(`Решение уже принято: ${row.approval_status}`, 'INVALID_STATUS');
  }
  if (body.action === 'APPROVE') {
    const checks = acceptanceChecks(parseJson<Metrics>(row.metrics_json, {}), current ? parseJson<Metrics>(current.metrics_json, {}) : null);
    const failed = checks.filter((c) => !c.passed);
    db.update('model_versions', { threshold_checks: JSON.stringify(checks), thresholds_passed: failed.length ? 0 : 1 }, 'model_version = ?', version);
    if (failed.length) {
      throw conflict(`Модель не проходит приёмку: ${failed.map((c) => c.message).join('; ')}`, 'THRESHOLDS_FAILED', {
        failed: failed.map((c) => c.message),
      });
    }
    db.tx(() => {
      db.update(
        'model_versions',
        {
          approval_status: 'APPROVED',
          approved_by: user.id,
          deployed_at: now,
          decided_at: now,
          previous_model_version: (current?.model_version as string) ?? null,
          comment,
        },
        'model_version = ?',
        version,
      );
      log(db, db.get('SELECT * FROM model_versions WHERE model_version = ?', version)!, 'APPROVE', user, comment, {
        replaces: current?.model_version ?? null,
        checks,
      });
    });
  } else if (body.action === 'REJECT') {
    db.tx(() => {
      db.update('model_versions', { approval_status: 'REJECTED', approved_by: user.id, decided_at: now, comment }, 'model_version = ?', version);
      log(db, db.get('SELECT * FROM model_versions WHERE model_version = ?', version)!, 'REJECT', user, comment, {});
    });
  } else {
    if (current?.model_version !== version) {
      throw conflict('Откатить можно только текущую модель', 'INVALID_STATUS', { current: current?.model_version ?? null });
    }
    const previous = row.previous_model_version as string | null;
    db.tx(() => {
      db.update(
        'model_versions',
        { approval_status: 'ROLLED_BACK', rollback_to: previous, decided_at: now, approved_by: user.id, comment },
        'model_version = ?',
        version,
      );
      // предыдущая снова становится текущей; её нет — работаем без модели (только правила)
      if (previous) db.update('model_versions', { deployed_at: now }, "model_version = ? AND approval_status = 'APPROVED'", previous);
      log(db, db.get('SELECT * FROM model_versions WHERE model_version = ?', version)!, 'ROLLBACK', user, comment, { rollback_to: previous });
    });
  }
  return getModel(db, version);
}
