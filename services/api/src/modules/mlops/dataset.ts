import { createHash } from 'node:crypto';
import { type Db, type Row, nowIso, parseJson } from '../../db/sqlite.js';
import { badRequest, conflict, notFound } from '../../errors.js';
import type { AuthUser, S } from '../../types.js';
import { buildGold } from '../export/gold.js';
import { type ExportModel, loadExportModel } from '../export/report.js';

/**
 * Версии GOLD-набора (REQ-ML-01…03, 08): накопительный выпуск одобренных куратором записей с полным доказательством,
 * разбиение по объекту, снимок GOLD-записи на момент выпуска и SHA-256 каждой части.
 * Выгрузка версии — JSONL из снимков, поэтому хеши воспроизводятся байт в байт.
 */

type Split = S['DatasetSplit'];
export const SPLITS: Split[] = ['TRAIN', 'VALIDATION', 'HIDDEN_TEST'];
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** JSON с отсортированными ключами и без пробелов — одинаковые данные всегда дают одинаковые байты. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** Новый объект — в часть по sha256(object_id): детерминированно и без знания о других объектах. */
export function assignSplit(objectId: string, ratio: { train: number; validation: number; test: number }): Split {
  const u = createHash('sha256').update(objectId).digest().readUInt32BE(0) / 2 ** 32;
  const total = ratio.train + ratio.validation + ratio.test;
  if (u < ratio.train / total) return 'TRAIN';
  if (u < (ratio.train + ratio.validation) / total) return 'VALIDATION';
  return 'HIDDEN_TEST';
}

function ratioOf(r: S['DatasetReleaseRequest']['split_ratio']): { train: number; validation: number; test: number } {
  const ratio = { train: r?.train ?? 0.7, validation: r?.validation ?? 0.15, test: r?.test ?? 0.15 };
  if (Object.values(ratio).some((x) => !Number.isFinite(x) || x < 0) || ratio.train + ratio.validation + ratio.test <= 0) {
    throw badRequest('split_ratio: доли train, validation и test должны быть неотрицательными числами с ненулевой суммой', undefined, 'BAD_SPLIT_RATIO');
  }
  return ratio;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Почему запись нельзя выпускать (REQ-ML-08: «без полного доказательства finding не засчитывается»); null — можно. */
export function incompleteness(item: Row, record: S['GoldRecord'] | undefined): string | null {
  if (!record) return 'Нет GOLD-записи: проверка не найдена или не оценивалась';
  const expected = item.gold_label === 'POSITIVE' ? 'CONFIRMED_VIOLATION' : 'NEGATIVE_VERIFIED';
  if (record.finding_status !== expected) {
    return `Метка ${item.gold_label} расходится с текущим статусом проверки ${record.finding_status}`;
  }
  if (record.completeness_status !== 'COMPLETE') return `Полнота доказательств: ${record.completeness_status}`;
  for (const [role, list] of [
    ['ожидаемого значения', record.source_expected],
    ['фактического значения', record.source_actual],
  ] as const) {
    if (!list?.length) return `Нет доказательства ${role}`;
    for (const src of list) {
      const where = `${src.stage ?? '?'} стр. ${src.page ?? '?'}`;
      if (!src.file_id) return `Доказательство ${role} (${where}) без file_id`;
      if (!HEX64.test(src.sha256 ?? '')) return `Доказательство ${role} (${where}) без SHA-256 файла`;
      if (!src.page || src.page < 1) return `Доказательство ${role} без номера страницы`;
      if (!src.bbox_polygon || src.bbox_polygon.length < 4) return `Доказательство ${role} (${where}) без bbox`;
    }
  }
  return null;
}

/** Строки выгрузки версии по частям (внутри части — по item_id). */
function versionLines(db: Db, version: string): Map<Split, { line: string; row: Row }[]> {
  const target = db.get<{ rowid: number }>('SELECT rowid FROM dataset_versions WHERE version = ?', version);
  if (!target) throw notFound('Версия набора');
  const rows = db.all(
    `SELECT i.* FROM dataset_items i JOIN dataset_versions v ON v.version = i.dataset_version
     WHERE v.rowid <= ? AND i.record IS NOT NULL ORDER BY i.id`,
    target.rowid,
  );
  const parts = new Map<Split, { line: string; row: Row }[]>(SPLITS.map((s) => [s, []]));
  for (const r of rows) {
    const line = canonicalJson({
      item_id: r.id,
      split: r.split,
      gold_label: r.gold_label,
      released_in: r.dataset_version,
      param_code: r.param_code,
      object_group_id: r.object_group_id,
      reason_code: r.reason_code ?? null,
      record: JSON.parse(r.record as string),
    });
    parts.get(r.split as Split)?.push({ line, row: r });
  }
  return parts;
}

export function exportDataset(db: Db, version: string, split?: Split): string {
  const parts = versionLines(db, version);
  return (split ? [split] : SPLITS).flatMap((s) => parts.get(s)!.map((x) => `${x.line}\n`)).join('');
}

export function mapDatasetVersion(r: Row): S['DatasetVersion'] {
  return {
    version: r.version as string,
    items_count: r.items_count as number,
    positives: r.positives as number,
    negatives: r.negatives as number,
    split_hashes: parseJson<Record<string, string>>(r.split_hashes, {}),
    split_counts: parseJson<Record<string, number>>(r.split_counts, {}),
    objects_by_split: parseJson<Record<string, string[]>>(r.objects_by_split, {}),
    new_items: r.new_items as number,
    comment: (r.comment as string) ?? null,
    created_by: (r.created_by as string) ?? undefined,
    created_at: r.created_at as string,
  };
}

export function listDatasetVersions(db: Db): S['DatasetVersion'][] {
  return db.all('SELECT * FROM dataset_versions ORDER BY rowid DESC').map(mapDatasetVersion);
}

export function releaseDataset(db: Db, user: AuthUser, body: S['DatasetReleaseRequest']): S['DatasetVersion'] {
  const version = body.version?.trim() ?? '';
  if (!/^[\w.-]{1,64}$/.test(version)) throw badRequest('Версия набора: латиница, цифры, точка, дефис, до 64 символов (например ds-2026.09.1)');
  if (db.get('SELECT 1 FROM dataset_versions WHERE version = ?', version)) throw conflict(`Версия ${version} уже выпущена`, 'VERSION_EXISTS');
  const ratio = ratioOf(body.split_ratio);

  // часть объекта фиксируется при первом выпуске и больше не меняется (HIDDEN_TEST — заранее)
  const splitOfObject = new Map(
    db
      .all<{ object_group_id: string; split: Split }>('SELECT DISTINCT object_group_id, split FROM dataset_items WHERE dataset_version IS NOT NULL')
      .map((r) => [r.object_group_id, r.split]),
  );
  // явная часть (когда объектов мало, хеш может положить все в одну часть и оставить VALIDATION пустым)
  const pinned = new Map(Object.entries(body.object_splits ?? {}));
  const moved = [...pinned]
    .filter(([objectId, split]) => splitOfObject.has(objectId) && splitOfObject.get(objectId) !== split)
    .map(([objectId, split]) => ({ object_id: objectId, split: splitOfObject.get(objectId)!, requested: split }));
  if (moved.length) {
    throw conflict(
      `Часть объекта не меняется после первого выпуска (REQ-ML-03): ${moved.map((m) => `${m.object_id} уже в ${m.split}`).join('; ')}`,
      'SPLIT_FIXED',
      { objects: moved },
    );
  }
  const candidates = db.all("SELECT * FROM dataset_items WHERE curation_status = 'APPROVED' AND dataset_version IS NULL ORDER BY created_at, id");

  const models = new Map<string, S['GoldRecord'][]>();
  const recordsOf = (protocolId: string): S['GoldRecord'][] => {
    if (!models.has(protocolId)) {
      const m: ExportModel = loadExportModel(db, protocolId);
      models.set(protocolId, buildGold(db, m).records);
    }
    return models.get(protocolId)!;
  };

  const excluded: NonNullable<S['DatasetVersion']['excluded']> = [];
  const accepted: { item: Row; split: Split; snapshot: S['GoldRecord'] }[] = [];
  for (const item of candidates) {
    const check = db.get<{ protocol_id: string }>('SELECT protocol_id FROM checks WHERE id = ?', item.check_id as string);
    const record = check ? recordsOf(check.protocol_id).find((r) => r.internal_id === item.check_id) : undefined;
    const reason = incompleteness(item, record);
    if (reason) {
      excluded.push({ item_id: item.id as string, param_code: item.param_code as string, reason });
      continue;
    }
    const objectId = item.object_group_id as string;
    const split = splitOfObject.get(objectId) ?? pinned.get(objectId) ?? assignSplit(objectId, ratio);
    splitOfObject.set(objectId, split);
    accepted.push({ item, split, snapshot: { ...record!, split, dataset_version: version } });
  }
  if (!accepted.length) {
    throw conflict(
      candidates.length
        ? `Нечего выпускать: ни одна из ${candidates.length} одобренных записей не прошла проверку полноты доказательств`
        : 'Нечего выпускать: нет одобренных куратором записей вне выпущенных версий',
      'NOTHING_TO_RELEASE',
      { excluded },
    );
  }
  const unknown = [...pinned.keys()].filter((objectId) => !splitOfObject.has(objectId));
  if (unknown.length) {
    throw badRequest(
      `В object_splits объекты без одобренных записей с полным доказательством в этом выпуске: ${unknown.join(', ')}`,
      { objects: unknown, excluded },
      'UNKNOWN_OBJECT',
    );
  }

  const now = nowIso();
  db.tx(() => {
    db.insert('dataset_versions', {
      version,
      items_count: 0,
      positives: 0,
      negatives: 0,
      split_hashes: '{}',
      comment: body.comment ?? null,
      created_by: user.id,
      created_at: now,
      new_items: accepted.length,
    });
    for (const a of accepted) {
      db.update('dataset_items', { dataset_version: version, split: a.split, record: canonicalJson(a.snapshot) }, 'id = ?', a.item.id as string);
    }
    const parts = versionLines(db, version);
    const all = SPLITS.flatMap((s) => parts.get(s)!);
    db.update(
      'dataset_versions',
      {
        items_count: all.length,
        positives: all.filter((x) => x.row.gold_label === 'POSITIVE').length,
        negatives: all.filter((x) => x.row.gold_label === 'NEGATIVE').length,
        split_hashes: JSON.stringify(Object.fromEntries(SPLITS.map((s) => [s, sha256(parts.get(s)!.map((x) => `${x.line}\n`).join(''))]))),
        split_counts: JSON.stringify(Object.fromEntries(SPLITS.map((s) => [s, parts.get(s)!.length]))),
        objects_by_split: JSON.stringify(
          Object.fromEntries(SPLITS.map((s) => [s, [...new Set(parts.get(s)!.map((x) => x.row.object_group_id as string))].sort()])),
        ),
      },
      'version = ?',
      version,
    );
  });
  return { ...mapDatasetVersion(db.get('SELECT * FROM dataset_versions WHERE version = ?', version)!), excluded };
}
