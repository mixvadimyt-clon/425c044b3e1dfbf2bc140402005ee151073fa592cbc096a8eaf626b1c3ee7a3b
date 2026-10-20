import React from 'react';
import { Select } from 'antd';
import { MarkBox } from '@/widgets/PdfPage';
import type { PdfMark } from '@/widgets/PdfPage';
import { ZoomStage } from '@/widgets/ZoomStage';
import { useHostSize } from '@/widgets/hostSize';
import type { TrainerCandidate, TrainerHypothesis } from '@/shared/trainer';
import { STAGE_COLORS } from './consts';
import '@/widgets/Compare.css';

/** Цвета областей, как в настоящем режиме: красный — кандидат, оранжевый — гипотеза. */
const REGION_FINDING = '#C0392B';
const REGION_SUSPICION = '#D97706';
const ASPECT = 595 / 842;

interface Sheet {
  stage: 'ПД' | 'РД';
  code: string;
  image: string;
  page: number;
}

interface Pair {
  id: string;
  left: Sheet;
  right: Sheet;
  /** Насколько листы совпадают (учебное значение: в настоящей проверке его считает система). */
  match: number;
}

/** Пары листов учебного комплекта: те же страницы, что показаны в панелях. */
const PAIRS: Pair[] = [
  { id: 'kr', left: { stage: 'ПД', code: '2026-СК2-П-КР', image: 'pd-kr-2', page: 2 }, right: { stage: 'РД', code: '2026-СК2-РД-КЖ', image: 'rd-kzh-1', page: 1 }, match: 74 },
  { id: 'pz', left: { stage: 'ПД', code: '2026-СК2-П-ПЗ', image: 'pd-pz-2', page: 2 }, right: { stage: 'РД', code: '2026-СК2-РД-АР', image: 'rd-ar-1', page: 1 }, match: 81 },
];

interface Region {
  key: string;
  label: string;
  kind: 'finding' | 'suspicion';
  left: { x: number; y: number; w: number; h: number };
  right: { x: number; y: number; w: number; h: number };
  candidateId?: string;
  hypothesisId?: string;
}

const StageChip: React.FC<{ stage: 'ПД' | 'РД' }> = ({ stage }) => (
  <span className="cmp-stage" style={{ background: STAGE_COLORS[stage] }}>
    {stage}
  </span>
);

const sheetText = (s: Sheet) => `${s.code}, ${s.page > 1 ? `стр. ${s.page}` : 'л. 1'}`;

/** Лист по размеру области: наложение двух страниц или одна страница с рамками. */
const FitFrame: React.FC<{ images: Array<{ image: string; opacity?: number; blend?: boolean }>; marks: PdfMark[] }> = ({ images, marks }) => {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const host = useHostSize(hostRef);
  const fitW = host.w > 0 && host.h > 0 ? Math.min(host.w, host.h * ASPECT) : 0;
  const fitH = fitW / ASPECT;
  return (
    <div ref={hostRef} className="cmp-host">
      <div className="cmp-frame" style={{ width: fitW, height: fitH }}>
        {images.map((img, i) => (
          <img
            key={`${img.image}-${i}`}
            src={`/training-docs/${img.image}.jpg`}
            alt=""
            draggable={false}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              opacity: img.opacity ?? 1,
              mixBlendMode: img.blend ? 'multiply' : undefined,
              pointerEvents: 'none',
            }}
          />
        ))}
        {marks.map((m, i) => (
          <MarkBox key={i} mark={m} />
        ))}
      </div>
    </div>
  );
};

interface Props {
  candidates: TrainerCandidate[];
  hypotheses: TrainerHypothesis[];
  currentId?: string;
  selectedHypothesisId?: string;
  onSelectCandidate: (id: string) => void;
  onSelectHypothesis: (id: string) => void;
  /** Подсветка шага урока. */
  hl: (target: string) => string;
  /** Переключатель режима и «Во весь экран» стоят в одной строке с остальным управлением, как в настоящей. */
  leading: React.ReactNode;
  trailing: React.ReactNode;
}

/**
 * «Сравнение листов»: пара листов разных стадий, наложение (вторая страница поверх первой, что совпадает, остаётся
 * чёрным) или две страницы рядом, ползунок прозрачности, области различий. Красные области связаны с кандидатом, оранжевые
 * с гипотезой; нажатие на область открывает её карточку.
 */
export const CompareSheets: React.FC<Props> = ({ candidates, hypotheses, currentId, selectedHypothesisId, onSelectCandidate, onSelectHypothesis, hl, leading, trailing }) => {
  const [pairId, setPairId] = React.useState(PAIRS[0].id);
  const [view, setView] = React.useState<'overlay' | 'side'>('overlay');
  const [opacity, setOpacity] = React.useState(55);
  const [showMarks, setShowMarks] = React.useState(true);

  // Открывается пара текущего кандидата, иначе первая
  React.useEffect(() => {
    const current = candidates.find((c) => c.id === currentId);
    const target = PAIRS.find((p) => current?.docs.ПД?.image === p.left.image && current?.docs.РД?.image === p.right.image);
    if (target) setPairId(target.id);
  }, [currentId, candidates]);

  const pair = PAIRS.find((p) => p.id === pairId) ?? PAIRS[0];

  const regions: Region[] = [
    ...candidates.flatMap((c) =>
      c.docs.ПД?.image === pair.left.image && c.docs.РД?.image === pair.right.image
        ? [{ key: c.id, label: c.code, kind: 'finding' as const, left: c.docs.ПД.mark, right: c.docs.РД.mark, candidateId: c.id }]
        : [],
    ),
    ...hypotheses.flatMap((h) => {
      const l = h.evidence.find((e) => e.doc.image === pair.left.image);
      const r = h.evidence.find((e) => e.doc.image === pair.right.image);
      return l && r ? [{ key: h.id, label: 'гипотеза', kind: 'suspicion' as const, left: l.doc.mark, right: r.doc.mark, hypothesisId: h.id }] : [];
    }),
  ];

  const markOf = (r: Region, side: 'left' | 'right'): PdfMark => {
    const active = r.candidateId ? r.candidateId === currentId && !selectedHypothesisId : r.hypothesisId === selectedHypothesisId;
    const color = r.kind === 'finding' ? REGION_FINDING : REGION_SUSPICION;
    const click = active ? undefined : r.candidateId ? () => onSelectCandidate(r.candidateId!) : () => onSelectHypothesis(r.hypothesisId!);
    return {
      bbox: r[side],
      color,
      label: r.label,
      title: active ? `${r.label}: эта запись уже открыта` : r.kind === 'finding' ? `${r.label}: открыть кандидата` : 'Гипотеза: открыть',
      onClick: click,
    };
  };

  const viewSwitch = (
    <div className="cmp-seg" role="group" aria-label="Вид">
      <button className={view === 'overlay' ? 'is-on' : ''} onClick={() => setView('overlay')} title="Обе страницы друг на друге">
        Наложение
      </button>
      <button className={view === 'side' ? 'is-on' : ''} onClick={() => setView('side')} title="Две страницы рядом">
        Рядом
      </button>
    </div>
  );
  const marksToggle = (
    <button className="btn btn-ghost sync-toggle-btn" onClick={() => setShowMarks((v) => !v)} title="Скрыть или показать области различий поверх документа">
      {showMarks ? '▢ Скрыть рамки' : '▢ Показать рамки'}
    </button>
  );
  const pairLabel = (p: Pair) => (
    <span className="cmp-pair-label">
      <StageChip stage={p.left.stage} /> {sheetText(p.left)} <span className="cmp-arrow">↔</span> <StageChip stage={p.right.stage} /> {sheetText(p.right)}
      <span className="cmp-pair-score">, совпадение {p.match} %</span>
    </span>
  );

  return (
    <div className="cmp-container">
      <div className="cmp-root cmp-slots">
        <div className="cmp-main">
          <div className={`cmp-controls-box is-inline ${hl('compare-controls')}`} data-tt="compare-controls">
            <div className="cmp-row">
              {leading}
              {viewSwitch}
              {marksToggle}
              {trailing}
            </div>
            <Select
              value={pair.id}
              onChange={(id) => setPairId(id)}
              className="cmp-pair-select"
              popupMatchSelectWidth={false}
              options={PAIRS.map((p) => ({ value: p.id, label: pairLabel(p) }))}
              aria-label="Пара листов"
            />
            <div className="cmp-row cmp-row-tight">
              {view === 'overlay' && (
                <div className={`cmp-opacity-row ${hl('compare-slider')}`} data-tt="compare-slider">
                  <StageChip stage={pair.right.stage} />
                  <span>поверх</span>
                  <StageChip stage={pair.left.stage} />
                  <input type="range" min={0} max={100} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} aria-label="Насколько видна правая страница" />
                  <b className="cmp-opacity-value">{opacity} %</b>
                </div>
              )}
            </div>
            {view === 'overlay' && (
              <div className="cmp-how">
                Ползунок: 0 % - видна только {pair.left.stage}, 100 % - {pair.left.stage} и {pair.right.stage} вместе. Что совпадает, остаётся чёрным, что нет - двойной линией.
              </div>
            )}
            <div className="cmp-legend">
              <span>
                <i style={{ background: REGION_FINDING }} /> красный: кандидат (клик открывает карточку)
              </span>
              {regions.some((r) => r.kind === 'suspicion') && (
                <span>
                  <i style={{ background: REGION_SUSPICION }} /> оранжевый: гипотеза
                </span>
              )}
            </div>
          </div>
          <div className="cmp-viewer">
            <ZoomStage resetKey={`${pair.id}-${view}`}>
              {view === 'overlay' ? (
                <FitFrame images={[{ image: pair.left.image }, { image: pair.right.image, opacity: opacity / 100, blend: true }]} marks={showMarks ? regions.map((r) => markOf(r, 'left')) : []} />
              ) : (
                <div className="cmp-side">
                  {(['left', 'right'] as const).map((side) => (
                    <div key={side} className="cmp-side-pane">
                      <div className="cmp-side-title">
                        <StageChip stage={pair[side].stage} /> {sheetText(pair[side])}
                      </div>
                      <div className="cmp-side-page">
                        <FitFrame images={[{ image: pair[side].image }]} marks={showMarks ? regions.map((r) => markOf(r, side)) : []} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ZoomStage>
          </div>
        </div>
      </div>
    </div>
  );
};
