import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Db } from '../../db/sqlite.js';
import type { S } from '../../types.js';
import type { LocalStorage } from '../storage.js';
import { renderDocx } from './docx.js';
import { buildGold } from './gold.js';
import { renderPdf } from './pdf.js';
import { buildReport, loadExportModel } from './report.js';
import { buildSubmission } from './submission.js';
import { renderXml } from './xml.js';

/**
 * Экспорт протокола (модуль 7, REQ-CMP-08). Отражает текущее состояние решений инспектора;
 * у финализированного протокола файл сохраняется в protocols/{process_id}/v{n}-{время финализации}.{ext} и больше не пересобирается:
 * после отмены финализации и повторной финализации ключ другой, и протокол собирается заново.
 */
export interface ExportResult {
  contentType: string;
  fileName: string;
  body: Buffer | string | object;
  cached: boolean;
}

const TYPES: Record<Exclude<S['ExportFormat'], 'json' | 'gold' | 'submission'>, { type: string; ext: string }> = {
  pdf: { type: 'application/pdf', ext: 'pdf' },
  docx: { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' },
  xml: { type: 'application/xml; charset=utf-8', ext: 'xml' },
};

export interface ExportOptions {
  /** Порог уверенности гипотез для FREE-* в submission. */
  freeMinConfidence?: number;
}

export async function exportProtocol(
  db: Db,
  storage: LocalStorage,
  protocolId: string,
  format: S['ExportFormat'],
  options: ExportOptions = {},
): Promise<ExportResult> {
  const model = loadExportModel(db, protocolId);
  const p = model.protocol;
  const base = `protocol-${p.process_id.slice(0, 8)}-v${p.version}`;
  if (format === 'json') return { contentType: 'application/json; charset=utf-8', fileName: `${base}.json`, body: p, cached: false };
  if (format === 'gold') return { contentType: 'application/json; charset=utf-8', fileName: `${base}.gold.json`, body: buildGold(db, model), cached: false };
  if (format === 'submission') {
    return { contentType: 'application/json; charset=utf-8', fileName: `${base}.submission.json`, body: buildSubmission(db, model, options.freeMinConfidence), cached: false };
  }

  const { type, ext } = TYPES[format];
  const finalized = p.status === 'PROTOCOL_FINALIZED';
  const key = `protocols/${p.process_id}/v${p.version}-${(p.finalized_at ?? '').replace(/\D/g, '')}.${ext}`;
  if (finalized && storage.exists(key)) {
    return { contentType: type, fileName: `${base}.${ext}`, body: readFileSync(storage.pathOf(key)), cached: true };
  }
  const report = buildReport(model);
  const body = format === 'pdf' ? await renderPdf(report) : format === 'docx' ? await renderDocx(report) : Buffer.from(renderXml(model), 'utf8');
  if (finalized) {
    const tmp = storage.tmpPath(randomUUID());
    writeFileSync(tmp, body);
    storage.commit(tmp, key);
  }
  return { contentType: type, fileName: `${base}.${ext}`, body, cached: false };
}


