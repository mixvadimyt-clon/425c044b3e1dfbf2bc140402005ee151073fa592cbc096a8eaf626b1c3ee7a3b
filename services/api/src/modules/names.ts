/**
 * Восстановление имён файлов, испорченных при распаковке Windows-архива на macOS:
 * байты CP866 были прочитаны как Mac Cyrillic («ПаЃ•™в≠†п» → «Проектная»).
 * Применяется только к именам с характерными «битыми» символами, нормальные имена не трогаем.
 */
const SUSPICIOUS = /[ЃѓЂђ•™≠†§®Ґґ∞±≤≥µ∂∑∏π∫ªºΩ¬√ƒ≈∆«»…ЌќЋћЏџ]/u;
const LEGIT = /[«»…]/gu;

let macMap: Map<string, number> | null = null;
const dos = new TextDecoder('ibm866');

function mac(): Map<string, number> {
  if (!macMap) {
    const decoder = new TextDecoder('x-mac-cyrillic');
    macMap = new Map();
    for (let b = 0; b < 256; b++) {
      const ch = decoder.decode(Uint8Array.of(b));
      if (!macMap.has(ch)) macMap.set(ch, b);
    }
  }
  return macMap;
}

export function fixMojibakeName(name: string): string {
  const nfc = name.normalize('NFC');
  // «ёлочки» и многоточие встречаются в нормальных именах — сами по себе не признак порчи
  if (!SUSPICIOUS.test(nfc.replace(LEGIT, ''))) return nfc;
  const map = mac();
  const bytes: number[] = [];
  for (const ch of nfc) {
    const b = map.get(ch);
    if (b === undefined) return nfc;
    bytes.push(b);
  }
  const fixed = dos.decode(Uint8Array.from(bytes));
  // Результат должен быть «нормальнее» исходника: без подозрительных символов
  return SUSPICIOUS.test(fixed.replace(LEGIT, '')) ? nfc : fixed.normalize('NFC');
}

/**
 * Стадия по имени папки комплекта.
 *
 * Сначала слова целиком («Проектная документация»), затем сокращения — папки сплошь называют
 * «ПД», «РД», «ИД», в том числе с номером вроде «03_ИД». Сокращение ищем только как **всю**
 * папку после отбрасывания небуквенных символов: подстрокой «ид» нашлось бы в «Сведения»,
 * а «пд» — в «ЖС-РД-270121-П-ПД-3». Латинские двойники кириллических букв приводим к русским:
 * в именах из разных систем «РД» встречается и с латинской «P».
 */
const ABBREVIATION: Record<string, 'PD' | 'RD' | 'ID'> = { пд: 'PD', рд: 'RD', ид: 'ID' };
const LATIN_LOOKALIKE: Record<string, string> = { p: 'р', c: 'с', a: 'а', e: 'е', o: 'о', x: 'х' };

export function stageFromFolder(folder: string): 'PD' | 'RD' | 'ID' | null {
  const f = folder.toLowerCase();
  if (f.includes('проектн')) return 'PD';
  if (f.includes('рабоч')) return 'RD';
  if (f.includes('исполнит')) return 'ID';
  const letters = [...f.replace(/[^\p{L}]/gu, '')].map((ch) => LATIN_LOOKALIKE[ch] ?? ch).join('');
  return ABBREVIATION[letters] ?? null;
}
