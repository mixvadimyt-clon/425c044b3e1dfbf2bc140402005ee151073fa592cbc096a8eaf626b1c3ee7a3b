import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Db, Row } from '../db/sqlite.js';
import { nowIso, parseJson, toJson } from '../db/sqlite.js';
import { conflict } from '../errors.js';
import type { DocStage, E, Envelope, ProcessStatus, S } from '../types.js';
import { currentMatrixVersion, listParams } from './matrix.js';
import { currentModel } from './mlops/models.js';
import { audit, notify } from './notify.js';
import { activeRegistry, completenessOf, completenessSummary, countsForProtocol, getProcessRow, listFiles, modelGroupOf, stageOfFile } from './repo.js';
import { computeScenario, mergeUploadStatus } from './stages.js';
import type { LocalStorage } from './storage.js';
import { manifestHash } from './transport/stub.js';
import type { JobProbe, MlTransport } from './transport/types.js';

export const SCHEMA_VERSION = '0.4.0';
type Trigger = S['ProtocolVersionInfo']['trigger'];
type JobError = { code: string; message: string; retryable: boolean };

/**
 * Оркестрация проверки: парсинг файлов → сравнение → версия протокола.
 * Состояние хранится в БД (processes, files, ml_jobs), поэтому переживает перезапуск api.
 */
export class Orchestrator {
  transport!: MlTransport;
  private sweeping = false;

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly storage: LocalStorage,
    private readonly log: FastifyBaseLogger,
  ) {}

  // ------------------------------------------------------------------ запуск

  /** Запуск анализа: парсинг новых/упавших файлов, затем сравнение (FULL или INCREMENTAL). */
  async startAnalysis(processId: string, opts: { trigger: Trigger; changedFileIds?: string[] }): Promise<void> {
    const proc = getProcessRow(this.db, processId);
    const status = proc.status as ProcessStatus;
    if (status === 'PARSING') throw conflict('Проверка уже выполняется', 'PROCESS_LOCKED');
    if (status === 'FINALIZED') throw conflict('Протокол финализирован, запуск анализа невозможен', 'PROCESS_FINALIZED');
    const files = this.db.all<Row>("SELECT * FROM files WHERE process_id = ? AND processing_status IN ('UPLOADED','FAILED')", processId);
    const all = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM files WHERE process_id = ?', processId)!.n;
    if (all === 0) throw conflict('В проверке нет файлов, сначала загрузите документы', 'NO_FILES');

    const hasProtocol = Boolean(proc.current_protocol_id);
    const changed = [...new Set([...(opts.changedFileIds ?? []), ...files.map((f) => f.id as string)])];
    this.db.tx(() => {
      this.db.update(
        'processes',
        {
          status: 'PARSING',
          compare_mode: hasProtocol && opts.trigger !== 'MANUAL_RERUN' ? 'INCREMENTAL' : 'FULL',
          changed_file_ids: JSON.stringify(changed),
          compare_trigger: hasProtocol ? opts.trigger : 'INITIAL',
          error: null,
          updated_at: nowIso(),
        },
        'id = ?',
        processId,
      );
      for (const f of files) {
        this.db.update('files', { processing_status: 'QUEUED', error: null }, 'id = ?', f.id as string);
      }
    });
    this.updateProgress(processId);
    this.system('analysis_started', processId, 'process', processId, {
      trigger: hasProtocol ? opts.trigger : 'INITIAL',
      mode: hasProtocol && opts.trigger !== 'MANUAL_RERUN' ? 'INCREMENTAL' : 'FULL',
      files_to_parse: files.length,
    });
    for (const f of files) {
      await this.publishParse(processId, f, 1);
    }
    if (files.length === 0) await this.dispatchCompare(processId);
  }

  private async publishParse(processId: string, f: Row, attempt: number): Promise<void> {
    const payload: E['ParseRequest'] = {
      process_id: processId,
      object_id: f.object_id as string,
      file: {
        file_id: f.id as string,
        sha256: f.file_hash as string,
        format: f.format as S['FileFormat'],
        source: this.storage.ref(f.file_path as string),
        original_name: f.original_name as string,
        size_bytes: f.size_bytes as number,
        stage_hint: (stageOfFile(f) ?? undefined) as DocStage | undefined,
      },
      options: { force_reparse: false, force_ocr: false, timeout_s: Math.round(this.config.ml.jobTimeoutMs / 1000) },
    };
    this.db.update('files', { processing_status: 'PARSING' }, 'id = ?', f.id as string);
    await this.publish('ml.parse.request', processId, payload, f.id as string, attempt);
  }

  private async publish(type: E['EventType'], processId: string, payload: unknown, fileId: string | null, attempt: number): Promise<void> {
    const env: Envelope = {
      message_id: randomUUID(),
      type,
      schema_version: SCHEMA_VERSION,
      correlation_id: processId,
      attempt,
      created_at: nowIso(),
      payload,
    };
    const now = Date.now();
    this.db.insert('ml_jobs', {
      message_id: env.message_id,
      process_id: processId,
      type,
      file_id: fileId,
      attempt,
      status: 'SENT',
      envelope: JSON.stringify(env),
      deadline_at: new Date(now + this.config.ml.jobTimeoutMs).toISOString(),
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    try {
      await this.transport.send(env);
    } catch (err) {
      this.log.warn({ err, type, processId }, 'Не удалось отправить задачу в ML');
      await this.onJobFailure(env.message_id, { code: 'ML_UNAVAILABLE', message: `ML-сервис недоступен: ${String(err)}`, retryable: true });
    }
  }

  // ------------------------------------------------------------- результаты

  /** Точка входа для результатов ML (HTTP callback или заглушка). Идемпотентна по message_id. */
  async handleEnvelope(env: Envelope): Promise<void> {
    const seen = this.db.get('SELECT 1 FROM processed_messages WHERE message_id = ?', env.message_id);
    if (seen) return;
    this.db.insert('processed_messages', { message_id: env.message_id, processed_at: nowIso() });
    if (env.type === 'ml.parse.result') await this.onParseResult(env.payload as E['ParseResult']);
    else if (env.type === 'ml.compare.result') await this.onCompareResult(env.payload as E['CompareResult']);
    else this.log.warn({ type: env.type }, 'Неожиданный тип сообщения от ML');
  }

  private findJob(sql: string, ...args: string[]): Row | undefined {
    return this.db.get(`SELECT * FROM ml_jobs WHERE status = 'SENT' AND ${sql} ORDER BY created_at DESC LIMIT 1`, ...args);
  }

  private async onParseResult(r: E['ParseResult']): Promise<void> {
    const job = this.findJob("type = 'ml.parse.request' AND file_id = ?", r.file_id);
    if (!job) {
      this.log.info({ file_id: r.file_id }, 'Результат парсинга без активной задачи — пропускаем');
      return;
    }
    if (r.status !== 'OK') {
      await this.onJobFailure(job.message_id as string, r.error ?? { code: 'INTERNAL', message: 'Ошибка парсинга', retryable: false });
      return;
    }
    const file = this.db.get<Row>('SELECT * FROM files WHERE id = ?', r.file_id)!;
    const m = r.metadata ?? {};
    const conf = Object.values(m.field_confidence ?? {});
    // Поля манифеста важнее ML; иначе ML уточняет оценку по имени файла
    const fromManifest = file.metadata_source === 'MANIFEST';
    const pick = <T>(ml: T | null | undefined, current: unknown): T | null =>
      (fromManifest ? ((current as T) ?? ml ?? null) : (ml ?? (current as T) ?? null)) as T | null;
    const mlGaveAny = Boolean(m.doc_stage || m.discipline || m.document_code || m.revision);
    this.db.tx(() => {
      this.db.update('ml_jobs', { status: 'DONE', updated_at: nowIso() }, 'message_id = ?', job.message_id as string);
      this.db.update(
        'files',
        {
          processing_status: 'PARSED',
          error: null,
          metadata: JSON.stringify(m),
          doc_stage: m.doc_stage ?? (file.doc_stage as string),
          doc_kind: pick(m.doc_kind, file.doc_kind),
          discipline: pick(m.discipline, file.discipline),
          document_code: pick(m.document_code, file.document_code),
          revision: pick(m.revision, file.revision),
          approval_status: fromManifest && file.approval_status !== 'UNKNOWN' ? (file.approval_status as string) : (m.approval_status ?? (file.approval_status as string)),
          approval_date: pick(m.approval_date, file.approval_date),
          metadata_source: fromManifest ? 'MANIFEST' : mlGaveAny ? 'ML' : (file.metadata_source as string),
          metadata_confidence: conf.length ? conf.reduce((a, b) => a + b, 0) / conf.length : null,
          quality: JSON.stringify(r.quality ?? {}),
          pages_count: r.quality?.pages_total ?? (file.pages_count as number),
          parsed_ref: toJson(r.parsed_ref),
          parser_version: r.parser_version ?? null,
        },
        'id = ?',
        r.file_id,
      );
    });
    this.system('file_parsed', job.process_id as string, 'file', r.file_id, {
      file_name: file.original_name,
      pages: r.quality?.pages_total ?? null,
      doc_stage: m.doc_stage ?? file.doc_stage ?? null,
      metadata_source: fromManifest ? 'MANIFEST' : mlGaveAny ? 'ML' : file.metadata_source,
      parser_version: r.parser_version ?? null,
      from_cache: r.from_cache ?? null,
      duration_ms: r.duration_ms ?? null,
    });
    await this.afterFileDone(job.process_id as string);
  }

  private async afterFileDone(processId: string): Promise<void> {
    this.updateProgress(processId);
    const pending = this.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM files WHERE process_id = ? AND processing_status IN ('QUEUED','PARSING')",
      processId,
    )!.n;
    if (pending === 0 && getProcessRow(this.db, processId).status === 'PARSING') {
      await this.dispatchCompare(processId);
    }
  }

  /** Сбой задачи: повтор (до ML_MAX_RETRIES) или окончательная ошибка с уведомлением администратора. */
  async onJobFailure(messageId: string, error: JobError): Promise<void> {
    const job = this.db.get<Row>('SELECT * FROM ml_jobs WHERE message_id = ?', messageId);
    if (!job || job.status !== 'SENT') return;
    this.db.update('ml_jobs', { status: 'FAILED', updated_at: nowIso() }, 'message_id = ?', messageId);
    const processId = job.process_id as string;
    const attempt = job.attempt as number;
    const env = parseJson<Envelope>(job.envelope, {} as Envelope);

    // Разбор, который ML сам снял по таймауту, повторять бессмысленно: тот же файл на том же
    // железе снова не уложится, а каждая попытка — ещё ML_JOB_TIMEOUT_S занятого воркера. На стенде
    // три попытки по 30 минут давали полтора часа «разбора» одного скана, и всё это время очередь
    // стояла. Файл уходит в FAILED с понятной причиной, проверка идёт дальше без него;
    // «Запустить анализ» ещё раз вернёт его в работу — осознанно, а не по кругу.
    if (job.type === 'ml.parse.request' && error.code === 'TIMEOUT') {
      const minutes = Math.max(1, Math.round(this.config.ml.jobTimeoutMs / 60_000));
      error = {
        ...error,
        retryable: false,
        message:
          `Разбор не уложился в ${minutes} мин и снят: файл слишком тяжёлый для распознавания на этом стенде ` +
          '(нужен предрасчитанный кеш или вариант с видеокартой). Повторный запуск анализа попробует снова.',
      };
    }

    if (error.retryable && attempt <= this.config.ml.maxRetries) {
      this.log.warn({ processId, type: job.type, attempt, error }, 'Повтор задачи ML');
      const target = job.type === 'ml.parse.request' ? ['file', job.file_id as string] : ['process', processId];
      this.system('job_retry', processId, target[0], target[1], {
        job_type: job.type,
        attempt,
        next_attempt: attempt + 1,
        error_code: error.code,
        error: error.message,
      });
      if (job.type === 'ml.parse.request') {
        const f = this.db.get<Row>('SELECT * FROM files WHERE id = ?', job.file_id as string);
        if (f) await this.publishParse(processId, f, attempt + 1);
      } else {
        await this.publish(job.type as E['EventType'], processId, env.payload, null, attempt + 1);
      }
      return;
    }

    const proc = getProcessRow(this.db, processId);
    if (job.type === 'ml.parse.request') {
      this.db.update('files', { processing_status: 'FAILED', error: error.message }, 'id = ?', job.file_id as string);
      this.system('file_failed', processId, 'file', job.file_id as string, { attempts: attempt, error_code: error.code, error: error.message });
      notify(this.db, {
        type: 'ADMIN_ALERT',
        role: 'ADMIN',
        message: `Не удалось обработать файл после ${attempt} попыток: ${error.message}`,
        process_id: processId,
        object_id: proc.object_id as string,
      });
      await this.afterFileDone(processId);
      return;
    }
    this.db.update('processes', { status: 'FAILED', error: error.message, updated_at: nowIso() }, 'id = ?', processId);
    this.updateProgress(processId, 'failed');
    this.system('process_failed', processId, 'process', processId, { stage: 'compare', attempts: attempt, error_code: error.code, error: error.message });
    notify(this.db, {
      type: 'PROCESS_FAILED',
      message: `Проверка не выполнена: ${error.message}`,
      process_id: processId,
      object_id: proc.object_id as string,
    });
    notify(this.db, {
      type: 'ADMIN_ALERT',
      role: 'ADMIN',
      message: `Сбой сравнения после ${attempt} попыток: ${error.message}`,
      process_id: processId,
      object_id: proc.object_id as string,
    });
  }

  /** Все файлы обработаны → статусы загрузки, сценарий и задача сравнения. */
  async dispatchCompare(processId: string): Promise<void> {
    const proc = getProcessRow(this.db, processId);
    const allFiles = this.db.all<Row>('SELECT * FROM files WHERE process_id = ?', processId);
    const completeness = completenessOf(this.db, processId);
    this.db.update(
      'processes',
      {
        upload_status: JSON.stringify(completeness.upload_status),
        scenario: computeScenario(completeness.upload_status, completeness.known_gap),
        updated_at: nowIso(),
      },
      'id = ?',
      processId,
    );
    // дубликаты содержимого в сравнение не идут; заменённые/исключённые редакции идут с пометкой excluded_files
    const parsed = allFiles.filter((f) => f.processing_status === 'PARSED' && !f.duplicate_of);
    const infoById = new Map(listFiles(this.db, processId).map((f) => [f.id, f]));
    if (parsed.length === 0) {
      this.db.update('processes', { status: 'FAILED', error: 'Ни один файл не удалось обработать', updated_at: nowIso() }, 'id = ?', processId);
      this.updateProgress(processId, 'failed');
      this.system('process_failed', processId, 'process', processId, { stage: 'parse', error: 'Ни один файл не удалось обработать' });
      notify(this.db, { type: 'PROCESS_FAILED', message: 'Проверка не выполнена: ни один файл не удалось обработать', process_id: processId, object_id: proc.object_id as string });
      return;
    }
    const lastVersion = this.db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM protocols WHERE process_id = ?', processId)!.v ?? 0;
    const mode = proc.current_protocol_id && proc.compare_mode === 'INCREMENTAL' ? 'INCREMENTAL' : 'FULL';
    const payload: E['CompareRequest'] = {
      process_id: processId,
      object_id: proc.object_id as string,
      protocol_version: lastVersion + 1,
      mode,
      changed_file_ids: parseJson<string[]>(proc.changed_file_ids, []),
      matrix: { version: currentMatrixVersion(this.db), params: listParams(this.db, { is_active: true }) },
      logical_rules: this.db.all("SELECT * FROM logical_rules WHERE is_active = 1").map((r) => ({
        id: r.id as string,
        rule_name: r.rule_name as string,
        condition: r.condition as string,
        expected: r.expected as string,
        normative_base: (r.normative_base as string) ?? null,
        review_priority: r.review_priority as S['ReviewPriority'],
        is_active: true,
      })),
      normative_docs: this.db
        .all("SELECT * FROM normative_base WHERE effective_to IS NULL OR effective_to >= date('now')")
        .map((r) => ({
          id: r.id as string,
          document_name: r.document_name as string,
          document_number: r.document_number as string,
          section: (r.section as string) ?? null,
          parameter_name: (r.parameter_name as string) ?? null,
          min_value: (r.min_value as number) ?? null,
          max_value: (r.max_value as number) ?? null,
          effective_from: (r.effective_from as string) ?? null,
          effective_to: (r.effective_to as string) ?? null,
        })),
      expected_documents: this.db
        .all<Row>('SELECT doc_stage, discipline, document_code, file_name, title FROM expected_documents WHERE process_id = ?', processId)
        .map((e): S['ExpectedDocument'] => ({
          doc_stage: e.doc_stage as S['DocStage'],
          discipline: (e.discipline as string) ?? undefined,
          document_code: (e.document_code as string) ?? undefined,
          file_name: (e.file_name as string) ?? undefined,
          title: (e.title as string) ?? undefined,
        }))
        .concat(
          (activeRegistry(this.db, processId)?.manifest.files ?? [])
            .filter((e) => e.doc_stage)
            .map((e) => ({ doc_stage: e.doc_stage!, discipline: e.discipline, document_code: e.document_code, file_name: e.file_name, title: e.title })),
        ),
      registry_status: activeRegistry(this.db, processId) ? 'PRESENT' : 'ABSENT',
      excluded_files: parsed
        .map((f) => infoById.get(f.id as string))
        .filter((f) => f?.excluded_from_comparison)
        .map((f) => ({ file_id: f!.id, reason: f!.exclusion_reason ?? 'Исключён из эталонного сравнения' })),
      files: parsed.map((f) => ({
        file_id: f.id as string,
        sha256: f.file_hash as string,
        original_name: f.original_name as string,
        parsed_ref: parseJson(f.parsed_ref, this.storage.ref(`parsed/${f.file_hash}`)),
        // метаданные ML + ручные правки инспектора (они приоритетнее)
        metadata: {
          ...parseJson<E['DocumentMetadata']>(f.metadata, {}),
          doc_stage: stageOfFile(f),
          doc_kind: (f.doc_kind as string) ?? null,
          discipline: (f.discipline as string) ?? null,
          document_code: (f.document_code as string) ?? null,
          revision: (f.revision as string) ?? null,
          approval_status: (f.approval_status as S['ApprovalStatus']) ?? 'UNKNOWN',
          approval_date: (f.approval_date as string) ?? null,
          signature_status: (f.signature_status as S['SignatureStatus']) ?? 'UNKNOWN',
        },
        predecessor_id: (f.predecessor_id as string) ?? null,
        successor_id: infoById.get(f.id as string)?.successor_id ?? null,
        external_file_id: (f.external_file_id as string) ?? null,
        in_registry: f.in_registry === 1,
        sheet_page_range: (f.sheet_page_range as string) ?? null,
        metadata_source: (f.metadata_source as S['MetadataSource']) ?? 'FILENAME',
        is_authoritative: f.is_authoritative === null || f.is_authoritative === undefined ? null : f.is_authoritative === 1,
        uploaded_at: f.uploaded_at as string,
      })),
      // Текущая одобренная модель скорера: ML не знает, какая модель текущая, — реестр у api.
      // Нет одобренной — `null`, и ML работает только по правилам, как раньше
      versions: { dataset_version: this.config.versions.datasetVersion, model_version: (currentModel(this.db)?.model_version as string) ?? null },
    };
    this.updateProgress(processId, 'comparing');
    this.system('compare_started', processId, 'process', processId, {
      protocol_version: payload.protocol_version,
      mode,
      files: payload.files.length,
      excluded_files: payload.excluded_files?.length ?? 0,
      params: payload.matrix.params.length,
      matrix_version: payload.matrix.version,
    });
    await this.publish('ml.compare.request', processId, payload, null, 1);
  }

  private async onCompareResult(r: E['CompareResult']): Promise<void> {
    const job = this.findJob("type = 'ml.compare.request' AND process_id = ?", r.process_id);
    const request = job ? parseJson<Envelope<E['CompareRequest']>>(job.envelope, {} as Envelope<E['CompareRequest']>).payload : null;
    if (!job || !request || request.protocol_version !== r.protocol_version) {
      this.log.info({ process_id: r.process_id }, 'Результат сравнения без активной задачи — пропускаем');
      return;
    }
    if (r.status !== 'OK') {
      await this.onJobFailure(job.message_id as string, r.error ?? { code: 'INTERNAL', message: 'Ошибка сравнения', retryable: false });
      return;
    }
    const proc = getProcessRow(this.db, r.process_id);
    this.db.tx(() => {
      this.db.update('ml_jobs', { status: 'DONE', updated_at: nowIso() }, 'message_id = ?', job.message_id as string);
      persistCompareResult(this.db, proc, request, r, (proc.compare_trigger as Trigger) ?? 'INITIAL');
    });
    const protocolId = getProcessRow(this.db, r.process_id).current_protocol_id as string;
    const counts = countsForProtocol(this.db, protocolId);
    this.system('protocol_created', r.process_id, 'protocol', protocolId, {
      version: r.protocol_version,
      mode: r.mode ?? request.mode,
      checks: r.checks?.length ?? 0,
      candidates: counts.candidates_pending ?? 0,
      suspicions: counts.suspicions ?? 0,
      model_version: r.versions?.model_version ?? null,
      duration_ms: r.stats?.duration_ms ?? null,
    });
    notify(this.db, {
      type: 'PROTOCOL_READY',
      message: `Протокол готов (версия ${r.protocol_version}): кандидатов ${counts.candidates_pending}, гипотез ${counts.suspicions}`,
      process_id: r.process_id,
      object_id: proc.object_id as string,
    });
  }

  // ------------------------------------------------------------- служебное

  /** Действие автоматизированной системы — в тот же журнал аудита, что и действия пользователей (actor_type = SYSTEM). */
  private system(action: string, processId: string, entityType: string, entityId: string | null, details: Record<string, unknown>): void {
    const proc = this.db.get<{ object_id: string }>('SELECT object_id FROM processes WHERE id = ?', processId);
    audit(this.db, {
      user_id: null,
      action: `system.${action}`,
      object_id: proc?.object_id ?? null,
      entity_type: entityType,
      entity_id: entityId,
      details: { process_id: processId, ...details },
    });
  }

  /** Сверка задач с ML и таймауты (вызывается по таймеру). Обходы не накладываются друг на друга. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const alive = await this.reconcile();
      const expired = this.db.all<Row>("SELECT message_id FROM ml_jobs WHERE status = 'SENT' AND deadline_at < ?", nowIso());
      for (const j of expired) {
        const id = j.message_id as string;
        if (alive.has(id)) {
          // ML подтвердил, что задача у него в очереди или в работе: срок api отсчитывает от
          // отправки, а задача могла простоять в очереди за двумя тяжёлыми сканами. Снять её
          // сейчас значило бы отправить в ML второй экземпляр, пока первый ещё не начат.
          // Время выполнения ML ограничивает сам (`options.timeout_s`) и ответит TIMEOUT.
          const deadline = new Date(Date.now() + this.config.ml.jobTimeoutMs).toISOString();
          this.db.update('ml_jobs', { deadline_at: deadline, updated_at: nowIso() }, 'message_id = ?', id);
          continue;
        }
        await this.onJobFailure(id, { code: 'ML_NO_RESPONSE', message: 'ML-сервис не ответил за отведённое время', retryable: true });
      }
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Сверка отправленных задач с ML: `GET /v1/jobs/{id}` (контракт: «повторный забор результата»).
   *
   * Очередь ML живёт в памяти процесса. После его перезапуска всё, что ему отдали, пропадает,
   * а api об этом не узнаёт: задача висит в `SENT` до дедлайна (`ML_JOB_TIMEOUT_S`, на стенде
   * 30 минут), и файл всё это время «разбирается». Поймано 22.09 на живом стенде:
   * «ни рестарт ml, ни рестарт api не возвращают файл в работу».
   *
   * - ML задачу не знает — она потеряна: отправляем заново сразу (это считается попыткой,
   *   иначе задача, которая сама роняет ML, ходила бы по кругу);
   * - ML её закончил, а результат до api не дошёл — забираем его сами;
   * - задача в очереди или в работе — она жива, дедлайн продлевает `sweep`.
   *
   * ML недоступен — сверку откладываем, дальше решает обычный дедлайн. Возвращает задачи,
   * которые ML подтвердил живыми.
   */
  async reconcile(): Promise<Set<string>> {
    const alive = new Set<string>();
    const transport = this.transport;
    if (!transport.status) return alive;
    const settled = new Date(Date.now() - this.config.ml.probeGraceMs).toISOString();
    const jobs = this.db.all<Row>("SELECT message_id FROM ml_jobs WHERE status = 'SENT' AND created_at <= ? ORDER BY created_at", settled);
    for (const j of jobs) {
      const id = j.message_id as string;
      let probe: JobProbe;
      try {
        probe = await transport.status(id);
      } catch (err) {
        this.log.debug({ err }, 'ML не отвечает на сверку задач — ждём дедлайна');
        return alive;
      }
      // пока спрашивали, результат мог прийти обычным путём
      if (!this.db.get("SELECT 1 FROM ml_jobs WHERE message_id = ? AND status = 'SENT'", id)) continue;
      if (probe === null) {
        this.log.warn({ message_id: id }, 'ML не знает задачу (перезапускался) — отправляем заново');
        await this.onJobFailure(id, { code: 'ML_JOB_LOST', message: 'ML-сервис перезапускался и потерял задачу', retryable: true });
      } else if (probe.state === 'QUEUED' || probe.state === 'RUNNING') {
        alive.add(id);
      } else if (probe.result) {
        this.log.warn({ message_id: id }, 'Результат ML не дошёл до api — забираем сами');
        await this.handleEnvelope(probe.result);
      }
    }
    return alive;
  }

  updateProgress(processId: string, stage?: string): void {
    const files = this.db.all<{ processing_status: string }>('SELECT processing_status FROM files WHERE process_id = ?', processId);
    const total = files.length;
    const parsed = files.filter((f) => f.processing_status === 'PARSED').length;
    const failed = files.filter((f) => f.processing_status === 'FAILED').length;
    const proc = getProcessRow(this.db, processId);
    const st = stage ?? (proc.status === 'PARSING' ? 'parsing' : 'done');
    const percent =
      st === 'done' ? 100 : st === 'comparing' ? 80 : st === 'failed' ? 100 : total ? Math.round(((parsed + failed) / total) * 70) : 0;
    this.db.update(
      'processes',
      { progress: JSON.stringify({ files_total: total, files_parsed: parsed, files_failed: failed, stage: st, percent }), updated_at: nowIso() },
      'id = ?',
      processId,
    );
  }
}

// ------------------------------------------------------------------------------------------
// Сохранение результата сравнения как новой версии протокола (с переносом решений инспектора)
// ------------------------------------------------------------------------------------------

const sig = (fragments: { sha256: string; page: number }[]) =>
  fragments
    .map((f) => `${f.sha256}:${f.page}`)
    .sort()
    .join('|');

function insertGroup(db: Db, objectId: string, paramCode: string, ruleKey: string | null, fragments: S['EvidenceFragment'][]): string {
  const groupId = randomUUID();
  db.insert('evidence_groups', {
    id: groupId,
    object_id: objectId,
    param_code: paramCode,
    rule_key: ruleKey,
    version: 1,
    source: 'MODEL',
    created_at: nowIso(),
  });
  for (const f of fragments) {
    db.insert('evidence_fragments', {
      id: randomUUID(),
      evidence_group_id: groupId,
      role: f.role,
      file_id: f.file_id,
      sha256: f.sha256,
      stage: f.stage,
      document_code: f.document_code ?? null,
      revision: f.revision ?? null,
      approval_status: f.approval_status ?? null,
      page: f.page,
      sheet: f.sheet ?? null,
      bbox: JSON.stringify(f.bbox),
      polygon: toJson(f.polygon),
      extracted_value: f.extracted_value ?? null,
      normalized_value: f.normalized_value ?? null,
      text_snippet: f.text_snippet ?? null,
      source: f.source ?? null,
      extraction_method: f.extraction_method ?? null,
      quality: f.quality ?? null,
      confidence: f.confidence ?? null,
    });
  }
  return groupId;
}

function fragmentSig(db: Db, groupId: string): string {
  return sig(db.all<{ sha256: string; page: number }>('SELECT sha256, page FROM evidence_fragments WHERE evidence_group_id = ?', groupId));
}

/** Копия строки checks в новый протокол вместе с историей решений (и дочерними split-findings). */
function cloneCheck(db: Db, prev: Row, protocolId: string, parentId: string | null, pagePairId: string | null): string {
  const id = randomUUID();
  const { id: _old, protocol_id: _p, parent_check_id: _pc, page_pair_id: _pp, ...rest } = prev;
  db.insert('checks', {
    ...(rest as Record<string, string | number | null>),
    id,
    protocol_id: protocolId,
    parent_check_id: parentId,
    page_pair_id: pagePairId,
    updated_at: nowIso(),
  });
  for (const d of db.all<Row>('SELECT * FROM finding_decisions WHERE check_id = ? ORDER BY decided_at, rowid', prev.id as string)) {
    db.insert('finding_decisions', { ...(d as Record<string, string | number | null>), id: randomUUID(), check_id: id });
  }
  for (const child of db.all<Row>('SELECT * FROM checks WHERE parent_check_id = ?', prev.id as string)) {
    cloneCheck(db, child, protocolId, id, pagePairId);
  }
  return id;
}

/** Статус процесса по состоянию верификации текущего протокола. */
export function verificationStatus(db: Db, protocolId: string): { process: ProcessStatus; protocol: S['ProtocolVerificationStatus'] } {
  const counts = countsForProtocol(db, protocolId);
  const decided = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM finding_decisions d JOIN checks c ON c.id = d.check_id WHERE c.protocol_id = ?',
    protocolId,
  )!.n;
  if ((counts.candidates_pending ?? 0) === 0 && decided > 0) return { process: 'COMPLETED', protocol: 'VERIFICATION_COMPLETED' };
  if (decided > 0) return { process: 'VERIFYING', protocol: 'IN_PROGRESS' };
  return { process: 'READY', protocol: 'IN_PROGRESS' };
}

export function syncVerificationStatus(db: Db, processId: string): void {
  const proc = getProcessRow(db, processId);
  if (!proc.current_protocol_id || proc.status === 'FINALIZED' || proc.status === 'PARSING') return;
  const st = verificationStatus(db, proc.current_protocol_id as string);
  db.update('processes', { status: st.process, updated_at: nowIso() }, 'id = ?', processId);
  db.update('protocols', { status: st.protocol }, 'id = ?', proc.current_protocol_id as string);
}

function persistCompareResult(db: Db, proc: Row, req: E['CompareRequest'], r: E['CompareResult'], trigger: Trigger): void {
  const processId = proc.id as string;
  const objectId = proc.object_id as string;
  const prevId = (proc.current_protocol_id as string) ?? null;
  const protocolId = randomUUID();
  // входные файлы версии — ровно те, что ушли в сравнение (без дубликатов содержимого)
  const compared = new Set(req.files.map((f) => f.file_id));
  const inputFiles = listFiles(db, processId).filter((f) => compared.has(f.id));
  // Полнота: худшее из оценки api (манифест) и движка (источники параметров); без манифеста — не UPLOADED
  const completeness = completenessOf(db, processId);
  const uploadStatus = mergeUploadStatus(completeness.upload_status, r.upload_status);
  const scenario = completeness.known_gap ? 'PARTIALLY_LOADED' : (r.scenario ?? computeScenario(uploadStatus));
  const versions = {
    matrix_version: r.versions?.matrix_version ?? req.matrix.version,
    model_version: r.versions?.model_version ?? 'unknown',
    dataset_version: r.versions?.dataset_version ?? req.versions.dataset_version,
    parser_version: r.versions?.parser_version ?? null,
    input_manifest_hash: manifestHash(inputFiles.map((f) => f.sha256)),
  };

  if (prevId) db.update('protocols', { is_current: 0 }, 'id = ?', prevId);
  db.insert('protocols', {
    id: protocolId,
    process_id: processId,
    object_id: objectId,
    version: r.protocol_version,
    status: 'IN_PROGRESS',
    is_current: 1,
    trigger: prevId ? trigger : 'INITIAL',
    scenario,
    upload_status: JSON.stringify(uploadStatus),
    ...versions,
    // полнота на момент сравнения — для экспорта прежних версий протокола
    snapshot: JSON.stringify({
      input_files: inputFiles,
      completeness: completenessSummary(db, processId),
      file_resolution: r.file_resolution ?? [],
      stats: r.stats ?? {},
      mode: r.mode ?? req.mode,
    }),
    created_at: nowIso(),
    finalized_at: null,
  });

  const pairIds = new Map<string, string>();
  for (const pp of r.page_pairs ?? []) {
    const id = randomUUID();
    pairIds.set(pp.pair_key, id);
    db.insert('page_pairs', {
      id,
      protocol_id: protocolId,
      pair_key: pp.pair_key,
      left_file_id: pp.left.file_id,
      left_page: pp.left.page,
      right_file_id: pp.right.file_id,
      right_page: pp.right.page,
      match_score: pp.match_score,
      homography: toJson(pp.homography),
      compliance_percent: pp.compliance_percent ?? null,
      diff_regions: JSON.stringify(pp.diff_regions ?? []),
    });
  }

  const prevChecks = prevId ? db.all<Row>('SELECT * FROM checks WHERE protocol_id = ? AND parent_check_id IS NULL', prevId) : [];
  const prevByKey = new Map(prevChecks.map((c) => [c.finding_key as string, c]));
  const affected = r.mode === 'INCREMENTAL' && r.affected_param_codes ? new Set(r.affected_param_codes) : null;

  // Параметры вне пересчёта — переносим из прошлой версии как есть
  if (affected) {
    for (const c of prevChecks) {
      if (!affected.has(c.param_code as string)) cloneCheck(db, c, protocolId, null, null);
    }
  }

  const checkIds = new Map<string, string>();
  const params = new Map(listParams(db).map((p) => [p.code, p]));
  for (const c of r.checks ?? []) {
    const prev = prevByKey.get(c.finding_key);
    const fragments = c.fragments ?? [];
    const pagePairId = c.page_pair_key ? pairIds.get(c.page_pair_key) ?? null : null;
    // сравниваем с последней машинной версией: правки инспектора не считаются «изменением доказательств»
    const sameEvidence = prev ? fragmentSig(db, modelGroupOf(db, prev.evidence_group_id as string)) === sig(fragments) : false;
    const prevDecided = prev && (prev.inspector_status !== 'PENDING' || prev.is_split === 1);

    if (prev && prevDecided && sameEvidence) {
      // доказательства не изменились — переносим решение инспектора (и разбиение на части)
      const id = cloneCheck(db, prev, protocolId, null, pagePairId);
      checkIds.set(c.finding_key, id);
      continue;
    }
    const groupId = insertGroup(db, objectId, c.param_code, c.rule_key ?? null, fragments);
    const id = randomUUID();
    checkIds.set(c.finding_key, id);
    db.insert('checks', {
      id,
      protocol_id: protocolId,
      process_id: processId,
      object_id: objectId,
      param_id: params.get(c.param_code)?.id ?? null,
      param_code: c.param_code,
      finding_key: c.finding_key,
      rule_key: c.rule_key ?? null,
      finding_status: c.finding_status,
      model_finding_status: c.finding_status,
      completeness_status: c.completeness_status,
      inspector_status: 'PENDING',
      stages_compared: JSON.stringify(c.stages_compared ?? []),
      missing_sources: JSON.stringify(c.missing_sources ?? []),
      expected_value: c.expected_value ?? null,
      actual_value: c.actual_value ?? null,
      delta: c.delta ?? null,
      stage_comparisons: JSON.stringify(c.stage_comparisons ?? []),
      unit: c.unit ?? null,
      review_priority: c.review_priority,
      risk_level: c.risk_level ?? c.review_priority,
      rationale: c.rationale ?? null,
      rationale_source: c.rationale_source ?? 'RULES',
      normative_reference: c.normative_reference ?? null,
      confidence: c.confidence ?? null,
      approved_change_ref: c.approved_change_ref ?? null,
      evidence_group_id: groupId,
      page_pair_id: pagePairId,
      parent_check_id: null,
      is_split: 0,
      evidence_changed: prevDecided && !sameEvidence ? 1 : 0,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
  }

  const prevSusp = prevId ? new Map(db.all<Row>('SELECT * FROM suspicions WHERE protocol_id = ?', prevId).map((s) => [s.suspicion_key as string, s])) : new Map<string, Row>();
  const suspIds = new Map<string, string>();
  for (const s of r.suspicions ?? []) {
    const id = randomUUID();
    suspIds.set(s.suspicion_key, id);
    const prev = prevSusp.get(s.suspicion_key);
    db.insert('suspicions', {
      id,
      protocol_id: protocolId,
      process_id: processId,
      object_id: objectId,
      suspicion_key: s.suspicion_key,
      discovery_method: s.discovery_method,
      confidence: s.confidence,
      description: s.description,
      pd_reference: s.pd_reference ?? null,
      rd_reference: s.rd_reference ?? null,
      id_reference: s.id_reference ?? null,
      review_priority: s.review_priority,
      normative_base: s.normative_base ?? null,
      rule_id: s.rule_id ?? null,
      inspector_status: (prev?.inspector_status as string) ?? 'PENDING',
      evidence: JSON.stringify(s.evidence ?? []),
      page_pair_id: s.page_pair_key ? pairIds.get(s.page_pair_key) ?? null : null,
      promoted_check_id: (prev?.promoted_check_id as string) ?? null,
      comment: (prev?.comment as string) ?? null,
      created_at: nowIso(),
      updated_at: nowIso(),
    });
  }

  // Ссылки областей различий на findings/гипотезы
  for (const pp of r.page_pairs ?? []) {
    const regions = (pp.diff_regions ?? []).map((d) => ({
      left_bbox: d.left_bbox,
      right_bbox: d.right_bbox,
      score: d.score ?? null,
      label: d.label ?? null,
      finding_id: d.finding_key ? checkIds.get(d.finding_key) ?? null : null,
      suspicion_id: d.suspicion_key ? suspIds.get(d.suspicion_key) ?? null : null,
    }));
    db.update('page_pairs', { diff_regions: JSON.stringify(regions) }, 'id = ?', pairIds.get(pp.pair_key)!);
  }

  const st = verificationStatus(db, protocolId);
  db.update('protocols', { status: st.protocol }, 'id = ?', protocolId);
  const files = listFiles(db, processId);
  const pd = files.filter((f) => f.processing_status === 'PARSED').length;
  db.update(
    'processes',
    {
      status: st.process,
      current_protocol_id: protocolId,
      scenario,
      upload_status: JSON.stringify(uploadStatus),
      compare_mode: null,
      changed_file_ids: null,
      compare_trigger: null,
      error: null,
      progress: JSON.stringify({ files_total: files.length, files_parsed: pd, files_failed: files.length - pd, stage: 'done', percent: 100 }),
      updated_at: nowIso(),
    },
    'id = ?',
    processId,
  );
}
