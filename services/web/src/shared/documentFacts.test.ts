import { describe, expect, it } from 'vitest';
import { documentFacts, scanSharePercent } from './documentFacts';

describe('scanSharePercent', () => {
  it('переводит долю в проценты', () => {
    expect(scanSharePercent(0.43)).toBe('43 %');
    expect(scanSharePercent(0)).toBe('0 %');
    expect(scanSharePercent(1)).toBe('100 %');
  });

  it('не показывает то, чего нет или что вне диапазона', () => {
    expect(scanSharePercent(null)).toBeNull();
    expect(scanSharePercent(undefined)).toBeNull();
    expect(scanSharePercent(1.5)).toBeNull();
    expect(scanSharePercent(Number.NaN)).toBeNull();
  });
});

describe('documentFacts', () => {
  it('собирает строки только из определённых сведений', () => {
    expect(
      documentFacts({ project_code: 'ЖС-РД-270121', language: 'ru', scan_share: 0.43, pdf_version: 'PDF 1.7', pdf_producer: 'AutoCAD PDF', pdf_creator: 'Revit' }),
    ).toEqual(['шифр проекта: ЖС-РД-270121', 'язык: русский', 'сканов: 43 %', 'версия: PDF 1.7', 'записал: AutoCAD PDF', 'создан в: Revit']);
  });

  it('организация-разработчик идёт после шифра, у ИД (null) строки нет', () => {
    expect(documentFacts({ project_code: 'ЖС-РД-270121', developer_org: 'ООО «ТСП»' })).toEqual(['шифр проекта: ЖС-РД-270121', 'разработчик: ООО «ТСП»']);
    expect(documentFacts({ project_code: 'ЖС-РД-270121', developer_org: null })).toEqual(['шифр проекта: ЖС-РД-270121']);
  });

  it('у неразобранного файла сведений нет', () => {
    expect(documentFacts({ project_code: null, language: null, scan_share: null, pdf_producer: '  ' })).toEqual([]);
  });
});
