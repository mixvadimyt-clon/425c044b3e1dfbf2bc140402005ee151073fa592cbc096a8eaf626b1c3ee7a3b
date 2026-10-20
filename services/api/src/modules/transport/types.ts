import type { Envelope } from '../../types.js';

/**
 * Что ML знает о задаче (`GET /v1/jobs/{message_id}`). `null` — не знает совсем: очередь ML живёт
 * в памяти процесса, и после его перезапуска всё отданное ему пропадает.
 */
export type JobProbe = { state: 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED'; result?: Envelope | null } | null;

/**
 * Транспорт задач api → ml. Результаты возвращаются в Orchestrator.handleEnvelope:
 * - http: ml присылает POST /internal/ml/results (reply_to);
 * - stub: заглушка внутри процесса api (для фронтенда и демо без ML);
 * - amqp (позже, опционально): те же Envelope через RabbitMQ.
 */
export interface MlTransport {
  readonly kind: string;
  send(envelope: Envelope): Promise<void>;
  /**
   * Спросить ML о задаче — для сверки зависших (Orchestrator.reconcile). Транспорт без метода
   * сверку не поддерживает; ML недоступен — исключение, и тогда работает обычный дедлайн.
   */
  status?(messageId: string): Promise<JobProbe>;
  close?(): Promise<void>;
}
