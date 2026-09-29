import { describe, expect, it } from 'vitest';
import { SIGNATURE_MAX_BYTES, formatFileSize, validateSignatureFile } from './signature';

describe('validateSignatureFile', () => {
  it('принимает .sig, .p7s и .sgn независимо от регистра', () => {
    for (const name of ['act.sig', 'act.P7S', 'act.pdf.sgn']) {
      expect(validateSignatureFile({ name, size: 1200 })).toBeNull();
    }
  });

  it('отклоняет другие расширения', () => {
    expect(validateSignatureFile({ name: 'act.pdf', size: 1200 })).toContain('.sig, .p7s, .sgn');
    expect(validateSignatureFile({ name: 'sig', size: 1200 })).not.toBeNull();
  });

  it('отклоняет файл больше 256 КБ и пустой файл', () => {
    expect(validateSignatureFile({ name: 'a.sig', size: SIGNATURE_MAX_BYTES })).toBeNull();
    expect(validateSignatureFile({ name: 'a.sig', size: SIGNATURE_MAX_BYTES + 1 })).toContain('256 КБ');
    expect(validateSignatureFile({ name: 'a.sig', size: 0 })).toContain('пустой');
  });
});

describe('formatFileSize', () => {
  it('байты и килобайты с запятой', () => {
    expect(formatFileSize(312)).toBe('312 Б');
    expect(formatFileSize(2150)).toBe('2,1 КБ');
  });
});
