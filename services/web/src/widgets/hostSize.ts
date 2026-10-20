import React from 'react';

export interface HostSize {
  w: number;
  h: number;
}

/**
 * Размер контейнера в CSS-пикселях, округлённый вниз. Раньше брали `clientWidth`/`clientHeight`: они округляют до ближайшего целого,
 * и на дробных размерах (масштаб Windows 125 %) страница, вписанная по округлённому размеру, выходила за край панели на долю пикселя.
 * При масштабе 100 % (без `scale()`) браузер тут же показывал полосу прокрутки, панель сужалась на её ширину, страница пересчитывалась,
 * полоса пропадала, и всё повторялось: страница «дребезжала». Размер из ResizeObserver дробный и не зависит от `transform` предков.
 */
export const layoutSize = (el: HTMLElement, entry?: ResizeObserverEntry): HostSize => {
  const box = entry?.contentBoxSize?.[0];
  return box ? { w: Math.floor(box.inlineSize), h: Math.floor(box.blockSize) } : { w: el.clientWidth, h: el.clientHeight };
};

/** Следит за размером элемента, вписанная в него страница подгоняется под него; одинаковый размер повторно не записывается. */
export const useHostSize = (hostRef: React.RefObject<HTMLElement | null>): HostSize => {
  const [host, setHost] = React.useState<HostSize>({ w: 0, h: 0 });
  React.useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const apply = (next: HostSize) => setHost((prev) => (prev.w === next.w && prev.h === next.h ? prev : next));
    const observer = new ResizeObserver((entries) => apply(layoutSize(el, entries[entries.length - 1])));
    observer.observe(el);
    apply(layoutSize(el));
    return () => observer.disconnect();
  }, [hostRef]);
  return host;
};
