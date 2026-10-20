import { describe, expect, it } from 'vitest';
import { collectPages, isModelClarification, isVerifiable, toDecisionHistory, toEvidenceEditBody, toEvidenceVersions, toFinding, toFragments } from './findings';
import type { ApiFinding } from './findings';

const fragment = (over: Record<string, unknown>) => ({
  role: 'EXPECTED',
  file_id: 'file-pd',
  sha256: 'aa',
  stage: 'PD',
  page: 1,
  bbox: [0.1, 0.2, 0.3, 0.4],
  extracted_value: 'B30',
  ...over,
});

const finding = (fragments: unknown[], over: Record<string, unknown> = {}) =>
  ({
    id: 'f1',
    param_code: 'M-055',
    param_name: 'Класс бетона',
    finding_status: 'CANDIDATE',
    inspector_status: 'PENDING',
    review_priority: 'HIGH',
    is_split: false,
    evidence_group: { id: 'g', fragments },
    ...over,
  }) as unknown as ApiFinding;

describe('toFinding', () => {
  it('по стадиям: роль, лист и рамки основного файла; рамки другого файла не смешиваются', () => {
    const result = toFinding(
      finding([
        fragment({ sheet: '7' }),
        fragment({ page: 4, extracted_value: 'B35', bbox: [0.5, 0.5, 0.6, 0.6] }),
        fragment({ file_id: 'file-other', page: 2 }),
        fragment({ role: 'ACTUAL', file_id: 'file-rd', stage: 'RD', extracted_value: 'B25' }),
      ]),
      []
    );
    expect(result.sources.pd).toMatchObject({ role: 'EXPECTED', sheet: '7', page: 1, fileId: 'file-pd' });
    expect(result.sources.pd?.marks?.map((m) => m.page)).toEqual([1, 4]);
    expect(result.sources.rd?.role).toBe('ACTUAL');
    expect(result.sources.id_).toBeUndefined();
  });
});

describe('«требуется уточнение» от модели', () => {
  const clar = (over: Record<string, unknown> = {}) => finding([fragment({})], { finding_status: 'CLARIFICATION_REQUIRED', ...over });

  it('попадает в список верификации и открывается как «Уточнено» без решения инспектора', () => {
    const f = clar();
    expect(isModelClarification(f)).toBe(true);
    expect(isVerifiable(f)).toBe(true);
    expect(toFinding(f, [])).toMatchObject({ status: 'clarification', modelClarification: true });
  });

  it('после решения инспектора признак модели снимается, статус по решению', () => {
    const f = clar({ inspector_status: 'NEGATIVE_VERIFIED' });
    expect(isModelClarification(f)).toBe(false);
    expect(isVerifiable(f)).toBe(true);
    expect(toFinding(f, [])).toMatchObject({ status: 'rejected' });
    expect(toFinding(f, []).modelClarification).toBeUndefined();
  });

  it('несопоставимые и без доказательств в список не идут', () => {
    expect(isVerifiable(finding([], { finding_status: 'NOT_COMPARABLE' }))).toBe(false);
    expect(isVerifiable(finding([], { finding_status: 'MISSING_EVIDENCE' }))).toBe(false);
  });
});

describe('метка «найдено по смыслу»', () => {
  it('extraction_method = SBERT помечает источник и рамку; RULES и null — нет', () => {
    const result = toFinding(
      finding([
        fragment({ extraction_method: 'RULES' }),
        fragment({ role: 'ACTUAL', file_id: 'file-rd', stage: 'RD', extracted_value: '3 793,1', extraction_method: 'SBERT' }),
        fragment({ file_id: 'file-id', stage: 'ID', role: 'ACTUAL', extraction_method: null }),
      ]),
      []
    );
    expect(result.sources.pd?.bySense).toBeUndefined();
    expect(result.sources.rd?.bySense).toBe(true);
    expect(result.sources.rd?.marks?.[0].bySense).toBe(true);
    expect(result.sources.id_?.bySense).toBeUndefined();
  });
});

describe('collectPages', () => {
  const pages = (all: number[], size: number) => async (page: number) => ({ items: all.slice((page - 1) * size, page * size), total: all.length });

  it('читает все страницы: протокол из 371 проверки — две страницы по 200, решённые в конце не теряются', async () => {
    const all = Array.from({ length: 371 }, (_, i) => i);
    const asked: number[] = [];
    const fetchPage = pages(all, 200);
    const result = await collectPages(async (page) => {
      asked.push(page);
      return fetchPage(page);
    });
    expect(result).toEqual(all);
    expect(asked).toEqual([1, 2]);
  });

  it('одна страница, если всё поместилось; пустой протокол — один запрос', async () => {
    expect(await collectPages(pages([1, 2, 3], 200))).toEqual([1, 2, 3]);
    expect(await collectPages(pages([], 200))).toEqual([]);
  });

  it('останавливается на пустой странице, даже если total больше (список сократился между запросами)', async () => {
    expect(await collectPages(async (page) => ({ items: page === 1 ? [1, 2] : [], total: 5 }))).toEqual([1, 2]);
  });
});

describe('isVerifiable', () => {
  it('кандидаты и уже решённые остаются, расщеплённые составные — нет', () => {
    expect(isVerifiable(finding([]))).toBe(true);
    expect(isVerifiable(finding([], { finding_status: 'CLARIFICATION_REQUIRED', inspector_status: 'CLARIFICATION_REQUIRED' }))).toBe(true);
    expect(isVerifiable(finding([], { finding_status: 'MISSING_EVIDENCE' }))).toBe(false);
    expect(isVerifiable(finding([], { is_split: true }))).toBe(false);
  });
});

describe('карточка доказательства', () => {
  it('переносит правило, отклонение, источник обоснования и флаг «доказательства изменились»', () => {
    const result = toFinding(
      finding([], { rule_key: 'Плита Пм-1', delta: '−1 класс', rationale: 'B30 → B25', rationale_source: 'LLM', evidence_changed: true }),
      []
    );
    expect(result).toMatchObject({ ruleKey: 'Плита Пм-1', delta: '−1 класс', rationaleSource: 'AI', evidenceChanged: true });
  });

  it('правило срабатывания и обоснование отдельными полями, чтобы карточка со сравнением по стадиям не повторяла числа', () => {
    const rows = [
      { stage: 'RD', value: '1', triggered: false },
      { stage: 'ID', value: '2', triggered: true },
    ];
    const result = toFinding(
      finding([], { expected_value: 'B25', actual_value: 'B22.5', rationale: 'ПД: B25; ИД: B22,5', trigger_logic: 'Понижение класса бетона', stage_comparisons: rows }),
      []
    );
    expect(result.triggerLogic).toBe('Понижение класса бетона');
    expect(result.rationale).toBe('ПД: B25; ИД: B22,5');
    expect(result.stageComparisons).toHaveLength(2);
    // без trigger_logic (старый api) полей нет, карточка остаётся прежней
    expect(toFinding(finding([], { rationale: 'x' }), []).triggerLogic).toBeUndefined();
  });

  it('история решений: новые сверху, текущее решение не дублируется', () => {
    const old = { action: 'CLARIFY', decided_at: '2026-09-19T10:00:00Z', user_name: 'Иванов', comment: 'нужна выписка' };
    const current = { action: 'REJECT', reason_code: 'NO_DISCREPANCY', decided_at: '2026-09-19T12:00:00Z', user_name: 'Иванов' };
    const history = toDecisionHistory(finding([], { decision: current, decision_history: [old, current] }));
    expect(history.map((d) => d.action)).toEqual(['REJECT', 'CLARIFY']);
    expect(history[0].reasonCode).toBe('NO_DISCREPANCY');
  });

  it('версии доказательств идут в порядке api, правка инспектора сохраняет основание', () => {
    const versions = toEvidenceVersions(
      finding([], {
        evidence_history: [
          { group_id: 'g', version: 1, source: 'MODEL', created_at: '2026-09-19T10:00:00Z', fragments_count: 2 },
          { group_id: 'g', version: 2, source: 'INSPECTOR', created_by_name: 'Иванов', reason: 'нашёл верное значение', reference: 'лист 5', created_at: '2026-09-19T11:00:00Z', fragments_count: 3 },
        ],
      })
    );
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[1]).toMatchObject({ source: 'INSPECTOR', by: 'Иванов', reason: 'нашёл верное значение', reference: 'лист 5', fragments: 3 });
  });
});

describe('разделение несоответствия', () => {
  it('фрагменты для разделения: только с id, с подписью стадии и значением', () => {
    const fragments = toFragments(
      finding([
        fragment({ id: 'frag-1', page: 3 }),
        fragment({ id: 'frag-2', stage: 'RD', role: 'ACTUAL', extracted_value: 'B25', page: 5 }),
        fragment({ id: undefined }),
      ])
    );
    expect(fragments).toEqual([
      { id: 'frag-1', stage: 'ПД', page: 3, value: 'B30', role: 'EXPECTED', manual: false },
      { id: 'frag-2', stage: 'РД', page: 5, value: 'B25', role: 'ACTUAL', manual: false },
    ]);
  });

  it('toFinding отдаёт фрагменты для окна разделения', () => {
    expect(toFinding(finding([fragment({ id: 'frag-1' })]), []).fragments).toHaveLength(1);
  });
});

describe('правка доказательств', () => {
  it('рамка, нарисованная инспектором (source = MANUAL), помечается в фрагментах и рамках', () => {
    const f = finding([fragment({ id: 'a' }), fragment({ id: 'b', source: 'MANUAL', role: 'ACTUAL', extracted_value: 'B25' })]);
    expect(toFragments(f).map((x) => [x.id, x.role, x.manual])).toEqual([
      ['a', 'EXPECTED', false],
      ['b', 'ACTUAL', true],
    ]);
    const marks = toFinding(f, []).sources.pd?.marks ?? [];
    expect(marks.map((m) => [m.fragmentId, m.manual])).toEqual([
      ['a', undefined],
      ['b', true],
    ]);
  });

  it('тело запроса: рамка в долях страницы [x0, y0, x1, y1], значение и ссылка только если заданы', () => {
    const body = toEvidenceEditBody({
      added: [{ key: 'k', stage: 'РД', fileId: 'file-rd', page: 3, bbox: { x: 10, y: 20, w: 30, h: 5 }, role: 'ACTUAL', value: ' B25 ' }],
      removedIds: ['old'],
      reason: ' Взято из другой таблицы ',
      reference: '  ',
    });
    expect(body.add[0].bbox[0]).toBeCloseTo(0.1);
    expect(body.add[0].bbox[1]).toBeCloseTo(0.2);
    expect(body.add[0].bbox[2]).toBeCloseTo(0.4);
    expect(body.add[0].bbox[3]).toBeCloseTo(0.25);
    expect(body).toMatchObject({ add: [{ role: 'ACTUAL', file_id: 'file-rd', page: 3, extracted_value: 'B25' }], remove_fragment_ids: ['old'], reason: 'Взято из другой таблицы' });
    expect(body).not.toHaveProperty('reference');
  });
});
