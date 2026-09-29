import { describe, expect, it } from 'vitest';
import { looksLikePdf } from './fileFormat';

const bytes = (text: string | number[]): ArrayBuffer => {
  const arr = typeof text === 'string' ? new TextEncoder().encode(text) : new Uint8Array(text);
  return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength) as ArrayBuffer;
};

describe('looksLikePdf', () => {
  it('узнаёт PDF по сигнатуре, в том числе с коротким мусором перед ней', () => {
    expect(looksLikePdf(bytes('%PDF-1.7\n%âãÏÓ'))).toBe(true);
    expect(looksLikePdf(bytes('\r\n%PDF-1.4'))).toBe(true);
  });

  it('DOCX (zip) и XML не считает PDF', () => {
    expect(looksLikePdf(bytes([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]))).toBe(false);
    expect(looksLikePdf(bytes('<?xml version="1.0" encoding="UTF-8"?><Doc/>'))).toBe(false);
  });

  it('пустой файл не PDF', () => {
    expect(looksLikePdf(new ArrayBuffer(0))).toBe(false);
  });
});
