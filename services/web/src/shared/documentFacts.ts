/** Сведения о документе, которые ML определяет при разборе (`FileInfo`, контракт 0.20.0); все необязательные. */
export interface DocumentFactsSource {
  project_code?: string | null;
  developer_org?: string | null;
  language?: 'ru' | 'en' | 'mixed' | null;
  scan_share?: number | null;
  pdf_version?: string | null;
  pdf_producer?: string | null;
  pdf_creator?: string | null;
}

export const LANGUAGE_LABEL: Record<NonNullable<DocumentFactsSource['language']>, string> = {
  ru: 'русский',
  en: 'английский',
  mixed: 'смешанный',
};

/** «43 %» из доли 0…1; за пределами диапазона и не число не показываем. */
export const scanSharePercent = (share: number | null | undefined): string | null => {
  if (typeof share !== 'number' || !Number.isFinite(share) || share < 0 || share > 1) return null;
  return `${Math.round(share * 100)} %`;
};

/** Строки «название: значение» для карточки файла, без пустых значений; после двоеточия строчная буква. */
export const documentFacts = (file: DocumentFactsSource): string[] => {
  const facts: string[] = [];
  const add = (label: string, value: string | null | undefined) => {
    const text = value?.trim();
    if (text) facts.push(`${label}: ${text}`);
  };
  add('шифр проекта', file.project_code);
  add('разработчик', file.developer_org);
  add('язык', file.language ? LANGUAGE_LABEL[file.language] : null);
  add('сканов', scanSharePercent(file.scan_share));
  add('версия', file.pdf_version);
  add('записал', file.pdf_producer);
  add('создан в', file.pdf_creator);
  return facts;
};
