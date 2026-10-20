import { createHash, createHmac } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AppConfig } from '../../config.js';
import type { R } from '../../types.js';

/**
 * HTTP-клиент внешней ИС надзора по contracts/openapi/rin-external.v1.yaml.
 * Аутентификация — bearer-токен и подпись тела HMAC-SHA256 (мок УКЭП, REQ-INT-02), таймаут на каждый запрос.
 */

/** Ошибка обмена. retryable — сбой сети, таймаут или 5xx: отправку стоит повторить (REQ-INT-03). */
export class RinError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

/** Файл больше предела: скачивание оборвано, это отказ пакета, а не сбой связи. */
export class DownloadTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`больше предела ${Math.round(limitBytes / 1024 / 1024)} МБ`);
  }
}

export interface PushOutcome {
  receipt: R['ResultReceipt'];
  status: number;
}

export class RinClient {
  constructor(private readonly cfg: AppConfig['rin']) {}

  get enabled(): boolean {
    return Boolean(this.cfg.url);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.cfg.token ? { authorization: `Bearer ${this.cfg.token}` } : {}), ...extra };
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.url}${path}`, { ...init, signal: AbortSignal.timeout(this.cfg.timeoutMs) });
    } catch (err) {
      const e = err as Error;
      const timeout = e.name === 'TimeoutError' || e.name === 'AbortError';
      throw new RinError(
        timeout ? `нет ответа за ${Math.round(this.cfg.timeoutMs / 1000)} с` : `нет связи: ${(e.cause as Error)?.message ?? e.message}`,
        true,
      );
    }
    if (!res.ok) {
      let detail = '';
      try {
        const body = (await res.json()) as R['RinError'];
        detail = body.message ? `: ${body.message}` : '';
      } catch {
        // тело не JSON — хватит кода ответа
      }
      throw new RinError(`ответ ${res.status}${detail}`, res.status >= 500 || res.status === 429, res.status);
    }
    return res;
  }

  async listPackages(): Promise<R['Package'][]> {
    const res = await this.request('/api/v1/packages', { headers: this.headers() });
    return ((await res.json()) as R['PackageList']).items;
  }

  /**
   * Скачать файл пакета потоком во временный файл; размер и sha256 считаются по пути.
   * Больше `maxBytes` — обрыв на пределе: заявленному размеру и content-length верить нельзя.
   */
  async download(url: string, tmpPath: string, maxBytes = Infinity): Promise<{ sizeBytes: number; sha256: string }> {
    const res = await this.request(url, { headers: this.headers() });
    if (!res.body) throw new RinError('пустой ответ', true);
    if (Number(res.headers.get('content-length') ?? 0) > maxBytes) {
      await res.body.cancel();
      throw new DownloadTooLargeError(maxBytes);
    }
    const hash = createHash('sha256');
    let size = 0;
    await pipeline(
      Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
      new Transform({
        transform(chunk: Buffer, _e, cb) {
          size += chunk.length;
          if (size > maxBytes) {
            cb(new DownloadTooLargeError(maxBytes));
            return;
          }
          hash.update(chunk);
          cb(null, chunk);
        },
      }),
      createWriteStream(tmpPath),
    );
    return { sizeBytes: size, sha256: hash.digest('hex') };
  }

  /** Небольшой файл целиком в память (реестр пакета) — с тем же обрывом на пределе. */
  async downloadBuffer(url: string, maxBytes = Infinity): Promise<Buffer> {
    const res = await this.request(url, { headers: this.headers() });
    if (!res.body) throw new RinError('пустой ответ', true);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) throw new DownloadTooLargeError(maxBytes);
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  /** Отправить результат проверки. Тело уже сериализовано: подпись считается по тем же байтам, что уходят в сеть. */
  async pushResult(body: string, idempotencyKey: string): Promise<PushOutcome> {
    const extra: Record<string, string> = { 'content-type': 'application/json', 'x-idempotency-key': idempotencyKey };
    if (this.cfg.secret) extra['x-signature'] = createHmac('sha256', this.cfg.secret).update(body).digest('hex');
    const res = await this.request('/api/v1/results', { method: 'POST', headers: this.headers(extra), body });
    return { receipt: (await res.json()) as R['ResultReceipt'], status: res.status };
  }
}
