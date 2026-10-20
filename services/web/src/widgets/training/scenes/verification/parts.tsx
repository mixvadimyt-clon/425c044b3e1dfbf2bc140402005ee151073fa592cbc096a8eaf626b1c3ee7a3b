import React from 'react';
import { theme } from 'antd';
import { DrawLayer } from '@/widgets/PdfPage';
import type { PdfBox } from '@/widgets/PdfPage';
import type { TrainerDoc } from '@/shared/trainer';

/** Страница настоящего документа комплекта. Рамка в процентах страницы, поэтому лист показывается в своих пропорциях. */
export const PageImage: React.FC<{ doc: TrainerDoc; zoom: number; onDraw?: (box: PdfBox) => void; children: React.ReactNode }> = ({ doc, zoom, onDraw, children }) => {
  const stageRef = React.useRef<HTMLDivElement>(null);
  // Показываем ту часть страницы, где лежит значение
  React.useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const inner = stage.firstElementChild as HTMLElement | null;
    if (!inner) return;
    stage.scrollTop = Math.max(0, ((doc.mark.y + doc.mark.h / 2) / 100) * inner.offsetHeight - stage.clientHeight / 2);
    stage.scrollLeft = Math.max(0, ((doc.mark.x + doc.mark.w / 2) / 100) * inner.offsetWidth - stage.clientWidth / 2);
  }, [doc, zoom]);
  return (
    <div ref={stageRef} style={{ position: 'absolute', inset: 0, overflow: 'auto' }}>
      <div style={{ position: 'relative', width: `${zoom * 100}%`, aspectRatio: '595 / 842' }}>
        <img src={`/training-docs/${doc.image}.jpg`} alt={doc.name} draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
        {children}
        {onDraw && <DrawLayer onDraw={onDraw} />}
      </div>
    </div>
  );
};

/**
 * Плавающая панель полного экрана, как в настоящей верификации: лежит поверх документов, её можно перетаскивать за
 * заголовок. Пока её не двигали, она стоит под подсказкой урока и не закрывает её.
 */
/** Сколько панели обязательно остаётся на экране у края (как в настоящей верификации). */
const PANEL_VISIBLE = 60;

export const FloatingPanel: React.FC<{
  title: string;
  side: 'left' | 'right';
  width: number;
  /** Высота по умолчанию, как у настоящей панели. */
  height: number;
  tt: string;
  className?: string;
  children: React.ReactNode;
}> = ({ title, side, width, height, tt, className, children }) => {
  const { token } = theme.useToken();
  const [pos, setPos] = React.useState<{ x: number; y: number } | null>(null);
  const [autoTop, setAutoTop] = React.useState(150);
  const drag = React.useRef<{ dx: number; dy: number } | null>(null);
  // Размер можно менять за края, как у настоящих панелей: у высоты 0 — по умолчанию
  const [size, setSize] = React.useState({ w: width, h: 0 });
  const panelRef = React.useRef<HTMLDivElement>(null);

  // Подсказка урока меняет высоту от шага к шагу: нетронутая панель идёт за ней
  // Без списка зависимостей намеренно: высота подсказки меняется вместе с шагом, а состояние обновляется только при изменении
  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useLayoutEffect(() => {
    const coach = document.querySelector('.training-coach-dock');
    const bottom = coach ? coach.getBoundingClientRect().bottom + 8 : 150;
    setAutoTop((prev) => (Math.abs(prev - bottom) < 1 ? prev : bottom));
  });

  const left = pos ? pos.x : side === 'left' ? 20 : Math.max(20, window.innerWidth - size.w - 20);
  const top = pos ? pos.y : autoTop;

  // Тянем за край: у правой панели ширину меняет левый край (сама панель при этом остаётся у правого края экрана)
  const beginResize = (e: React.PointerEvent, mode: 'side' | 'bottom' | 'corner') => {
    e.preventDefault();
    e.stopPropagation();
    const box = panelRef.current?.getBoundingClientRect();
    if (!box) return;
    const start = { x: e.clientX, y: e.clientY, w: box.width, h: box.height, left: box.left };
    const sign = side === 'left' ? 1 : -1;
    const onMove = (ev: PointerEvent) => {
      const w = Math.max(240, Math.min(window.innerWidth - 60, start.w + sign * (ev.clientX - start.x)));
      const h = Math.max(220, Math.min(window.innerHeight - 100, start.h + (ev.clientY - start.y)));
      setSize((prev) => ({ w: mode === 'bottom' ? prev.w : w, h: mode === 'side' ? prev.h : h }));
      // Правая панель растёт влево: если её уже двигали, держим её правый край на месте
      if (side === 'right' && mode !== 'bottom') setPos((prev) => (prev ? { x: Math.max(0, start.left + start.w - w), y: prev.y } : prev));
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  return (
    <div
      ref={panelRef}
      data-tt={tt}
      className={className}
      style={{
        position: 'fixed',
        left,
        top,
        width: size.w,
        zIndex: 1100,
        background: token.colorBgContainer,
        border: `1px solid ${token.colorBorder}`,
        borderRadius: 12,
        boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        // Пока панель не двигали, она умещается под подсказкой; после перемещения высота постоянная, как у настоящей панели
        height: size.h ? size.h : pos ? `min(${height}px, calc(100vh - 104px))` : `min(${height}px, calc(100vh - ${Math.round(top)}px - 20px))`,
      }}
    >
      <div className={`training-resize training-resize-side training-resize-${side === 'left' ? 'right' : 'left'}`} title="Потяните, чтобы изменить ширину" onPointerDown={(e) => beginResize(e, 'side')} />
      <div className="training-resize training-resize-bottom" title="Потяните, чтобы изменить высоту" onPointerDown={(e) => beginResize(e, 'bottom')} />
      <div className={`training-resize training-resize-corner training-resize-corner-${side === 'left' ? 'right' : 'left'}`} title="Потяните, чтобы изменить размер" onPointerDown={(e) => beginResize(e, 'corner')} />
      <div
        title="Перетащите, чтобы переместить панель"
        style={{
          padding: '12px 16px',
          borderBottom: `1px solid ${token.colorBorder}`,
          fontWeight: 600,
          fontSize: 14,
          cursor: 'move',
          userSelect: 'none',
          display: 'flex',
          justifyContent: 'space-between',
          touchAction: 'none',
        }}
        onPointerDown={(e) => {
          drag.current = { dx: e.clientX - left, dy: e.clientY - top };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          // Как у настоящих панелей: за левый и правый край можно вынести, но полоса в 60 пикселей и заголовок остаются на экране
          setPos({
            x: Math.min(Math.max(PANEL_VISIBLE - size.w, e.clientX - drag.current.dx), window.innerWidth - PANEL_VISIBLE),
            y: Math.min(Math.max(0, e.clientY - drag.current.dy), window.innerHeight - 48),
          });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
      >
        <span>{title}</span>
        <span style={{ fontWeight: 400, fontSize: 12, color: token.colorTextSecondary }}>⠿ можно перетащить</span>
      </div>
      {children}
    </div>
  );
};
