import type { Db } from '../../db/sqlite.js';
import { badRequest } from '../../errors.js';
import type { S } from '../../types.js';
import { currentModel } from './models.js';

/**
 * Еженедельный отчёт для ML-инженеров (REQ-ML-06, модуль 10): решения инспекторов за ISO-неделю,
 * отклонения по причинам, разделам и параметрам, рекомендации — что чинить в первую очередь.
 * Неделя — по московскому времени (UTC+3): понедельник 00:00 — следующий понедельник 00:00.
 */

const DAY = 86_400_000;
const MSK = 3 * 3_600_000;

/** ISO-неделя момента по московскому времени. */
export function isoWeekOf(instant: Date): string {
  const local = new Date(instant.getTime() + MSK);
  const t = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  const weekday = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - weekday); // четверг той же недели определяет год
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / DAY + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Границы недели «YYYY-Www» как моменты UTC. */
export function weekBounds(week: string): { start: Date; end: Date } {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) throw badRequest('Неделя в формате YYYY-Www, например 2026-W38', undefined, 'BAD_WEEK');
  const [year, num] = [Number(m[1]), Number(m[2])];
  const jan4 = Date.UTC(year, 0, 4);
  const mondayLocal = jan4 - ((new Date(jan4).getUTCDay() || 7) - 1) * DAY + (num - 1) * 7 * DAY;
  const start = new Date(mondayLocal - MSK);
  if (num < 1 || isoWeekOf(start) !== week) throw badRequest(`Недели ${week} не существует`, undefined, 'BAD_WEEK');
  return { start, end: new Date(start.getTime() + 7 * DAY) };
}

/** Что делать по каждой причине отклонения (REQ-VER-03) — адресат и задача. */
const ADVICE: Record<string, string> = {
  WRONG_REVISION: 'выбор актуальной редакции и реестр файлов: кандидаты построены по неактуальным редакциям',
  APPROVED_CHANGE: 'согласованные изменения: учитывать извещения об изменениях и approved_change_ref до сравнения',
  OCR_ERROR: 'распознавание сканов: проверить качество страниц и OCR на отклонённых листах',
  LINKING_ERROR: 'связку документов и пары листов: значения сопоставлены не с тем документом или листом',
  EXTRACTION_ERROR: 'извлечение значений: не то значение или не та ячейка таблицы',
  PARAMETER_NOT_APPLICABLE: 'применимость параметров: параметр проверяется там, где не применим',
  NO_DISCREPANCY: 'пороги триггеров и нормализацию значений: расхождения нет, а кандидат есть',
  OTHER: 'комментарии инспекторов, причина в них не закодирована',
};

interface Decision {
  check_id: string;
  action: string;
  reason_code: string | null;
  param_code: string;
  section: string | null;
}

export function weeklyReport(db: Db, week?: string): S['WeeklyReport'] {
  const name = week ?? isoWeekOf(new Date());
  const { start, end } = weekBounds(name);
  const rows = db.all<Decision & { decided_at: string }>(
    `SELECT d.check_id, d.action, d.reason_code, d.decided_at, c.param_code, p.section
     FROM finding_decisions d JOIN checks c ON c.id = d.check_id LEFT JOIN params p ON p.code = c.param_code
     WHERE d.decided_at >= ? AND d.decided_at < ? ORDER BY d.decided_at, d.rowid`,
    start.toISOString(),
    end.toISOString(),
  );
  // по каждой проверке — последнее решение недели (передумал — считаем итог)
  const latest = new Map<string, Decision>();
  for (const r of rows) latest.set(r.check_id, r);
  const decisions = [...latest.values()];

  const count = (action: string) => decisions.filter((d) => d.action === action).length;
  const rejected = decisions.filter((d) => d.action === 'REJECT');
  const tally = (keyOf: (d: Decision) => string) =>
    rejected.reduce<Record<string, number>>((acc, d) => {
      const k = keyOf(d);
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
  const byReason = tally((d) => d.reason_code ?? 'OTHER');
  const bySection = tally((d) => d.section ?? '—');

  const perParam = new Map<string, { confirmed: number; rejected: number; reasons: Record<string, number> }>();
  for (const d of decisions) {
    if (d.action !== 'CONFIRM' && d.action !== 'REJECT') continue;
    const p = perParam.get(d.param_code) ?? { confirmed: 0, rejected: 0, reasons: {} };
    if (d.action === 'CONFIRM') p.confirmed++;
    else {
      p.rejected++;
      const reason = d.reason_code ?? 'OTHER';
      p.reasons[reason] = (p.reasons[reason] ?? 0) + 1;
    }
    perParam.set(d.param_code, p);
  }
  const topFp = [...perParam.entries()]
    .filter(([, p]) => p.rejected > 0)
    .map(([param_code, p]) => ({
      param_code,
      rejections: p.rejected,
      fp_rate: Math.round((p.rejected / (p.rejected + p.confirmed)) * 1000) / 1000,
      decided: p.rejected + p.confirmed,
      reasons: p.reasons,
    }))
    .sort((a, b) => b.rejections - a.rejections || b.fp_rate - a.fp_rate || a.param_code.localeCompare(b.param_code))
    .slice(0, 10);

  const drafts = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM dataset_items WHERE curation_status = 'DRAFT'")!.n;
  const unreleased = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM dataset_items WHERE curation_status = 'APPROVED' AND dataset_version IS NULL")!.n;
  const model = currentModel(db);

  const recommendations: string[] = [];
  for (const p of topFp) {
    if (p.rejections >= 2 && p.fp_rate >= 0.5) {
      const main = Object.entries(p.reasons).sort((a, b) => b[1] - a[1])[0][0];
      recommendations.push(
        `${p.param_code}: отклонено ${p.rejections} из ${p.decided} кандидатов (${Math.round(p.fp_rate * 100)} %). ` +
          `Смотреть в первую очередь ${ADVICE[main] ?? ADVICE.OTHER}.`,
      );
    }
  }
  const totalRejected = rejected.length;
  for (const [reason, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
    if (n / totalRejected >= 0.3 && n >= 2) recommendations.push(`Причина ${reason} в ${n} из ${totalRejected} отклонений: ${ADVICE[reason] ?? ADVICE.OTHER}.`);
  }
  const clarifications = count('CLARIFY');
  if (decisions.length >= 5 && clarifications / decisions.length >= 0.3) {
    recommendations.push(`Уточнений ${clarifications} из ${decisions.length} решений: инспекторам не хватает доказательств. Проверить полноту карточек и подсветку.`);
  }
  if (drafts) recommendations.push(`${drafts} записей GOLD ждут куратора: без одобрения они не попадут в набор (REQ-ML-02).`);
  if (unreleased) recommendations.push(`${unreleased} одобренных записей ещё не выпущены. Выпустите новую версию набора перед дообучением.`);
  if (!decisions.length) recommendations.push('За неделю решений нет: данных для оценки и дообучения не прибавилось.');
  else if (!totalRejected) recommendations.push('Отклонений нет: ложных срабатываний за неделю не выявлено.');

  return {
    week: name,
    period_start: start.toISOString(),
    period_end: end.toISOString(),
    generated_at: new Date().toISOString(),
    decisions_total: decisions.length,
    confirmed: count('CONFIRM'),
    rejected: totalRejected,
    clarifications,
    rejections_by_reason: byReason,
    rejections_by_section: bySection,
    top_false_positive_params: topFp.map(({ param_code, rejections, fp_rate }) => ({ param_code, rejections, fp_rate })),
    recommendations,
    gold_drafts: drafts,
    gold_approved_unreleased: unreleased,
    current_model_version: (model?.model_version as string) ?? null,
  };
}
