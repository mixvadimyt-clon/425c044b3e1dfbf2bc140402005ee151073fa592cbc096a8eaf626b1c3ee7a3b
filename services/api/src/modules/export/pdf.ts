import { createRequire } from 'node:module';
import path from 'node:path';
import pdfmake from 'pdfmake';
import type { Content, TableCell } from 'pdfmake';
import type { Report, ReportSection } from './report.js';

/** PDF протокола: pdfmake + DejaVu Sans (кириллица, свободная лицензия, пакет dejavu-fonts-ttf). */

const FONT_DIR = path.join(path.dirname(createRequire(import.meta.url).resolve('dejavu-fonts-ttf/package.json')), 'ttf');
pdfmake.setFonts({
  DejaVu: {
    normal: path.join(FONT_DIR, 'DejaVuSans.ttf'),
    bold: path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'),
    italics: path.join(FONT_DIR, 'DejaVuSans-Oblique.ttf'),
    bolditalics: path.join(FONT_DIR, 'DejaVuSans-BoldOblique.ttf'),
  },
});
// в документ попадают только наши шрифты — ни сети, ни прочих файлов
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((p: string) => path.resolve(p).startsWith(FONT_DIR + path.sep));

type TDocumentDefinitions = Parameters<typeof pdfmake.createPdf>[0];

const GRAY = '#e9ecef';

function section(s: ReportSection): Content[] {
  const title: Content = { text: s.title, style: 'h2' };
  if (s.kind === 'facts') {
    return [
      title,
      {
        table: {
          widths: [180, '*'],
          body: s.items.map(([k, v]): TableCell[] => [{ text: k, bold: true }, { text: v }]),
        },
        layout: 'lightHorizontalLines',
      },
    ];
  }
  if (s.kind === 'list') {
    return [title, s.items.length ? { ul: s.items } : { text: s.empty, italics: true }];
  }
  if (!s.rows.length) {
    return [title, ...(s.note ? [{ text: s.note, style: 'note' } as Content] : []), { text: s.empty, italics: true }];
  }
  const total = s.columns.reduce((a, c) => a + c.width, 0);
  const n = s.columns.length;
  // заголовок раздела — первая строка шапки: не отрывается от таблицы и повторяется на каждой странице
  const caption: TableCell[] = [
    {
      colSpan: n,
      border: [false, false, false, false],
      stack: [{ text: s.title, style: 'h2', margin: [-4, 8, 0, 2] }, ...(s.note ? [{ text: s.note, style: 'note', margin: [-4, 0, 0, 2] } as Content] : [])],
    },
    ...Array.from({ length: n - 1 }, (): TableCell => ({ text: '' })),
  ];
  return [
    {
      table: {
        headerRows: 2,
        keepWithHeaderRows: 1,
        dontBreakRows: true,
        widths: s.columns.map((c) => `${((c.width / total) * 100).toFixed(2)}%`),
        body: [
          caption,
          s.columns.map((c): TableCell => ({ text: c.title, bold: true, fillColor: GRAY })),
          ...s.rows.map((r) => r.map((v): TableCell => ({ text: v }))),
        ],
      },
      layout: {
        hLineWidth: (i: number) => (i === 0 ? 0 : 0.5),
        vLineWidth: () => 0.5,
        hLineColor: () => '#adb5bd',
        vLineColor: () => '#adb5bd',
      },
      style: 'table',
    },
  ];
}

export function reportDefinition(r: Report): TDocumentDefinitions {
  return {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [36, 36, 36, 40],
    info: { title: r.title, subject: r.subtitle, creator: 'Инспектор ИИ' },
    defaultStyle: { font: 'DejaVu', fontSize: 8, lineHeight: 1.15 },
    styles: {
      h1: { fontSize: 14, bold: true, margin: [0, 0, 0, 4] },
      sub: { fontSize: 9, color: '#495057', margin: [0, 0, 0, 10] },
      h2: { fontSize: 11, bold: true, margin: [0, 12, 0, 4] },
      note: { fontSize: 7.5, italics: true, color: '#495057', margin: [0, 0, 0, 4] },
      table: { fontSize: 7 },
    },
    content: [
      { text: r.title, style: 'h1' },
      { text: r.subtitle, style: 'sub' },
      ...r.sections.flatMap(section),
      {
        margin: [0, 24, 0, 0],
        unbreakable: true,
        columns: [
          { width: '*', text: `Инспектор: ______________________  ${r.signature.inspector || '(ФИО)'}` },
          { width: 'auto', text: `Дата: ${r.signature.date}` },
        ],
      },
    ],
    footer: (page: number, pages: number): Content => ({
      margin: [36, 10, 36, 0],
      columns: [
        { text: r.footer, fontSize: 7, color: '#6c757d' },
        { text: `стр. ${page} из ${pages}`, alignment: 'right', fontSize: 7, color: '#6c757d', width: 'auto' },
      ],
    }),
  };
}

export async function renderPdf(r: Report): Promise<Buffer> {
  return pdfmake.createPdf(reportDefinition(r)).getBuffer();
}
