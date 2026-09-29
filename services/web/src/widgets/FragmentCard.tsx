import React from 'react';
import { downloadFile } from './pdfDocument';

export interface FragmentInfo {
  fileId: string;
  fileName?: string;
  /** Найденное значение (`extracted_value`). */
  value?: string;
  /** Фрагмент текста вокруг значения (`text_snippet`). */
  snippet?: string;
}

/**
 * Доказательство из DOCX или XML: у этих форматов нет листов, ML раскладывает текст по условным страницам A4,
 * поэтому вместо страницы с рамкой показываем сам фрагмент текста.
 */
export const FragmentCard: React.FC<{ info: FragmentInfo }> = ({ info }) => {
  const [error, setError] = React.useState<string | null>(null);
  return (
    <div className="fragment-card">
      <div className="fragment-card-name">{info.fileName || 'Документ'}</div>
      <div className="fragment-card-note">DOCX / XML: страница условная, в файле нет листов</div>
      {info.value && (
        <div className="fragment-card-row">
          <span className="fragment-card-key">Значение</span>
          <span className="fragment-card-value">{info.value}</span>
        </div>
      )}
      {info.snippet && (
        <div className="fragment-card-row">
          <span className="fragment-card-key">Фрагмент текста</span>
          <blockquote className="fragment-card-snippet">{info.snippet}</blockquote>
        </div>
      )}
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => {
          setError(null);
          downloadFile(info.fileId, info.fileName || 'document').catch((e: unknown) => setError(e instanceof Error ? e.message : 'Файл не скачался'));
        }}
      >
        Скачать файл
      </button>
      {error && <div className="fragment-card-error">{error}</div>}
    </div>
  );
};
