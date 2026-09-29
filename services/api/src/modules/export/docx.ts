import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  Packer,
  PageNumber,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { Report, ReportSection } from './report.js';

/** DOCX протокола (редактируемая форма для инспектора) — та же структура, что и PDF. */

const FONT = 'Times New Roman';
const SIZE = 18; // 9 pt (в половинах пункта)
const TABLE_SIZE = 16;
const BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'ADB5BD' };
const BORDERS = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER, insideHorizontal: BORDER, insideVertical: BORDER };
// A4 альбомная: 16838 twip минус поля 720 + 720
const CONTENT_TWIPS = 16838 - 1440;

/** Относительные ширины колонок → twip на всю ширину страницы. */
const twipsOf = (widths: number[]) => {
  const total = widths.reduce((a, w) => a + w, 0);
  return widths.map((w) => Math.floor((w / total) * CONTENT_TWIPS));
};

/** Таблица с явной сеткой колонок: без неё LibreOffice и Quick Look сжимают столбцы до одного символа. */
function grid(twips: number[], rows: TableRow[]): Table {
  return new Table({
    width: { size: CONTENT_TWIPS, type: WidthType.DXA },
    columnWidths: twips,
    layout: TableLayoutType.FIXED,
    borders: BORDERS,
    rows,
  });
}

/** Многострочный текст ячейки: каждая строка — отдельный абзац. */
function lines(text: string, opts: { bold?: boolean; size?: number } = {}): Paragraph[] {
  return text.split('\n').map((line) => new Paragraph({ children: [new TextRun({ text: line, bold: opts.bold, size: opts.size ?? TABLE_SIZE, font: FONT })] }));
}

function cell(text: string, twips: number, header = false): TableCell {
  return new TableCell({
    width: { size: twips, type: WidthType.DXA },
    shading: header ? { type: ShadingType.CLEAR, color: 'auto', fill: 'E9ECEF' } : undefined,
    margins: { top: 40, bottom: 40, left: 60, right: 60 },
    children: lines(text, { bold: header }),
  });
}

function section(s: ReportSection): (Paragraph | Table)[] {
  const title = new Paragraph({ heading: HeadingLevel.HEADING_2, keepNext: true, spacing: { before: 240, after: 80 }, children: [new TextRun({ text: s.title, font: FONT })] });
  const italic = (text: string) => new Paragraph({ keepNext: true, children: [new TextRun({ text, italics: true, size: SIZE, font: FONT })] });
  if (s.kind === 'facts') {
    const [kw, vw] = twipsOf([30, 70]);
    return [title, grid([kw, vw], s.items.map(([k, v]) => new TableRow({ cantSplit: true, children: [cell(k, kw, true), cell(v, vw)] })))];
  }
  if (s.kind === 'list') {
    if (!s.items.length) return [title, italic(s.empty)];
    return [
      title,
      ...s.items.map((item) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: item, size: SIZE, font: FONT })] })),
    ];
  }
  const tw = twipsOf(s.columns.map((c) => c.width));
  const out: (Paragraph | Table)[] = [title];
  if (s.note) out.push(italic(s.note));
  if (!s.rows.length) return [...out, italic(s.empty)];
  out.push(
    grid(tw, [
      new TableRow({ tableHeader: true, children: s.columns.map((c, i) => cell(c.title, tw[i], true)) }),
      ...s.rows.map((r) => new TableRow({ cantSplit: true, children: r.map((v, i) => cell(v, tw[i])) })),
    ]),
  );
  return out;
}

export async function renderDocx(r: Report): Promise<Buffer> {
  const doc = new Document({
    creator: 'Инспектор ИИ',
    title: r.title,
    description: r.subtitle,
    styles: { default: { document: { run: { font: FONT, size: SIZE } } } },
    sections: [
      {
        properties: {
          page: {
            size: { orientation: PageOrientation.LANDSCAPE },
            margin: { top: 720, bottom: 720, left: 720, right: 720 },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({ text: `${r.footer} · стр. `, size: 14, color: '6C757D', font: FONT }),
                  new TextRun({ children: [PageNumber.CURRENT], size: 14, color: '6C757D', font: FONT }),
                  new TextRun({ text: ' из ', size: 14, color: '6C757D', font: FONT }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 14, color: '6C757D', font: FONT }),
                ],
              }),
            ],
          }),
        },
        children: [
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: r.title, font: FONT })] }),
          new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: r.subtitle, color: '495057', size: SIZE, font: FONT })] }),
          ...r.sections.flatMap(section),
          new Paragraph({
            spacing: { before: 480 },
            children: [
              new TextRun({ text: `Инспектор: ______________________  ${r.signature.inspector || '(ФИО)'}`, size: SIZE, font: FONT }),
              new TextRun({ text: `\tДата: ${r.signature.date}`, size: SIZE, font: FONT }),
            ],
          }),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}
