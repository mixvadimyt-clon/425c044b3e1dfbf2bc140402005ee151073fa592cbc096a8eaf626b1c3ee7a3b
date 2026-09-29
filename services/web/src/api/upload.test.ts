import { describe, expect, it } from 'vitest';
import { ALLOWED_REGISTRY_EXTENSIONS, MAX_FILE_MB, UploadFailedError, batchTooLarge, registryErrorsOf, validateFile } from './upload';

const fileOf = (name: string, size = 10) => new File([new Uint8Array(size)], name);

describe('validateFile', () => {
  it('принимает PDF, DOCX и XML', () => {
    expect(validateFile(fileOf('КР.pdf'))).toBeNull();
    expect(validateFile(fileOf('Записка.DOCX'))).toBeNull();
    expect(validateFile(fileOf('данные.xml'))).toBeNull();
  });

  it('отклоняет другие форматы и слишком большие файлы', () => {
    expect(validateFile(fileOf('архив.zip'))).toBeNull();
    expect(validateFile(fileOf('архив.zip', 100 * 1024 * 1024))).toBeNull();
    expect(validateFile(fileOf('архив.zip', 201 * 1024 * 1024))).toMatch(/больше 200/);
    expect(validateFile(fileOf('картинка.png'))).toMatch(/допустимы/);
    expect(validateFile(fileOf('большой.pdf', MAX_FILE_MB * 1024 * 1024 + 1))).toMatch(/больше/);
  });

  it('реестр — CSV, XLSX или JSON', () => {
    expect(validateFile(fileOf('реестр.csv'), ALLOWED_REGISTRY_EXTENSIONS)).toBeNull();
    expect(validateFile(fileOf('реестр.pdf'), ALLOWED_REGISTRY_EXTENSIONS)).not.toBeNull();
  });
});

describe('batchTooLarge', () => {
  it('порог пакета — 200 МБ', () => {
    const big = { size: 150 * 1024 * 1024 } as File;
    expect(batchTooLarge([big])).toBe(false);
    expect(batchTooLarge([big, big])).toBe(true);
  });
});

describe('registryErrorsOf', () => {
  it('достаёт строки ошибок реестра с номерами строк', () => {
    const error = new UploadFailedError('Реестр содержит ошибки', 400, 'REGISTRY_INVALID', { errors: ['строка 2: неизвестная стадия «ZZ»', 'строка 3: пустое имя'] });
    expect(registryErrorsOf(error)).toEqual(['строка 2: неизвестная стадия «ZZ»', 'строка 3: пустое имя']);
  });

  it('другие ошибки и не ошибки загрузки дают пустой список', () => {
    expect(registryErrorsOf(new UploadFailedError('Файл слишком большой', 413, 'BATCH_TOO_LARGE'))).toEqual([]);
    expect(registryErrorsOf(new Error('сеть'))).toEqual([]);
  });
});
