import { API_URL } from '@/api/client';
import { looksLikePdf } from '@/shared/fileFormat';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;


/** Файл не PDF (DOCX или XML): страниц у него нет, показывать через pdf.js нечего. */
export class NotPdfError extends Error {
  constructor() {
    super('Файл не PDF');
    this.name = 'NotPdfError';
  }
}

export const isNotPdf = (e: unknown): boolean => e instanceof NotPdfError;

const authHeaders = (): HeadersInit | undefined => {
  const token = localStorage.getItem('auth_token');
  return token ? { Authorization: `Bearer ${token}` } : undefined;
};

/** Скачать исходный файл (`GET /files/{id}/content`) с токеном: обычная ссылка без заголовка не откроется. */
export const downloadFile = async (fileId: string, name: string): Promise<void> => {
  const response = await fetch(`${API_URL}/api/v1/files/${fileId}/content`, { headers: authHeaders() });
  if (!response.ok) throw new Error(`Файл не скачался (${response.status})`);
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

// Один PDF открываем один раз на все панели и страницы
const documents = new Map<string, Promise<PDFDocumentProxy>>();

export const loadDocument = (fileId: string): Promise<PDFDocumentProxy> => {
  let doc = documents.get(fileId);
  if (!doc) {
    doc = fetch(`${API_URL}/api/v1/files/${fileId}/content`, { headers: authHeaders() })
      .then((response) => {
        if (!response.ok) throw new Error(`Файл не открылся (${response.status})`);
        return response.arrayBuffer();
      })
      .then((data) => {
        if (!looksLikePdf(data)) throw new NotPdfError();
        return pdfjs.getDocument({ data }).promise;
      });
    doc.catch(() => documents.delete(fileId));
    documents.set(fileId, doc);
  }
  return doc;
};
