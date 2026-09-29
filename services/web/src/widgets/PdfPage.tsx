import React from 'react';
import { loadDocument, isNotPdf } from './pdfDocument';
import { FragmentCard } from './FragmentCard';
import { useHostSize } from './hostSize';
import type { FragmentInfo } from './FragmentCard';

export interface PdfMark {
  /** Рамка в процентах видимой страницы. */
  bbox: { x: number; y: number; w: number; h: number };
  color: string;
  label?: string;
  /** Пунктир — фрагмент дан как контекст, а не как значение проверки. */
  dashed?: boolean;
  /** Рамка нажимается (режим сравнения листов: открыть несоответствие или гипотезу). */
  onClick?: () => void;
  title?: string;
}

/** Рамка доказательства поверх страницы. */
export const MarkBox: React.FC<{ mark: PdfMark }> = ({ mark }) => (
  <div
    className="bbox-mark"
    style={{
      left: `${mark.bbox.x}%`,
      top: `${mark.bbox.y}%`,
      width: `${mark.bbox.w}%`,
      height: `${mark.bbox.h}%`,
      border: `2.5px ${mark.dashed ? 'dashed' : 'solid'} ${mark.color}`,
      background: `${mark.color}22`,
      ...(mark.onClick ? { cursor: 'pointer', zIndex: 3 } : {}),
    }}
    onClick={mark.onClick}
    onMouseDown={mark.onClick ? (e) => e.stopPropagation() : undefined}
    title={mark.title}
  >
    {mark.label && (
      <span className="tag" style={{ background: mark.color }}>
        {mark.label}
      </span>
    )}
  </div>
);

export interface PdfBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Слой рисования рамки поверх страницы: тянем мышью, координаты в процентах видимой страницы (масштаб панели учитывается). */
export const DrawLayer: React.FC<{ onDraw: (box: PdfBox) => void }> = ({ onDraw }) => {
  const layerRef = React.useRef<HTMLDivElement>(null);
  const [drag, setDrag] = React.useState<{ sx: number; sy: number; cx: number; cy: number } | null>(null);
  const drawRef = React.useRef(onDraw);
  drawRef.current = onDraw;
  const dragRef = React.useRef(drag);
  dragRef.current = drag;

  const point = (e: { clientX: number; clientY: number }) => {
    const rect = layerRef.current!.getBoundingClientRect();
    const clamp = (v: number) => Math.min(100, Math.max(0, v));
    return { x: clamp(((e.clientX - rect.left) / rect.width) * 100), y: clamp(((e.clientY - rect.top) / rect.height) * 100) };
  };

  React.useEffect(() => {
    if (!drag) return;
    const move = (e: MouseEvent) => {
      const p = point(e);
      setDrag((d) => (d ? { ...d, cx: p.x, cy: p.y } : d));
    };
    const up = (e: MouseEvent) => {
      const d = dragRef.current;
      const p = point(e);
      setDrag(null);
      if (!d) return;
      const box = { x: Math.min(d.sx, p.x), y: Math.min(d.sy, p.y), w: Math.abs(p.x - d.sx), h: Math.abs(p.y - d.sy) };
      // Случайный клик без протяжки рамкой не считается
      if (box.w >= 0.8 && box.h >= 0.8) drawRef.current(box);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [drag !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const box = drag ? { x: Math.min(drag.sx, drag.cx), y: Math.min(drag.sy, drag.cy), w: Math.abs(drag.cx - drag.sx), h: Math.abs(drag.cy - drag.sy) } : null;

  return (
    <div
      ref={layerRef}
      className="draw-layer"
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        // Перетаскивание страницы в панели не должно начинаться
        e.stopPropagation();
        e.preventDefault();
        const p = point(e);
        setDrag({ sx: p.x, sy: p.y, cx: p.x, cy: p.y });
      }}
    >
      {box && <div className="draw-rubber" style={{ left: `${box.x}%`, top: `${box.y}%`, width: `${box.w}%`, height: `${box.h}%` }} />}
    </div>
  );
};

interface PdfPageProps {
  fileId: string;
  page: number;
  marks: PdfMark[];
  /** Режим правки доказательств: страницу можно обвести рамкой. */
  onDraw?: (box: PdfBox) => void;
  /** Сообщает число страниц файла, когда документ открыт. */
  onPageCount?: (count: number) => void;
  /** Что показать, если файл не PDF (DOCX или XML): карточка фрагмента вместо страницы. */
  fragment?: Omit<FragmentInfo, 'fileId'>;
}

/** Страница PDF из api: холст pdf.js и рамка доказательства поверх него. Рамка в долях страницы, поэтому не съезжает при масштабе и повороте. */
export const PdfPage: React.FC<PdfPageProps> = ({ fileId, page, marks, onDraw, onPageCount, fragment }) => {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notPdf, setNotPdf] = React.useState(false);
  const [ready, setReady] = React.useState(false);
  const [aspect, setAspect] = React.useState(0.707);
  const countRef = React.useRef(onPageCount);
  countRef.current = onPageCount;

  // Страница вписывается в свободное место панели с сохранением пропорций (размер округляется вниз: см. hostSize.ts)
  const host = useHostSize(hostRef);

  React.useEffect(() => {
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null;
    setError(null);
    setNotPdf(false);
    setReady(false);

    loadDocument(fileId)
      .then(async (doc) => {
        countRef.current?.(doc.numPages);
        const pdfPage = await doc.getPage(Math.min(Math.max(page, 1), doc.numPages));
        if (cancelled || !canvasRef.current) return;
        // Рисуем с запасом по плотности, чтобы текст оставался чётким при увеличении
        const viewport = pdfPage.getViewport({ scale: 1.6 });
        setAspect(viewport.width / viewport.height);
        const canvas = canvasRef.current;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        renderTask = pdfPage.render({ canvasContext: canvas.getContext('2d')!, viewport, canvas });
        await renderTask.promise;
        if (!cancelled) setReady(true);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (isNotPdf(e)) {
          setNotPdf(true);
          return;
        }
        if (!(e instanceof Error && e.name === 'RenderingCancelledException')) setError(e instanceof Error ? e.message : 'Не удалось показать страницу');
      });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [fileId, page]);

  const fitW = host.w > 0 && host.h > 0 ? Math.min(host.w, host.h * aspect) : 0;
  const fitH = aspect > 0 ? fitW / aspect : 0;

  if (notPdf) {
    return (
      <div ref={hostRef} style={{ width: '100%', height: '100%', overflow: 'auto' }}>
        <FragmentCard info={{ fileId, ...fragment }} />
      </div>
    );
  }

  return (
    <div ref={hostRef} style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 0 }}>
      <div style={{ position: 'relative', width: fitW, height: fitH }}>
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block', background: '#fff', boxShadow: '0 1px 6px rgba(0,0,0,.18)' }} />
        {ready && marks.map((mark, i) => <MarkBox key={i} mark={mark} />)}
        {ready && onDraw && <DrawLayer onDraw={onDraw} />}
        {!ready && !error && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#667085' }}>Загрузка страницы…</div>}
        {error && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#991B1B', padding: 12, textAlign: 'center' }}>{error}</div>}
      </div>
    </div>
  );
};
