import { describe, expect, it } from 'vitest';
import { STALL_THRESHOLD_MS, isProcessStalled } from './processes';

describe('isProcessStalled', () => {
  const now = Date.parse('2026-09-22T12:00:00Z');

  it('без отметки времени — не завис (только что создан)', () => {
    expect(isProcessStalled(undefined, now)).toBe(false);
  });

  it('статус обновлялся недавно — не завис', () => {
    const updatedAt = new Date(now - 60_000).toISOString();
    expect(isProcessStalled(updatedAt, now)).toBe(false);
  });

  it('статус не менялся дольше порога — завис', () => {
    const updatedAt = new Date(now - STALL_THRESHOLD_MS - 1000).toISOString();
    expect(isProcessStalled(updatedAt, now)).toBe(true);
  });

  it('ровно на пороге — ещё не завис', () => {
    const updatedAt = new Date(now - STALL_THRESHOLD_MS).toISOString();
    expect(isProcessStalled(updatedAt, now)).toBe(false);
  });
});
