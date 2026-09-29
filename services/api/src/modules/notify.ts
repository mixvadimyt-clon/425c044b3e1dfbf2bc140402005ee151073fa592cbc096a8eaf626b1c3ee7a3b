import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import { type Db, nowIso } from '../db/sqlite.js';
import type { Role, S } from '../types.js';

/**
 * Куда, кроме базы, уходит журнал действий («кто с какого браузера
 * зашёл, что загрузил, что получил»).
 *
 * В базе журнал был всегда — вместе с IP и строкой браузера. Здесь добавлены два канала:
 * файл JSON Lines рядом с данными и вебхук, в том числе Telegram. **Внешние каналы выключены
 * по умолчанию:** документы госнадзора и 152-ФЗ — закрытый контур, и отправка действий
 * пользователей наружу должна быть решением того, кто разворачивает, а не поведением из коробки.
 *
 * Канал никогда не ломает запрос: ошибка записи логируется и проглатывается, отправка идёт
 * без ожидания ответа.
 */
type Logger = { warn: (o: unknown, m: string) => void };
let sinks: (AppConfig['audit'] & { log?: Logger }) | null = null;

export function setAuditSinks(config: AppConfig, log?: Logger): void {
  sinks = { ...config.audit, log };
  telegram = { queue: [], dropped: 0, busy: false };
  if (sinks.file) mkdirSync(path.dirname(path.resolve(sinks.file)), { recursive: true });
}

/** «Chrome · Windows» вместо строки на 150 знаков — как в scripts/stand-logins.sh; незнакомое — коротко как есть. */
function browser(ua: unknown): string {
  if (typeof ua !== 'string' || !ua) return '';
  const pick = (pairs: [string, string][]) => pairs.find(([k]) => ua.includes(k))?.[1];
  const name = pick([['YaBrowser', 'Яндекс Браузер'], ['Edg/', 'Edge'], ['OPR/', 'Opera'], ['Firefox/', 'Firefox'], ['Chrome/', 'Chrome'], ['Safari/', 'Safari']]);
  const os = pick([['Windows', 'Windows'], ['Android', 'Android'], ['iPhone', 'iOS'], ['iPad', 'iPadOS'], ['Mac OS X', 'macOS'], ['Linux', 'Linux']]);
  return name ? [name, os].filter(Boolean).join(' · ') : ua.slice(0, 40);
}

/**
 * Сообщение в Telegram: время по Москве, кто, что сделал и с каким итогом, адрес и браузер.
 * Вход подписан логином из запроса (пользователя ещё нет), остальное — логином из базы.
 */
export function telegramText(entry: Record<string, unknown>, login?: string | null): string {
  const d = (entry.details ?? {}) as Record<string, unknown>;
  // МСК без часового пояса из ICU: переходов на летнее время в Москве нет с 2014 года
  const msk = new Date(Date.parse(String(entry.timestamp)) + 3 * 3600_000).toISOString();
  const time = `${msk.slice(8, 10)}.${msk.slice(5, 7)} ${msk.slice(11, 19)}`;
  let head: string;
  if (entry.action === 'login') {
    const result = d.success ? (d.open_access ? 'вход ✓ без пароля' : 'вход ✓') : d.blocked ? 'вход заблокирован' : 'неверный пароль';
    head = `${d.login ?? '—'} · ${result}`;
  } else {
    const who = login ?? (entry.user_role ? String(entry.user_role).toLowerCase() : 'система');
    head = `${who} · ${entry.action}${d.status_code ? ` → ${d.status_code}` : ''}`;
  }
  const where = [entry.ip_address, browser(entry.user_agent)].filter(Boolean).join(' · ');
  return `${time} МСК · ${head}${where ? `\n${where}` : ''}`;
}

/** Сколько ждать ответа канала. 28.09 из Yandex Cloud первое соединение с Telegram после перезапуска api
 * не укладывалось в прежние 3 с и первое сообщение терялось. Отправка идёт без ожидания, запрос не держит. */
export const DELIVERY_TIMEOUT_MS = 10_000;
/** Пауза перед единственным повтором после сетевой ошибки. */
export const RETRY_DELAY_MS = 2_000;
/** Дольше `retry_after` от Telegram (429: в группу — около 20 сообщений в минуту) не ждём. */
const MAX_RETRY_AFTER_S = 30;

/**
 * Пауза между сообщениями в Telegram. В группу пропускается около 20 сообщений в минуту, а api слал каждую запись
 * журнала отдельным сообщением: 29.09 при загрузке контрольных комплектов записи пошли пачкой, Telegram ответил 429
 * с `retry_after` 39 с, и часть записей потерялась. Теперь сообщения идут по одному с паузой, а записи,
 * накопившиеся за паузу, склеиваются в одно сообщение.
 */
export const TELEGRAM_INTERVAL_MS = 3_100;
/** Предел текста сообщения Telegram — 4096 знаков; склеиваем с запасом. */
export const TELEGRAM_MAX_TEXT = 3_900;
/** Сколько записей ждёт в очереди, пока Telegram недоступен; сверх этого старые отбрасываются со счётчиком. */
const TELEGRAM_QUEUE_MAX = 1_000;

type TelegramQueue = { queue: string[]; dropped: number; busy: boolean };
let telegram: TelegramQueue = { queue: [], dropped: 0, busy: false };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function enqueueTelegram(text: string): void {
  if (telegram.queue.length >= TELEGRAM_QUEUE_MAX) {
    telegram.queue.shift();
    telegram.dropped += 1;
  }
  telegram.queue.push(text.slice(0, TELEGRAM_MAX_TEXT));
  if (!telegram.busy) void pumpTelegram(telegram);
}

/** Отправляет очередь, пока она не опустеет. `setAuditSinks` заводит новую очередь — старый цикл на ней завершается. */
async function pumpTelegram(state: TelegramQueue): Promise<void> {
  state.busy = true;
  try {
    while (state === telegram && state.queue.length && sinks?.telegramToken && sinks.telegramChat) {
      const lines: string[] = [];
      if (state.dropped) {
        lines.push(`… пропущено записей: ${state.dropped} — Telegram был недоступен, полный журнал в базе`);
        state.dropped = 0;
      }
      let size = lines.join('\n\n').length;
      while (state.queue.length && (!lines.length || size + 2 + state.queue[0].length <= TELEGRAM_MAX_TEXT)) {
        const next = state.queue.shift()!;
        size += (lines.length ? 2 : 0) + next.length;
        lines.push(next);
      }
      const body = { chat_id: sinks.telegramChat, text: lines.join('\n\n'), disable_notification: true };
      await deliver('telegram', `https://api.telegram.org/bot${sinks.telegramToken}/sendMessage`, JSON.stringify(body), 0);
      await sleep(TELEGRAM_INTERVAL_MS);
    }
  } finally {
    state.busy = false;
  }
}

/** Одна запись в канал: сетевая ошибка и 429 — один повтор, остальной отказ и повторная неудача — в лог. */
async function deliver(channel: 'webhook' | 'telegram', url: string, body: string, attempt: number): Promise<void> {
  let r: Response;
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
  } catch (err) {
    if (attempt === 0) {
      await sleep(RETRY_DELAY_MS);
      return deliver(channel, url, body, 1);
    }
    sinks?.log?.warn({ channel, err }, 'Не удалось отправить запись журнала действий');
    return;
  }
  if (r.ok) return;
  const text = await r.text().catch(() => '');
  let description = text.slice(0, 300);
  let retryAfter: number | undefined;
  try {
    const parsed = JSON.parse(text) as { description?: unknown; parameters?: { retry_after?: unknown } };
    description = String(parsed.description ?? description);
    retryAfter = Number(parsed.parameters?.retry_after) || undefined;
  } catch {
    // не JSON — оставляем начало ответа как есть
  }
  if (r.status === 429 && attempt === 0) {
    await sleep(Math.min(retryAfter ?? 1, MAX_RETRY_AFTER_S) * 1000);
    return deliver(channel, url, body, 1);
  }
  sinks?.log?.warn({ channel, status: r.status, description }, 'Канал журнала действий отказал в приёме записи');
}

function emit(entry: Record<string, unknown>, db?: Db): void {
  if (!sinks) return;
  try {
    if (sinks.file) appendFileSync(sinks.file, `${JSON.stringify(entry)}
`, 'utf8');
  } catch (err) {
    sinks.log?.warn({ err }, 'Не удалось дописать журнал действий в файл');
  }
  // Адрес в лог не пишем: у Telegram в нём токен бота. Отказ получателя («chat not found», «Unauthorized»)
  // тоже в лог — 28.09 на стенде сообщения молча не доходили из-за id группы без минуса.
  const post = (channel: 'webhook' | 'telegram', url: string, body: unknown) => void deliver(channel, url, JSON.stringify(body), 0);

  if (sinks.webhookUrl) post('webhook', sinks.webhookUrl, entry);
  if (sinks.telegramToken && sinks.telegramChat) {
    const login = entry.user_id && db ? db.get<{ login: string }>('SELECT login FROM users WHERE id = ?', String(entry.user_id))?.login : null;
    enqueueTelegram(telegramText(entry, login));
  }
}

type NotificationType = S['Notification']['type'];

/** Уведомление: адресуется пользователю, роли или всем (user_id и role = null). */
export function notify(
  db: Db,
  n: { type: NotificationType; message: string; role?: Role | null; user_id?: string | null; process_id?: string | null; object_id?: string | null },
): void {
  db.insert('notifications', {
    id: randomUUID(),
    user_id: n.user_id ?? null,
    role: n.role ?? null,
    type: n.type,
    message: n.message,
    process_id: n.process_id ?? null,
    object_id: n.object_id ?? null,
    is_read: 0,
    created_at: nowIso(),
  });
}

export function audit(
  db: Db,
  a: {
    user_id?: string | null;
    /** Роль на момент действия: позже она может измениться, а журнал должен показывать тогдашнюю. */
    user_role?: string | null;
    action: string;
    object_id?: string | null;
    entity_type?: string | null;
    entity_id?: string | null;
    details?: Record<string, unknown> | null;
    ip_address?: string | null;
    user_agent?: string | null;
  },
): void {
  const entry = {
    id: randomUUID(),
    user_id: a.user_id ?? null,
    user_role: a.user_role ?? null,
    action: a.action,
    object_id: a.object_id ?? null,
    entity_type: a.entity_type ?? null,
    entity_id: a.entity_id ?? null,
    details: a.details ? JSON.stringify(a.details) : null,
    timestamp: nowIso(),
    ip_address: a.ip_address ?? null,
    user_agent: a.user_agent ?? null,
  };
  db.insert('audit_log', entry);
  emit({ ...entry, details: a.details ?? null }, db);
}

type AuditEntry = Parameters<typeof audit>[1];

/**
 * Строка журнала до действия. Раньше журнал писался после ответа, и если запись
 * не удавалась, изменение оставалось без следа. Теперь сначала журнал: не записался — исключение,
 * и обработчик не выполняется. Итог (код ответа, подробности) дописывает `auditFinish`; если процесс
 * упадёт посередине, в журнале останется «начато» — попытка видна, а не потеряна.
 */
export function auditStart(db: Db, a: AuditEntry): string {
  const id = randomUUID();
  db.insert('audit_log', {
    id,
    user_id: a.user_id ?? null,
    user_role: a.user_role ?? null,
    action: a.action,
    object_id: a.object_id ?? null,
    entity_type: a.entity_type ?? null,
    entity_id: a.entity_id ?? null,
    details: JSON.stringify({ state: 'STARTED', ...(a.details ?? {}) }),
    timestamp: nowIso(),
    ip_address: a.ip_address ?? null,
    user_agent: a.user_agent ?? null,
  });
  return id;
}

/** Итог действия в строку, записанную `auditStart`; копия в файл и вебхук — только итоговая. */
export function auditFinish(db: Db, id: string, a: AuditEntry): void {
  const values = {
    user_id: a.user_id ?? null,
    user_role: a.user_role ?? null,
    object_id: a.object_id ?? null,
    entity_type: a.entity_type ?? null,
    entity_id: a.entity_id ?? null,
    details: a.details ? JSON.stringify(a.details) : null,
  };
  db.update('audit_log', values, 'id = ?', id);
  const row = db.get<Record<string, unknown>>('SELECT * FROM audit_log WHERE id = ?', id);
  if (row) emit({ ...(row as Parameters<typeof emit>[0]), details: a.details ?? null }, db);
}
