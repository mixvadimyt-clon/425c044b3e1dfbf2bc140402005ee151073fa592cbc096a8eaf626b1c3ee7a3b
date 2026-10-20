import { describe, expect, it } from 'vitest';
import { fileNameFromDisposition, formatDateTime, pagesRead, toProtocolFinding, uploadedLine } from './protocols';
import type { ApiFinding } from './findings';

describe('fileNameFromDisposition', () => {
  it('читает имя из filename*=UTF-8', () => {
    expect(fileNameFromDisposition("attachment; filename*=UTF-8''protocol-480a2887-v5.pdf")).toBe('protocol-480a2887-v5.pdf');
    expect(fileNameFromDisposition("attachment; filename*=UTF-8''%D0%BF%D1%80%D0%BE%D1%82%D0%BE%D0%BA%D0%BE%D0%BB.pdf")).toBe('протокол.pdf');
  });

  it('читает обычное имя и возвращает null без заголовка', () => {
    expect(fileNameFromDisposition('attachment; filename="report.docx"')).toBe('report.docx');
    expect(fileNameFromDisposition(null)).toBeNull();
  });
});

describe('formatDateTime', () => {
  it('пустая или неверная дата — пустая строка', () => {
    expect(formatDateTime(null)).toBe('');
    expect(formatDateTime('не дата')).toBe('');
  });
});

describe('uploadedLine', () => {
  it('имя и дата', () => {
    expect(uploadedLine('Иванов Иван', '2026-09-24T08:45:00Z')).toMatch(/^Загрузил Иванов Иван, 24\.09\.2026 \d{2}:\d{2}$/);
  });

  it('только имя или только дата', () => {
    expect(uploadedLine('Иванов Иван', null)).toBe('Загрузил Иванов Иван');
    expect(uploadedLine(null, '2026-09-24T08:45:00Z')).toMatch(/^Загружен 24\.09\.2026/);
  });

  it('без имени и даты пусто', () => {
    expect(uploadedLine(null, undefined)).toBe('');
  });
});

describe('toProtocolFinding', () => {
  const finding = {
    id: 'f1',
    finding_key: 'k',
    protocol_id: 'p1',
    param_code: 'M-055',
    param_name: 'Класс бетона',
    finding_status: 'CANDIDATE',
    completeness_status: 'COMPLETE',
    inspector_status: 'PENDING',
    review_priority: 'HIGH',
    rationale_source: 'LLM',
    expected_value: 'B30',
    actual_value: 'B25',
    evidence_group: {
      id: 'g',
      fragments: [
        { role: 'EXPECTED', file_id: 'file-1', sha256: 'aa', stage: 'PD', page: 3, bbox: [0.1, 0.2, 0.4, 0.3], extracted_value: 'B30', document_code: 'KR', approval_status: 'APPROVED' },
      ],
    },
    evidence_history: [{ group_id: 'g', version: 2, source: 'INSPECTOR', created_at: '2026-09-19T10:00:00Z', fragments_count: 1 }],
  } as unknown as ApiFinding;

  it('переводит рамку в [x, y, w, h], стадию в подпись и источник обоснования', () => {
    const result = toProtocolFinding(finding, [{ id: 'file-1', original_name: 'КР.pdf' } as never], []);
    expect(result.sources[0]).toMatchObject({ stage: 'ПД', page: 3, fileName: 'КР.pdf', role: 'EXPECTED' });
    expect(result.sources[0].bbox?.map((n) => Number(n.toFixed(2)))).toEqual([0.1, 0.2, 0.3, 0.1]);
    expect(result.rationaleSource).toBe('AI');
    expect(result.evidenceVersion).toBe('v2 (инспектора)');
    expect(result.status).toBe('CANDIDATE');
  });
});

describe('pagesRead', () => {
  it('прочитанные страницы (текстовый слой и распознавание) из всех', () => {
    expect(pagesRead({ pages_total: 20, pages_text_layer: 15, pages_ocr: 5 })).toBe('20 / 20');
    expect(pagesRead({ pages_total: 10, pages_text_layer: 4 })).toBe('4 / 10');
  });

  it('без сведений о разборе «нет»', () => {
    expect(pagesRead(undefined)).toBe('нет');
    expect(pagesRead({})).toBe('нет');
  });
});
