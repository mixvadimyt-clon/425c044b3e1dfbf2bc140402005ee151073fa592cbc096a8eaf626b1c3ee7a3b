import React from 'react';
import { MarkBox } from './PdfPage';
import { loadDocument, isNotPdf } from './pdfDocument';
import { FragmentCard } from './FragmentCard';
import { useHostSize } from './hostSize';
import { regionColor, homographyToCss } from '@/api/pagePairs';
import type { CompareRegion, PagePair } from '@/api/pagePairs';

/** Страница PDF на холсте: плотность с запасом, чтобы линии чертежа оставались чёткими при наложении. */
const usePdfCanvas = (fileId: string, page: number) => {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [state, setState] = React.useState({ ready: false, error: null as string | null, notPdf: false, aspect: 0.707 });

  React.useEffect(() => {
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    setState((s) => ({ ...s, ready: false, error: null, notPdf: false }));
    loadDocument(fileId)
      .then(async (doc) => {
        const pdfPage = await doc.getPage(Math.min(Math.max(page, 1), doc.numPages));
        if (cancelled || !canvasRef.current) return;
        const viewport = pdfPage.getViewport({ scale: 1.6 });
        const canvas = canvasRef.current;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        task = pdfPage.render({ canvasContext: canvas.getContext('2d')!, viewport, canvas });
        await task.promise;
        if (!cancelled) setState({ ready: true, error: null, notPdf: false, aspect: viewport.width / viewport.height });
      })
      .catch((e: unknown) => {
        if (!cancelled && isNotPdf(e)) {
          setState((s) => ({ ...s, notPdf: true }));
          return;
        }
        if (!cancelled && !(e instanceof Error && e.name === 'RenderingCancelledException')) setState((s) => ({ ...s, error: e instanceof Error ? e.message : 'Не удалось показать страницу' }));
      });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [fileId, page]);

  return { canvasRef, ...state };
};

interface Props {
  pair: PagePair;
  regions: CompareRegion[];
  /** Прозрачность правой страницы, 0–100. */
  opacity: number;
  activeKey?: string;
  /** Что даёт нажатие на область (открыть кандидата или гипотезу) и подсказка при наведении. */
  actionOf: (region: CompareRegion) => { click?: () => void; title: string };
}

/**
 * Две страницы одного листа, совмещённые: левая (эталон) как есть, правая перекрывает её через матрицу совмещения
 * (`homography`) с умножением цветов, поэтому совпадающие линии остаются чёрными, а расхождения видны двойным контуром.
 * Красные области связаны с несоответствием, жёлтые — с гипотезой.
 */
export const ComparePages: React.FC<Props> = ({ pair, regions, opacity, activeKey, actionOf }) => {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const host = useHostSize(hostRef);
  const left = usePdfCanvas(pair.left.file_id, pair.left.page);
  const right = usePdfCanvas(pair.right.file_id, pair.right.page);

  const fitW = host.w > 0 && host.h > 0 ? Math.min(host.w, host.h * left.aspect) : 0;
  const fitH = left.aspect > 0 ? fitW / left.aspect : 0;
  const error = left.error ?? right.error;

  // DOCX и XML без листов: совмещать нечего, с обеих сторон карточки фрагмента
  if (left.notPdf || right.notPdf) {
    return (
      <div className="cmp-host" style={{ display: 'flex', gap: 12, overflow: 'auto' }}>
        {[pair.left, pair.right].map((ref, i) => (
          <div key={i} style={{ flex: 1, minWidth: 0 }}>
            <FragmentCard info={{ fileId: ref.file_id, fileName: ref.document_code ?? ref.original_name }} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div ref={hostRef} className="cmp-host">
      <div className="cmp-frame" style={{ width: fitW, height: fitH }}>
        <canvas ref={left.canvasRef} className="cmp-canvas" style={{ width: '100%', height: '100%' }} />
        <canvas
          ref={right.canvasRef}
          className="cmp-canvas cmp-canvas-right"
          style={{ width: fitW, height: fitH, transform: homographyToCss(pair.homography, fitW, fitH), opacity: opacity / 100 }}
        />
        {left.ready &&
          regions.map((region) => {
            const action = actionOf(region);
            return (
              <MarkBox
                key={region.key}
                mark={{
                  bbox: region.left,
                  color: regionColor(region),
                  label: region.label,
                  dashed: region.key !== activeKey && region.kind === 'other',
                  title: action.title,
                  onClick: action.click,
                }}
              />
            );
          })}
        {(!left.ready || !right.ready) && !error && <div className="cmp-note">Загрузка страниц…</div>}
        {error && <div className="cmp-note cmp-note-error">{error}</div>}
      </div>
    </div>
  );
};
