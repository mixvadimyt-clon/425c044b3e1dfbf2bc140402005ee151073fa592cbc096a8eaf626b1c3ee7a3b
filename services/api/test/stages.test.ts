import { describe, expect, it } from 'vitest';
import {
  computeCompleteness,
  computeScenario,
  computeUploadStatus,
  guessDiscipline,
  guessDocumentCode,
  guessRevision,
  guessStage,
  mergeUploadStatus,
} from '../src/modules/stages.js';

// Реальные имена из датасета «Алтуфьевское ш., 79Б»
const PD = [
  '1. П-2025-04.266-ПЗ.pdf',
  '1. Раздел 1 ЖС-РД-270121-П-ОПЗ 2024.pdf',
  '2. П-2025-04-266-СПОЗУ (Изм.1).pdf',
  '3. П-2025-04-266-АР Изм. 1.pdf',
  '3. Раздел АР от 12_02_2025.pdf',
  '4. П-2025-04-266-КР(27.04.26) (1).pdf',
  '4. П-2025-04-266-КР.Р.pdf',
  '4. Раздел 4 КР.pdf',
  '5.1.П-2025-04.266-ИОС1.2-ИТП.ЭОМ (1).pdf',
  '5.5. П-2025-04.266-ИОС5.5.2 (1) (2).pdf',
  '5.7. Раздел 5.7 ЖС-РЛ-270121-П-ИОС.ТХ.pdf',
  '6. Раздел 6 ЖС-РД_270121_П_ПОС.pdf',
  '9. П-2025-04.266-ПБ.pdf',
  '10.1. П-2025-04.266-ТБЭО.pdf',
];
const RD = [
  'П-2025-04-266-КЖ01 11.11.2025.pdf',
  'П-2025-04-266-КЖ1 28.11.2026.pdf',
  'П-2025-04-266-КМ 02.07.2026.pdf',
  'Р-2025-04-266 ВК1.2.pdf',
  'Р-2025-04.266-ВК2.pdf',
  'РД-2025-04-266-АР1.pdf',
  'РД-2025-04.266-ОВ (09.07.26).pdf',
];

describe('guessStage', () => {
  it.each(PD)('ПД: %s', (name) => expect(guessStage(name)).toBe('PD'));
  it.each(RD)('РД: %s', (name) => expect(guessStage(name)).toBe('RD'));
  it('ИД по ключевым словам', () => {
    expect(guessStage('АОСР №12 армирование.pdf')).toBe('ID');
    expect(guessStage('Общий журнал работ.pdf')).toBe('ID');
  });
  it('неизвестно → null', () => expect(guessStage('scan_0001.pdf')).toBeNull());
});

describe('guessDiscipline / guessRevision', () => {
  it('марки и разделы', () => {
    expect(guessDiscipline('П-2025-04-266-КЖ01 11.11.2025.pdf')).toBe('КЖ');
    expect(guessDiscipline('5.5. П-2025-04.266-ИОС5.5.2 (1) (2).pdf')).toBe('ИОС5');
    expect(guessDiscipline('2. П-2025-04-266-СПОЗУ (Изм.1).pdf')).toBe('ПЗУ');
    expect(guessDiscipline('4. П-2025-04-266-КР(27.04.26) (1).pdf')).toBe('КР');
  });
  it('шифр документа', () => {
    expect(guessDocumentCode('4. П-2025-04-266-КР(27.04.26) (1).pdf')).toBe('П-2025-04-266-КР');
    expect(guessDocumentCode('1. Раздел 1 ЖС-РД-270121-П-ОПЗ 2024.pdf')).toBe('ЖС-РД-270121-П-ОПЗ');
    expect(guessDocumentCode('П-2025-04-266-КЖ01 11.11.2025.pdf')).toBe('П-2025-04-266-КЖ01');
    expect(guessDocumentCode('5.5. П-2025-04.266-ИОС5.5.2 (1) (2).pdf')).toBe('П-2025-04.266-ИОС5.5.2');
    expect(guessDocumentCode('6. Раздел 6 ЖС-РД_270121_П_ПОС.pdf')).toBe('ЖС-РД-270121-П-ПОС');
  });
  it('номер изменения', () => {
    expect(guessRevision('3. П-2025-04-266-АР Изм. 1.pdf')).toBe('1');
    expect(guessRevision('П-2025-04-266-КЖ01.pdf')).toBeNull();
  });
});

describe('полнота комплекта и сценарий', () => {
  const ok = (stage: 'PD' | 'RD' | 'ID', name = `${stage}.pdf`, code?: string) => ({ stage, processing_status: 'PARSED', original_name: name, document_code: code ?? null });

  it('без манифеста комплект не объявляется полным', () => {
    const st = computeUploadStatus([ok('PD'), ok('RD')]);
    expect(st).toEqual(['PD_PARTIAL', 'RD_PARTIAL', 'ID_MISSING']);
    expect(computeScenario(st)).toBe('PD_RD_ONLY');
    expect(computeScenario(computeUploadStatus([ok('PD'), ok('RD'), ok('ID')]))).toBe('FULL');
    expect(computeScenario(computeUploadStatus([ok('RD')]))).toBe('SINGLE_ONLY');
    expect(computeScenario(computeUploadStatus([]))).toBeNull();
  });

  it('по манифесту: полный комплект → UPLOADED, пробел → PARTIAL и PARTIALLY_LOADED', () => {
    const expected = [
      { doc_stage: 'PD' as const, document_code: 'П-2025-04-266-КР' },
      { doc_stage: 'RD' as const, file_name: 'КЖ01.pdf' },
      { doc_stage: 'ID' as const, discipline: 'КЖ' },
    ];
    const files = [ok('PD', 'КР.pdf', 'П-2025-04-266-КР'), ok('RD', 'КЖ01.pdf')];
    const c = computeCompleteness(files, expected);
    expect(c.upload_status).toEqual(['PD_UPLOADED', 'RD_UPLOADED', 'ID_MISSING']);
    expect(c.missing).toHaveLength(1);
    expect(c.known_gap).toBe(true);
    expect(computeScenario(c.upload_status, c.known_gap)).toBe('PARTIALLY_LOADED');
    const failed = computeCompleteness([ok('PD', 'КР.pdf', 'П-2025-04-266-КР'), { ...ok('RD', 'КЖ01.pdf'), processing_status: 'FAILED' }], expected.slice(0, 2));
    expect(failed.upload_status).toEqual(['PD_UPLOADED', 'RD_PARTIAL', 'ID_MISSING']);
  });

  it('итоговый статус — худший из оценки api и движка', () => {
    expect(mergeUploadStatus(['PD_UPLOADED', 'RD_UPLOADED', 'ID_MISSING'], ['PD_UPLOADED', 'RD_PARTIAL', 'ID_MISSING'])).toEqual(['PD_UPLOADED', 'RD_PARTIAL', 'ID_MISSING']);
    expect(mergeUploadStatus(['PD_PARTIAL', 'RD_UPLOADED', 'ID_MISSING'], ['PD_UPLOADED', 'RD_UPLOADED', 'ID_MISSING'])).toEqual(['PD_PARTIAL', 'RD_UPLOADED', 'ID_MISSING']);
  });
});
