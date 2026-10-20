import { describe, expect, it } from 'vitest';
import { fixMojibakeName, stageFromFolder } from '../src/modules/names.js';

// Строки как в распакованном датасете: CP866-байты, прочитанные как Mac Cyrillic
const broken = (s: string) => {
  const bytes = Buffer.from(new TextEncoder().encode('')); // заглушка для типов
  void bytes;
  const cp866 = new Map<string, number>();
  const dos = new TextDecoder('ibm866');
  for (let b = 0; b < 256; b++) cp866.set(dos.decode(Uint8Array.of(b)), b);
  const mac = new TextDecoder('x-mac-cyrillic');
  return mac.decode(Uint8Array.from([...s].map((ch) => cp866.get(ch)!)));
};

describe('fixMojibakeName', () => {
  it('восстанавливает имена датасета', () => {
    for (const name of ['Проектная документация', 'Алтуфьевское, 79Б', '1. П-2025-04.266-ПЗ.pdf', '2. П-2025-04-266-СПОЗУ (Изм.1).pdf']) {
      expect(fixMojibakeName(broken(name))).toBe(name);
    }
    expect(fixMojibakeName('ПаЃ•™в≠†п §Ѓ™гђ•≠в†ж®п')).toBe('Проектная документация');
  });
  it('не трогает нормальные имена', () => {
    for (const name of ['Проект.pdf', 'README.pdf', 'Акт «скрытых работ» №5.pdf', 'КЖ01 11.11.2025.pdf']) {
      expect(fixMojibakeName(name)).toBe(name);
    }
  });
  it('стадия по папке', () => {
    expect(stageFromFolder('Проектная документация')).toBe('PD');
    expect(stageFromFolder('Рабочая документация')).toBe('RD');
    expect(stageFromFolder('Исполнительная документация')).toBe('ID');
    expect(stageFromFolder('Прочее')).toBeNull();
  });
  it('стадия по сокращению — так папки называют чаще всего', () => {
    expect(stageFromFolder('ИД')).toBe('ID');
    expect(stageFromFolder('пд')).toBe('PD');
    expect(stageFromFolder('03_РД')).toBe('RD');
    expect(stageFromFolder('2. ИД')).toBe('ID');
    expect(stageFromFolder('PД')).toBe('RD'); // латинская «P» вместо русской «Р»
  });
  it('сокращение — только целое имя папки, иначе ложные срабатывания', () => {
    // «ид» подстрокой есть в «Сведения», «пд» — в шифре документа
    expect(stageFromFolder('Сведения')).toBeNull();
    expect(stageFromFolder('ЖС-РД-270121-П-ПД-3')).toBeNull();
    expect(stageFromFolder('Идентификация')).toBeNull();
    expect(stageFromFolder('')).toBeNull();
  });
});
