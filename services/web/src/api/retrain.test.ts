import { describe, expect, it } from 'vitest';
import { RETRAIN_STATUS_OF, toRetrainItem } from './retrain';
import type { DatasetItem } from './retrain';

const item = (patch: Partial<DatasetItem>): DatasetItem => ({
  id: 'i1',
  evidence_group_id: 'g1',
  finding_id: 'f1',
  param_code: 'M-055',
  gold_label: 'NEGATIVE',
  reason_code: 'EXTRACTION_ERROR',
  curation_status: 'DRAFT',
  object_group_id: 'o1',
  created_at: '2026-09-20T09:18:00Z',
  ...patch,
});

describe('RETRAIN_STATUS_OF', () => {
  it('черновик ждёт решения, одобренная запись уходит на дообучение, исключённая нет', () => {
    expect(RETRAIN_STATUS_OF).toEqual({ DRAFT: 'pending', APPROVED: 'sent', EXCLUDED: 'skipped' });
  });
});

describe('toRetrainItem', () => {
  it('отклонённое инспектором: причина, проект и параметр с названием', () => {
    expect(toRetrainItem(item({}), 'Поворот 90', 'Класс бетона')).toMatchObject({
      id: 'i1',
      findingId: 'f1',
      projectId: 'o1',
      projectName: 'Поворот 90',
      parameter: 'M-055, Класс бетона',
      verdict: 'rejected',
      reasonCode: 'EXTRACTION_ERROR',
      status: 'pending',
    });
  });

  it('версия набора у записи: пока её нет, решение можно менять', () => {
    expect(toRetrainItem(item({ curation_status: 'APPROVED' }), undefined, undefined).datasetVersion).toBeUndefined();
    expect(toRetrainItem(item({ curation_status: 'APPROVED', dataset_version: 'ds-2026.09.1' }), undefined, undefined).datasetVersion).toBe('ds-2026.09.1');
  });

  it('подтверждённое нарушение: решение «подтверждено», причины нет', () => {
    const result = toRetrainItem(item({ gold_label: 'POSITIVE', reason_code: null, curation_status: 'APPROVED' }), undefined, undefined);
    expect(result.verdict).toBe('confirmed');
    expect(result.reasonCode).toBeUndefined();
    expect(result.status).toBe('sent');
    expect(result.projectName).toBe('Проект');
    expect(result.parameter).toBe('M-055');
  });
});
