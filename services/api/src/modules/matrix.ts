import type { Db, Row } from '../db/sqlite.js';
import { nowIso, parseJson, toBool } from '../db/sqlite.js';
import type { S } from '../types.js';

export function mapParam(r: Row): S['MatrixParam'] {
  return {
    id: r.id as number,
    code: r.code as string,
    external_code: (r.external_code as string) ?? null,
    section: r.section as string,
    parameter_name: r.parameter_name as string,
    unit: (r.unit as string) ?? null,
    source_pd: (r.source_pd as string) ?? null,
    source_rd: (r.source_rd as string) ?? null,
    source_id: (r.source_id as string) ?? null,
    trigger_logic: (r.trigger_logic as string) ?? null,
    review_priority: r.review_priority as S['ReviewPriority'],
    sp_reference: (r.sp_reference as string) ?? null,
    gost_reference: (r.gost_reference as string) ?? null,
    fz_reference: (r.fz_reference as string) ?? null,
    other_normative: (r.other_normative as string) ?? null,
    data_type: r.data_type as S['ParamDataType'],
    min_value: (r.min_value as number) ?? null,
    max_value: (r.max_value as number) ?? null,
    regex_pattern: (r.regex_pattern as string) ?? null,
    semantic_anchors: parseJson<string[]>(r.semantic_anchors, []),
    enum_values: parseJson<string[]>(r.enum_values, []),
    is_active: toBool(r.is_active),
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

export function listParams(db: Db, filter: { section?: string; is_active?: boolean; q?: string } = {}): S['MatrixParam'][] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.section) {
    where.push('section = ?');
    args.push(filter.section);
  }
  if (filter.is_active !== undefined) {
    where.push('is_active = ?');
    args.push(filter.is_active ? 1 : 0);
  }
  if (filter.q) {
    where.push('(code LIKE ? OR parameter_name LIKE ?)');
    args.push(`%${filter.q}%`, `%${filter.q}%`);
  }
  const sql = `SELECT * FROM params ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY code`;
  return db.all(sql, ...args).map(mapParam);
}

export function currentMatrixVersion(db: Db): string {
  return db.get<{ version: string }>('SELECT version FROM matrix_versions ORDER BY created_at DESC, rowid DESC LIMIT 1')?.version ?? 'm-0';
}

/** Новая версия матрицы — снимок всех параметров (вызывается после любого изменения params). */
export function snapshotMatrix(db: Db, comment: string | null, userId: string | null, forcedVersion?: string): string {
  const params = listParams(db);
  let version = forcedVersion;
  if (!version) {
    const n = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM matrix_versions')!.n;
    version = `m-0.${n + 1}`;
  }
  db.insert('matrix_versions', {
    version,
    params_snapshot: JSON.stringify(params),
    params_count: params.filter((p) => p.is_active).length,
    comment,
    created_by: userId,
    created_at: nowIso(),
  });
  return version;
}
