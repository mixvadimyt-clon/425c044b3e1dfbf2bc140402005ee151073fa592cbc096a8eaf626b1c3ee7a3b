/**
 * Сведения о документе от ML в FileInfo (контракт 0.20.0; developer_org — 0.21.0).
 * Api хранит словарь метаданных разбора целиком и отдаёт из него только проверенные значения.
 */
import { describe, expect, it } from 'vitest';
import { mapFile } from '../src/modules/repo.js';

const row = (metadata: unknown) => ({
  id: 'f1',
  object_id: 'o1',
  process_id: 'p1',
  original_name: 'КР.pdf',
  format: 'PDF',
  size_bytes: 1024,
  file_hash: 'ab',
  processing_status: 'PARSED',
  file_path: 'raw/ab',
  uploaded_at: '2026-09-25T10:00:00Z',
  metadata: metadata === undefined ? null : JSON.stringify(metadata),
});

describe('сведения о документе в FileInfo', () => {
  it('значения от ML доходят как есть', () => {
    const f = mapFile(
      row({ project_code: 'ЖС-РД-270121', language: 'mixed', scan_share: 0.43, pdf_version: 'PDF 1.7', pdf_producer: 'AutoCAD PDF', pdf_creator: 'Revit', encrypted: false, developer_org: 'ООО «ТСП»' }),
    );
    expect(f).toMatchObject({ project_code: 'ЖС-РД-270121', language: 'mixed', scan_share: 0.43, pdf_version: 'PDF 1.7', pdf_producer: 'AutoCAD PDF', pdf_creator: 'Revit', encrypted: false, developer_org: 'ООО «ТСП»' });
  });

  it('файл не разобран или ML не определил — null, а не пустая строка', () => {
    for (const metadata of [undefined, {}, { project_code: '  ', language: null }]) {
      expect(mapFile(row(metadata))).toMatchObject({ project_code: null, language: null, scan_share: null, pdf_producer: null, encrypted: null, developer_org: null });
    }
  });

  it('значение не по контракту не выходит наружу: язык вне перечня, доля вне 0…1, строка вместо флага', () => {
    const f = mapFile(row({ language: 'de', scan_share: 1.5, encrypted: 'yes', pdf_version: 17 }));
    expect(f).toMatchObject({ language: null, scan_share: null, encrypted: null, pdf_version: null });
  });
});
