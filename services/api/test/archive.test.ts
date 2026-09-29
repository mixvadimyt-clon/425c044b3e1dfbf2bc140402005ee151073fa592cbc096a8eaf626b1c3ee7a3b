/**
 * Пределы распаковки архивов (P0 внешнего ревью 2026-09-20).
 *
 * `unzipSync` разворачивает архив в памяти целиком, а размер самого архива о распакованном объёме
 * не говорит: PDF внутри zip почти не сжимается, а архив из нулей разворачивается в тысячу раз.
 * Проверка «архив меньше гигабайта» это не ловила.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expandZip, UNZIP_LIMITS, type UnzipLimits } from '../src/modules/archive.js';
import { LocalStorage } from '../src/modules/storage.js';

const archive = { relParts: ['комплект.zip'], folderStage: null };
const text = (s: string): Uint8Array => new TextEncoder().encode(s);

let dir: string;
let storage: LocalStorage;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'inspector-zip-'));
  storage = new LocalStorage(dir);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const expand = (zip: Uint8Array, limits?: Partial<UnzipLimits>) =>
  expandZip(storage, zip, archive, false, { ...UNZIP_LIMITS, ...limits });

describe('распаковка архива комплекта', () => {
  it('обычный архив распаковывается в файлы комплекта', () => {
    const zip = zipSync({ 'ПД/пз.pdf': text('%PDF-1.7 pz'), 'РД/кж.pdf': text('%PDF-1.7 kzh') });
    const files = expand(zip);
    expect(files.map((f) => f.originalName).sort()).toEqual(['кж.pdf', 'пз.pdf']);
    expect(files.map((f) => f.relPath)).toEqual(['комплект.zip/ПД/пз.pdf', 'комплект.zip/РД/кж.pdf']);
  });

  it('путь с обратной косой (Compress-Archive из PowerShell 5.1) делится на папки, как с прямой', () => {
    const zip = zipSync({ 'Проектная документация\\ПЗ.pdf': text('%PDF-1.7 pz') });
    const [file] = expand(zip);
    expect(file).toMatchObject({ originalName: 'ПЗ.pdf', relPath: 'комплект.zip/Проектная документация/ПЗ.pdf', folderStage: 'PD' });
  });

  it('распакованный объём сверх предела отбивается целиком', () => {
    // 4 МБ нулей сжимаются в несколько килобайт: по размеру архива такое не поймать
    const zip = zipSync({ 'bomb.bin': new Uint8Array(4 * 1024 * 1024) });
    expect(() => expand(zip, { totalBytes: 1024 * 1024 })).toThrow(/распакованный объём больше/);
  });

  it('слишком большой файл внутри архива отбивается с его именем', () => {
    const zip = zipSync({ 'огромный.bin': new Uint8Array(2 * 1024 * 1024) });
    expect(() => expand(zip, { entryBytes: 1024 })).toThrow(/«огромный.bin»/);
  });

  it('слишком много файлов — архив не принимаем', () => {
    const many = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`лист-${i}.pdf`, text(`%PDF-1.7 ${i}`)]),
    );
    expect(() => expand(zipSync(many), { entries: 5 })).toThrow(/файлов в архиве больше 5/);
  });

  it('пределы по умолчанию настоящий комплект пропускают', () => {
    const zip = zipSync({ 'ПД/пз.pdf': text('%PDF-1.7 pz') });
    expect(expand(zip)).toHaveLength(1);
    expect(UNZIP_LIMITS.totalBytes).toBeGreaterThanOrEqual(1024 * 1024 * 1024);
  });
});
