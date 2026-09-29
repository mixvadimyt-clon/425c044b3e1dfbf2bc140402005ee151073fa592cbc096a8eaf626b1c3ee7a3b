import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../../db/sqlite.js';
import { nowIso } from '../../db/sqlite.js';
import type { DocStage, E, Envelope } from '../../types.js';
import { computeScenario, computeUploadStatus } from '../stages.js';
import type { MlTransport } from './types.js';

/**
 * ML-заглушка внутри api (ML_TRANSPORT=stub).
 * Нужна, чтобы фронтенд и сквозной сценарий работали до готовности services/ml.
 * Результаты правдоподобны, детерминированы и явно помечены «ML-заглушка».
 */
const STUB_NOTE = ' (демо-данные ML-заглушки)';
const STUB_VERSION = 'stub-0.1';

export const findingKey = (objectId: string, paramCode: string, ruleKey: string | null) =>
  createHash('sha1').update(`${objectId}|${paramCode}|${ruleKey ?? ''}`).digest('hex');

export const manifestHash = (sha256s: string[]) =>
  createHash('sha256').update([...sha256s].sort().join('\n')).digest('hex');

type CompareFile = E['CompareFile'];
type Fragment = E['CheckResult']['fragments'][number];

export class StubTransport implements MlTransport {
  readonly kind = 'stub';
  private timers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly db: Db,
    private readonly deliver: (env: Envelope) => Promise<void>,
    private readonly delayMs: number,
  ) {}

  async send(env: Envelope): Promise<void> {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      const result = this.handle(env);
      this.deliver(result).catch((err) => console.error('[ml-stub] ошибка доставки результата', err));
    }, this.delayMs);
    this.timers.add(timer);
  }

  async close(): Promise<void> {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
  }

  private handle(env: Envelope): Envelope {
    const base = {
      message_id: randomUUID(),
      schema_version: env.schema_version,
      correlation_id: env.correlation_id,
      attempt: env.attempt ?? 1,
      created_at: nowIso(),
    };
    if (env.type === 'ml.parse.request') {
      return { ...base, type: 'ml.parse.result', payload: this.parse(env.payload as E['ParseRequest']) };
    }
    return { ...base, type: 'ml.compare.result', payload: buildStubCompare(env.payload as E['CompareRequest']) };
  }

  private parse(req: E['ParseRequest']): E['ParseResult'] {
    const f = this.db.get<Record<string, string | number | null>>('SELECT * FROM files WHERE id = ?', req.file.file_id);
    const pages = Number(f?.pages_count ?? 1) || 1;
    const stage = ((f?.stage_hint ?? f?.doc_stage) as DocStage | null) ?? null;
    return {
      process_id: req.process_id,
      file_id: req.file.file_id,
      sha256: req.file.sha256,
      status: 'OK',
      error: null,
      parser_version: STUB_VERSION,
      parsed_ref: { bucket: 'local', key: `parsed/${req.file.sha256}/${STUB_VERSION}.json` },
      metadata: {
        doc_stage: stage,
        doc_kind: stage === 'RD' ? 'Основной комплект рабочих чертежей' : stage === 'PD' ? 'Раздел проектной документации' : null,
        discipline: (f?.discipline as string) ?? null,
        document_code: (f?.document_code as string) ?? null,
        revision: (f?.revision as string) ?? '0',
        // заглушка не читает штампы: «В производство работ» условно только у РД
        approval_status: stage === 'RD' ? 'FOR_CONSTRUCTION' : 'UNKNOWN',
        approval_date: null,
        sheets: Array.from({ length: Math.min(pages, 500) }, (_, i) => ({ page: i + 1, sheet: String(i + 1), sheet_title: null })),
        stamps: { in_production: stage === 'RD' ? true : null, as_built: null },
        field_confidence: { doc_stage: 0.6, document_code: 0.5 },
        // сведения о файле (0.6.0): заглушка не читает PDF — только то, что знает наверняка
        project_code: null,
        language: 'ru',
        scan_share: 0,
        file_size: Number(f?.size_bytes ?? 0) || null,
        pdf_version: null,
        pdf_producer: null,
        pdf_creator: null,
        encrypted: false,
        developer_org: null, // 0.7.0: организацию по штампу заглушка не ищет
      },
      quality: { pages_total: pages, pages_text_layer: pages, pages_ocr: 0, low_quality_pages: [], abstain_pages: [], ocr_mean_confidence: null },
      from_cache: false,
      duration_ms: 10,
    };
  }
}

function stageOf(f: CompareFile): DocStage | null {
  return (f.metadata.doc_stage as DocStage | null) ?? null;
}

function pick(files: CompareFile[], stage: DocStage, disciplines: string[]): CompareFile | undefined {
  const ofStage = files.filter((f) => stageOf(f) === stage);
  return ofStage.find((f) => disciplines.includes(f.metadata.discipline ?? '')) ?? ofStage[0];
}

function fragment(
  f: CompareFile,
  role: Fragment['role'],
  page: number,
  bbox: number[],
  value: string,
  snippet: string,
  method: Fragment['extraction_method'] = 'RULES',
): Fragment {
  return {
    role,
    file_id: f.file_id,
    sha256: f.sha256,
    stage: stageOf(f) ?? 'PD',
    document_code: f.metadata.document_code ?? null,
    revision: f.metadata.revision ?? null,
    approval_status: f.metadata.approval_status ?? 'UNKNOWN',
    page,
    sheet: String(page),
    bbox,
    polygon: null,
    extracted_value: value,
    normalized_value: value,
    text_snippet: snippet,
    source: 'TEXT_LAYER',
    extraction_method: method,
    quality: 'OK',
    confidence: 0.9,
  };
}

export function buildStubCompare(req: E['CompareRequest']): E['CompareResult'] {
  // заменённые и исключённые редакции в эталонное сравнение не берём
  const excluded = new Set((req.excluded_files ?? []).map((x) => x.file_id));
  const files = req.files.filter((f) => !excluded.has(f.file_id));
  const uploadStatus = computeUploadStatus(files.map((f) => ({ stage: stageOf(f), processing_status: 'PARSED' })));
  const checks: E['CheckResult'][] = [];
  const pd = pick(files, 'PD', ['КР', 'ПЗ']);
  const rd = pick(files, 'RD', ['КЖ', 'АР']);

  for (const p of req.matrix.params) {
    if (!p.is_active) continue;
    const base = {
      param_code: p.code,
      review_priority: p.review_priority,
      risk_level: p.review_priority,
      unit: p.unit ?? null,
      normative_reference: p.sp_reference ?? p.gost_reference ?? null,
      rationale_source: 'RULES' as const,
    };
    if (p.code === 'M-055') {
      const pdKr = pick(files, 'PD', ['КР']);
      const rdKj = pick(files, 'RD', ['КЖ']);
      const ruleKey = 'Фундаментная плита Пм-1';
      if (!pdKr || !rdKj) {
        checks.push({
          ...base,
          finding_key: findingKey(req.object_id, p.code, null),
          rule_key: null,
          finding_status: 'MISSING_EVIDENCE',
          completeness_status: 'MISSING_EVIDENCE',
          stages_compared: [],
          missing_sources: [!pdKr ? `ПД: ${p.source_pd}` : '', !rdKj ? `РД: ${p.source_rd}` : ''].filter(Boolean),
          rationale: 'Нет пары документов ПД (КР) и РД (КЖ) для сравнения класса бетона' + STUB_NOTE,
          fragments: [],
        });
        continue;
      }
      checks.push({
        ...base,
        finding_key: findingKey(req.object_id, p.code, ruleKey),
        rule_key: ruleKey,
        finding_status: 'CANDIDATE',
        completeness_status: 'COMPLETE',
        stages_compared: ['PD', 'RD'],
        missing_sources: [],
        expected_value: 'B30',
        actual_value: 'B25',
        delta: '−1 класс',
        stage_comparisons: [{ stage: 'RD', value: 'B25', raw_value: 'B25', delta: '−1 класс', triggered: true, verdict: 'Понижение: B30 → B25' }],
        rationale: 'Понижение класса бетона: в ПД (КР) указан B30, в РД (КЖ) — B25' + STUB_NOTE,
        confidence: 0.87,
        page_pair_key: 'pp-1',
        fragments: [
          fragment(pdKr, 'EXPECTED', 1, [0.58, 0.62, 0.78, 0.66], 'B30', 'Бетон тяжёлый класса B30 W8 F150'),
          fragment(rdKj, 'ACTUAL', 1, [0.57, 0.6, 0.77, 0.64], 'B25', 'Бетон кл. B25 W6 F100'),
        ],
      });
      continue;
    }
    if (p.code === 'M-002') {
      const pdArea = files.find((f) => stageOf(f) === 'PD' && f.metadata.discipline === 'ПЗ') ?? files.find((f) => stageOf(f) === 'PD' && f.metadata.discipline === 'АР');
      const rdAr = files.find((f) => stageOf(f) === 'RD' && f.metadata.discipline === 'АР');
      if (!pdArea || !rdAr) {
        checks.push({
          ...base,
          finding_key: findingKey(req.object_id, p.code, null),
          rule_key: null,
          finding_status: 'MISSING_EVIDENCE',
          completeness_status: 'MISSING_EVIDENCE',
          stages_compared: [],
          missing_sources: [!pdArea ? `ПД: ${p.source_pd}` : '', !rdAr ? `РД: ${p.source_rd}` : ''].filter(Boolean),
          rationale: 'Нет пары ПД (ПЗ/АР) и РД (АР) для сравнения общей площади' + STUB_NOTE,
          fragments: [],
        });
        continue;
      }
      const total = 'Общая площадь здания';
      checks.push({
        ...base,
        finding_key: findingKey(req.object_id, p.code, total),
        rule_key: total,
        finding_status: 'NEGATIVE_VERIFIED',
        completeness_status: 'COMPLETE',
        stages_compared: ['PD', 'RD'],
        missing_sources: [],
        expected_value: '4215.3',
        actual_value: '4215.3',
        delta: '0 %',
        rationale: 'Общая площадь здания в ПД и сводной экспликации РД совпадает: 4 215,3 м²' + STUB_NOTE,
        confidence: 0.91,
        fragments: [
          fragment(pdArea, 'EXPECTED', 1, [0.1, 0.42, 0.55, 0.45], '4215.3', 'Общая площадь здания — 4 215,3 м²'),
          // подпись в РД не совпадает с названием параметра — такое находит запасной путь Sentence-BERT
          fragment(rdAr, 'ACTUAL', 1, [0.62, 0.8, 0.94, 0.83], '4215.3', 'Итого общая площадь 4215,3', 'SBERT'),
        ],
      });
      const floor = 'Экспликация помещений 1-го этажа';
      checks.push({
        ...base,
        finding_key: findingKey(req.object_id, p.code, floor),
        rule_key: floor,
        finding_status: 'CANDIDATE',
        completeness_status: 'COMPLETE',
        stages_compared: ['PD', 'RD'],
        missing_sources: [],
        expected_value: '1250.4',
        actual_value: '1268.9',
        delta: '+18,5 м² (+1,5 %)',
        rationale: 'Итог экспликации 1-го этажа в РД больше, чем в ПД, на 1,5 % (порог 1 %): изменены назначение и площади помещений' + STUB_NOTE,
        confidence: 0.78,
        fragments: [
          fragment(pdArea, 'EXPECTED', 1, [0.78, 0.1, 0.91, 0.35], '1250.4', 'Итого по 1-му этажу: 1 250,4 м²'),
          fragment(rdAr, 'ACTUAL', 1, [0.8, 0.03, 0.93, 0.27], '1268.9', 'Итого по 1-му этажу: 1 268,9 м²'),
        ],
      });
      continue;
    }
    if (p.code === 'M-001') {
      const pdPz = files.find((f) => stageOf(f) === 'PD' && f.metadata.discipline === 'ПЗ') ?? pd;
      const other =
        files.find((f) => f !== pdPz && ['ПЗУ', 'АР'].includes(f.metadata.discipline ?? '')) ??
        files.find((f) => f !== pdPz && stageOf(f) !== null);
      if (!pdPz || !other) {
        checks.push({
          ...base,
          finding_key: findingKey(req.object_id, p.code, null),
          rule_key: null,
          finding_status: 'MISSING_EVIDENCE',
          completeness_status: 'MISSING_EVIDENCE',
          stages_compared: [],
          missing_sources: [`ПД: ${p.source_pd}`, `РД: ${p.source_rd}`],
          rationale: 'Площадь застройки найдена менее чем в двух документах' + STUB_NOTE,
          fragments: [],
        });
        continue;
      }
      checks.push({
        ...base,
        finding_key: findingKey(req.object_id, p.code, null),
        rule_key: null,
        finding_status: 'NEGATIVE_VERIFIED',
        completeness_status: 'COMPLETE',
        stages_compared: [...new Set([stageOf(pdPz) ?? 'PD', stageOf(other) ?? 'PD'])],
        missing_sources: [],
        expected_value: '3009.4',
        actual_value: '3009.4',
        delta: '0',
        rationale: 'Значения площади застройки совпадают: 3009,4 м²' + STUB_NOTE,
        confidence: 0.93,
        fragments: [
          fragment(pdPz, 'EXPECTED', 1, [0.12, 0.3, 0.52, 0.33], '3009.4', 'Площадь застройки — 3009,4 м²'),
          fragment(other, 'ACTUAL', 1, [0.14, 0.41, 0.5, 0.44], '3009.4', 'Площадь застройки 3009,40 м²'),
        ],
      });
      continue;
    }
    // Остальные параметры заглушка не умеет — честно помечаем как несопоставимые / без доказательств
    const bothStages = Boolean(pd && rd);
    checks.push({
      ...base,
      finding_key: findingKey(req.object_id, p.code, null),
      rule_key: null,
      finding_status: bothStages ? 'NOT_COMPARABLE' : 'MISSING_EVIDENCE',
      completeness_status: bothStages ? 'NOT_COMPARABLE' : 'MISSING_EVIDENCE',
      stages_compared: [],
      missing_sources: bothStages ? [] : [`ПД: ${p.source_pd ?? '—'}`, `РД: ${p.source_rd ?? '—'}`],
      rationale: 'Извлечение для параметра ещё не реализовано' + STUB_NOTE,
      fragments: [],
    });
  }

  const pagePairs: E['PagePairResult'][] = [];
  const suspicions: E['SuspicionResult'][] = [];
  if (pd && rd) {
    pagePairs.push({
      pair_key: 'pp-1',
      left: { file_id: pd.file_id, page: 1 },
      right: { file_id: rd.file_id, page: 1 },
      match_score: 0.91,
      homography: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      compliance_percent: 84,
      diff_regions: [
        {
          left_bbox: [0.58, 0.62, 0.78, 0.66],
          right_bbox: [0.57, 0.6, 0.77, 0.64],
          score: 0.9,
          label: 'Класс бетона: B30 → B25',
          finding_key: checks.find((c) => c.param_code === 'M-055' && c.finding_status === 'CANDIDATE')?.finding_key ?? null,
          suspicion_key: null,
        },
        {
          left_bbox: [0.3, 0.2, 0.45, 0.32],
          right_bbox: [0.31, 0.21, 0.46, 0.33],
          score: 0.62,
          label: 'Изменение геометрии на листе',
          finding_key: null,
          suspicion_key: 'visual-pp-1',
        },
      ],
    });
    suspicions.push({
      suspicion_key: 'visual-pp-1',
      discovery_method: 'VISUAL_DIFF',
      confidence: 0.62,
      description: 'Визуальное различие на совмещённых листах ПД и РД: изменена геометрия элемента' + STUB_NOTE,
      pd_reference: `${pd.metadata.document_code ?? pd.original_name}, стр. 1`,
      rd_reference: `${rd.metadata.document_code ?? rd.original_name}, стр. 1`,
      id_reference: null,
      review_priority: 'MEDIUM',
      normative_base: null,
      page_pair_key: 'pp-1',
      evidence: [
        fragment(pd, 'CONTEXT', 1, [0.3, 0.2, 0.45, 0.32], '', 'Область на листе ПД'),
        fragment(rd, 'CONTEXT', 1, [0.31, 0.21, 0.46, 0.33], '', 'Область на листе РД'),
      ],
    });
  }

  return {
    process_id: req.process_id,
    protocol_version: req.protocol_version,
    status: 'OK',
    error: null,
    mode: req.mode,
    scenario: computeScenario(uploadStatus) ?? 'SINGLE_ONLY',
    upload_status: uploadStatus,
    affected_param_codes: req.matrix.params.map((p) => p.code),
    checks,
    suspicions,
    page_pairs: pagePairs,
    file_resolution: files.map((f) => ({ file_id: f.file_id, role: 'ACTUAL' as const, reason: 'ML-заглушка: все файлы считаются актуальными' })),
    versions: {
      matrix_version: req.matrix.version,
      model_version: STUB_VERSION,
      dataset_version: req.versions.dataset_version,
      parser_version: STUB_VERSION,
      input_manifest_hash: manifestHash(files.map((f) => f.sha256)),
    },
    stats: { duration_ms: 5, params_evaluated: req.matrix.params.length },
  };
}
