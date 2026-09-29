import React from 'react';
import { DEFAULT_ZOOM_VIEW, clampPan } from './zoomView';
import type { ZoomView } from './zoomView';

const MIN = 50;
const MAX = 400;

interface Props {
  children: React.ReactNode;
  /** Меняется — масштаб и сдвиг сбрасываются (другая пара листов, другой вид). */
  resetKey?: string;
  /** Внешнее состояние: несколько панелей с общим масштабом и сдвигом («Панели синхронны»). Без него состояние своё. */
  view?: ZoomView;
  onView?: (view: ZoomView) => void;
}

/**
 * Масштаб и сдвиг страницы: колесо мыши, кнопки «− / + / Вписать», перетаскивание.
 * Так же работают панели ПД / РД / ИД. Рамки и слой рисования внутри считают координаты по размеру на экране,
 * поэтому от масштаба не съезжают.
 */
export const ZoomStage: React.FC<Props> = ({ children, resetKey, view, onView }) => {
  const areaRef = React.useRef<HTMLDivElement>(null);
  const [own, setOwn] = React.useState<ZoomView>(DEFAULT_ZOOM_VIEW);
  const current = view ?? own;
  const currentRef = React.useRef(current);
  currentRef.current = current;
  const onViewRef = React.useRef(onView);
  onViewRef.current = onView;
  const dragRef = React.useRef<{ x: number; y: number; pan: { x: number; y: number } } | null>(null);
  const [dragging, setDragging] = React.useState(false);

  const commit = React.useCallback((next: ZoomView) => {
    currentRef.current = next;
    if (onViewRef.current) onViewRef.current(next);
    else setOwn(next);
  }, []);

  // Новый масштаб и сдвиг, подтянутый к границам панели: при уменьшении прежний сдвиг мог вывести страницу за край
  const withZoom = React.useCallback((v: ZoomView, zoom: number): ZoomView => {
    const next = Math.max(MIN, Math.min(MAX, zoom));
    const area = areaRef.current;
    return { zoom: next, pan: area ? clampPan(v.pan, next, area.offsetWidth, area.offsetHeight) : v.pan };
  }, []);

  React.useEffect(() => {
    commit(DEFAULT_ZOOM_VIEW);
  }, [resetKey, commit]);

  // Колесо: обработчик не «пассивный», иначе preventDefault даёт ошибку в консоли
  React.useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -10 : 10;
      const v = currentRef.current;
      commit(withZoom(v, v.zoom + delta));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [commit, withZoom]);

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { x: e.clientX, y: e.clientY, pan: currentRef.current.pan };
    setDragging(true);
    e.preventDefault();
  };

  // Мышь ведём по окну, а не по самой области: курсор может вылететь за её край, и сдвиг не должен обрываться
  React.useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      const start = dragRef.current;
      const area = areaRef.current;
      if (!start || !area) return;
      // Кнопку отпустили за пределами окна: сдвиг заканчиваем
      if (e.buttons === 0) {
        dragRef.current = null;
        setDragging(false);
        return;
      }
      const v = currentRef.current;
      const scale = v.zoom / 100;
      // От точки захвата, а не накоплением шагов: страница остаётся ровно под курсором
      commit({ ...v, pan: clampPan({ x: start.pan.x + (e.clientX - start.x) / scale, y: start.pan.y + (e.clientY - start.y) / scale }, v.zoom, area.offsetWidth, area.offsetHeight) });
    };
    const up = () => {
      dragRef.current = null;
      setDragging(false);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [dragging, commit]);

  const step = (delta: number) => {
    const v = currentRef.current;
    commit(withZoom(v, v.zoom + delta));
  };

  return (
    <div className="cmp-zoom">
      <div
        ref={areaRef}
        className="cmp-zoom-area"
        style={{ cursor: dragging ? 'grabbing' : 'grab' }}
        onMouseDown={onMouseDown}
      >
        <div className="cmp-zoom-inner" style={{ transform: `scale(${current.zoom / 100}) translate(${current.pan.x}px, ${current.pan.y}px)` }}>
          {children}
        </div>
      </div>
      <div className="cmp-zoom-tools">
        <button className="tool-btn" onClick={() => step(-25)} disabled={current.zoom <= MIN} title="Уменьшить (колесо мыши)">
          −
        </button>
        <span className="cmp-zoom-value">{current.zoom}%</span>
        <button className="tool-btn" onClick={() => step(25)} disabled={current.zoom >= MAX} title="Увеличить (колесо мыши)">
          +
        </button>
        <button className="tool-btn tool-btn-text" onClick={() => commit(DEFAULT_ZOOM_VIEW)} title="Вписать страницу">
          Вписать
        </button>
      </div>
    </div>
  );
};
