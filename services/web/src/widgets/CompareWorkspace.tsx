import React from 'react';
import { Select } from 'antd';
import { PdfPage } from './PdfPage';
import type { PdfMark } from './PdfPage';
import { ComparePages } from './ComparePages';
import { ZoomStage } from './ZoomStage';
import { REGION_COLOR, STAGE_COLOR, pickPair, regionColor, regionShareText, regionSide, stageLabel, toRegions, usePagePairs } from '@/api/pagePairs';
import type { CompareRegion, PagePair, PageRef } from '@/api/pagePairs';
import type { DraftFragment } from '@/shared/verification';
import './Compare.css';

/** Плашка стадии тех же цветов, что в панелях верификации. */
const StageChip: React.FC<{ stage: string }> = ({ stage }) => (
  <span className="cmp-stage" style={{ background: STAGE_COLOR[stage] ?? '#667085' }}>
    {stageLabel(stage)}
  </span>
);

const sheetOf = (ref: PageRef) => `${ref.document_code ?? ref.original_name ?? ''}, ${ref.sheet ? `л. ${ref.sheet}` : `стр. ${ref.page}`}`;

/** Пункт списка пар: «ПД KR-AR, л. 1 ↔ РД KZh01, л. 1 · совпадение 91 %» с цветными плашками стадий. */
const PairLabel: React.FC<{ pair: PagePair }> = ({ pair }) => (
  <span className="cmp-pair-label">
    <StageChip stage={pair.left.stage} /> {sheetOf(pair.left)} <span className="cmp-arrow">↔</span> <StageChip stage={pair.right.stage} /> {sheetOf(pair.right)}
    <span className="cmp-pair-score">, совпадение {Math.round(pair.match_score * 100)} %</span>
  </span>
);

interface Props {
  protocolId?: string | null;
  currentFindingId?: string;
  /** Выбранная гипотеза (экран гипотез): нужна пара с её областью, область подсвечивается. */
  selectedSuspicionId?: string;
  /** Красная область: открыть несоответствие. */
  onSelectFinding: (findingId: string) => void;
  /** Оранжевая область: выбрать гипотезу (экран гипотез) или перейти к ней (проверка кандидатов). */
  onSelectSuspicion?: (suspicionId: string) => void;
  /** Идёт перевод гипотезы в кандидата: нужны две страницы рядом, на них рисуются рамки. */
  drawing?: boolean;
  drafts?: DraftFragment[];
  onAddDraft?: (ref: PageRef, box: { x: number; y: number; w: number; h: number }) => void;
  /** Полный экран: пояснения (подпись к ползунку, легенда) не повторяются. */
  hideHelp?: boolean;
  /** Кнопки в одной строке с выбором пары: слева (переключатель режима) и справа («Во весь экран»). */
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  /**
   * Только для своей записи (разбор для дообучения у администратора): пара листов зафиксирована на записи
   * (`currentFindingId`/`selectedSuspicionId`), переключатель пары скрыт. Области других несоответствий этого же
   * протокола, которых нет в `visibleFindingIds`, не показываются — иначе через сравнение листов открывается
   * весь протокол. Области без `finding_id` (только гипотеза) оставляем: сервер не всегда возвращает
   * `finding_id` для уже одобренной гипотезы, а прятать доказательство самой записи нельзя.
   */
  restricted?: boolean;
  visibleFindingIds?: ReadonlySet<string>;
}

/**
 * Сравнение листов: пары страниц из `GET /protocols/{id}/page-pairs`, наложение с совмещением или две страницы рядом,
 * масштаб, области различий (красные — несоответствие, оранжевые — гипотеза, серые — различие без записи).
 */
export const CompareWorkspace: React.FC<Props> = ({
  protocolId,
  currentFindingId,
  selectedSuspicionId,
  onSelectFinding,
  onSelectSuspicion,
  drawing,
  drafts = [],
  onAddDraft,
  hideHelp,
  leading,
  trailing,
  restricted,
  visibleFindingIds,
}) => {
  const pairsQ = usePagePairs(protocolId);
  const pairs = pairsQ.data ?? [];

  const [pairId, setPairId] = React.useState<string | undefined>(undefined);
  const [view, setView] = React.useState<'overlay' | 'side'>('overlay');
  const [opacity, setOpacity] = React.useState(55);
  // Области различий можно временно скрыть, если они закрывают сам документ (тот же переключатель, что у панелей)
  const [showMarks, setShowMarks] = React.useState(true);

  // Открывается пара с текущим несоответствием (или выбранной гипотезой), иначе лучшая по совпадению
  React.useEffect(() => {
    const target = pickPair(pairs, currentFindingId, selectedSuspicionId);
    if (target && target.id !== pairId) setPairId(target.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairs.length, currentFindingId, selectedSuspicionId]);

  // Рамки рисуются на самих страницах, поэтому при переводе в кандидата нужны две страницы рядом
  React.useEffect(() => {
    if (drawing) setView('side');
  }, [drawing]);

  const pair = pairs.find((p) => p.id === pairId) ?? pairs[0];
  const allRegions = React.useMemo(() => (pair ? toRegions(pair) : []), [pair]);
  // В ограниченном режиме показываем только записи своей очереди (по finding_id) и области без finding_id, которые
  // относятся к самой записи (без него сервер не всегда возвращает finding_id для уже одобренной гипотезы). Различия
  // без finding_id и suspicion_id вообще («серые») — это чужие данные всего протокола, их не показываем. Все видимые
  // области в очереди дообучения уже решены (одобрены или отклонены инспектором), открытых гипотез там нет — поэтому
  // перекрашиваем их в цвет несоответствия, а не гипотезы, чтобы не путать администратора.
  const regions = React.useMemo(() => {
    if (!(restricted && visibleFindingIds)) return allRegions;
    return allRegions
      .filter((r) => (r.findingId ? visibleFindingIds.has(r.findingId) : Boolean(r.suspicionId)))
      .map((r) => (r.kind === 'finding' ? r : { ...r, kind: 'finding' as const }));
  }, [allRegions, restricted, visibleFindingIds]);
  const activeKey = regions.find((r) => r.suspicionId && r.suspicionId === selectedSuspicionId)?.key;

  const onRegion = (region: CompareRegion) => {
    if (region.findingId) onSelectFinding(region.findingId);
    else if (region.suspicionId) onSelectSuspicion?.(region.suspicionId);
  };

  // Что даёт нажатие на область: открыть другого кандидата или гипотезу. Для уже открытой записи и для различия без записи
  // нажимать нечего, поэтому и курсор «рука» не показываем
  const regionAction = (region: CompareRegion): { click?: () => void; title: string } => {
    const { title, click } = regionActionBase(region);
    const share = regionShareText(region.score);
    return { click, title: share ? `${title} (${share})` : title };
  };
  const regionActionBase = (region: CompareRegion): { click?: () => void; title: string } => {
    if (region.findingId) return region.findingId === currentFindingId ? { title: `${region.label}: эта запись уже открыта` } : { click: () => onRegion(region), title: `${region.label}: открыть кандидата` };
    if (region.suspicionId && onSelectSuspicion)
      return region.suspicionId === selectedSuspicionId ? { title: `${region.label}: эта гипотеза уже открыта` } : { click: () => onRegion(region), title: `${region.label}: открыть гипотезу` };
    return { title: `${region.label}: различие без записи, открывать нечего` };
  };

  const sideMarks = (ref: PageRef, side: 'left' | 'right'): PdfMark[] => [
    ...(showMarks
      ? regions
          // «только в ПД» рисуем только на листе ПД: на листе РД такого места нет
          .filter((region) => !pair || (regionSide(region, pair) ?? side) === side)
          .map((region) => {
            const action = regionAction(region);
            return { bbox: region[side], color: regionColor(region), label: region.label, dashed: region.kind === 'other', title: action.title, onClick: action.click };
          })
      : []),
    ...drafts
      .filter((d) => d.fileId === ref.file_id && d.page === ref.page)
      .map((d) => ({ bbox: d.bbox, color: d.role === 'EXPECTED' ? '#2450C7' : '#B4620B', label: `новая${d.value ? `: ${d.value}` : ''}` })),
  ];

  const marksToggle = (
    <button className="btn btn-ghost sync-toggle-btn" onClick={() => setShowMarks((v) => !v)} title="Скрыть или показать области различий поверх документа">
      {showMarks ? '▢ Скрыть рамки' : '▢ Показать рамки'}
    </button>
  );

  const drawOn = (ref: PageRef) => (drawing && onAddDraft ? (box: { x: number; y: number; w: number; h: number }) => onAddDraft(ref, box) : undefined);

  if (pairsQ.isLoading || pairsQ.isError) {
    return (
      <div className="cmp-container">
        <div className="cmp-root cmp-slots">
          <div className="cmp-main">
            <div className="cmp-controls-box is-inline">
              <div className="cmp-row">
                {leading}
                {trailing}
              </div>
            </div>
            {pairsQ.isLoading ? <div className="cmp-empty">Загрузка пар листов…</div> : <div className="cmp-empty cmp-empty-error">Не удалось загрузить пары листов.</div>}
          </div>
        </div>
      </div>
    );
  }

  const viewSwitch = pair ? (
    <div className="cmp-seg" role="group" aria-label="Вид">
      <button className={view === 'overlay' ? 'is-on' : ''} onClick={() => setView('overlay')} disabled={Boolean(drawing)} title={drawing ? 'Для рисования нужны страницы рядом' : 'Обе страницы друг на друге'}>
        Наложение
      </button>
      <button className={view === 'side' ? 'is-on' : ''} onClick={() => setView('side')} title="Две страницы рядом">
        Рядом
      </button>
    </div>
  ) : null;
  const select = !pair ? null : restricted ? (
    <span className="cmp-pair-select cmp-pair-label-static">
      <PairLabel pair={pair} />
    </span>
  ) : (
    <Select
      value={pair.id}
      onChange={(id) => setPairId(id)}
      className="cmp-pair-select"
      popupMatchSelectWidth={false}
      options={pairs.map((p) => ({ value: p.id, label: <PairLabel pair={p} /> }))}
      aria-label="Пара листов"
    />
  );

  const controls = (
    <div className="cmp-controls-box is-inline">
      {hideHelp ? (
        // Полный экран: выбор пары, за ним «Наложение / Рядом» в одной строке
        <div className="cmp-row cmp-row-fs">
          {select}
          {viewSwitch}
          {marksToggle}
        </div>
      ) : (
        <>
          <div className="cmp-row">
            {leading}
            {viewSwitch}
            {marksToggle}
            {trailing}
          </div>
          {select}
        </>
      )}

      {pair && (
        <>
          <div className="cmp-row cmp-row-tight">
            {view === 'overlay' && (
              <div className="cmp-opacity-row">
                <StageChip stage={pair.right.stage} />
                <span>поверх</span>
                <StageChip stage={pair.left.stage} />
                <input type="range" min={0} max={100} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} aria-label="Насколько видна правая страница" />
                <b className="cmp-opacity-value">{opacity} %</b>
              </div>
            )}
            {pair.compliance_percent != null && (
              <span className="cmp-score" title="Насколько страницы этой пары совпадают по проверенным параметрам">
                Соответствие {pair.compliance_percent} %
              </span>
            )}
          </div>
          {!hideHelp && view === 'overlay' && (
            <div className="cmp-how">
              Ползунок: 0 % - видна только {stageLabel(pair.left.stage)}, 100 % - {stageLabel(pair.left.stage)} и {stageLabel(pair.right.stage)} вместе. Что совпадает, остаётся чёрным, что нет - двойной линией.
            </div>
          )}
          {!pair.homography && <div className="cmp-warn">Совмещение не выполнялось: страницы показаны как есть</div>}
          {drawing && <div className="cmp-hint">Обведите значение на странице, чтобы добавить доказательство</div>}
          {!hideHelp && (
            <div className="cmp-legend">
              <span>
                <i style={{ background: REGION_COLOR.finding }} /> красный: {restricted ? 'запись из очереди дообучения' : 'кандидат (клик открывает карточку)'}
              </span>
              {/* Легенда только для того, что есть на этой паре листов */}
              {!restricted && (
                <>
                  {regions.some((r) => r.kind === 'suspicion' && regionColor(r) === REGION_COLOR.suspicion) && (
                    <span>
                      <i style={{ background: REGION_COLOR.suspicion }} /> оранжевый: гипотеза
                    </span>
                  )}
                  {(['PD', 'RD', 'ID'] as const).map((stage) =>
                    regions.some((r) => r.kind === 'suspicion' && regionColor(r) === STAGE_COLOR[stage]) ? (
                      <span key={stage}>
                        <i style={{ background: STAGE_COLOR[stage] }} /> «только в {stageLabel(stage)}»
                      </span>
                    ) : null,
                  )}
                  {regions.some((r) => r.kind === 'other') && (
                    <span>
                      <i style={{ background: REGION_COLOR.other }} /> серый пунктир: различие без предложения системы
                    </span>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );

  const viewer = pair ? (
    <div className="cmp-viewer">
      <ZoomStage resetKey={`${pair.id}-${view}`}>
        {view === 'overlay' ? (
          <ComparePages pair={pair} regions={showMarks ? regions : []} opacity={opacity} activeKey={activeKey} actionOf={regionAction} />
        ) : (
          <div className="cmp-side">
            {(['left', 'right'] as const).map((side) => {
              const ref = pair[side];
              return (
                <div key={side} className="cmp-side-pane">
                  <div className="cmp-side-title">
                    <StageChip stage={ref.stage} /> {ref.document_code ?? ref.original_name}
                    {ref.revision ? `, ред. ${ref.revision}` : ''}, {ref.sheet ? `лист ${ref.sheet}` : `стр. ${ref.page}`}
                  </div>
                  <div className="cmp-side-page">
                    <PdfPage fileId={ref.file_id} page={ref.page} marks={sideMarks(ref, side)} onDraw={drawOn(ref)} fragment={{ fileName: ref.document_code ?? ref.original_name }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </ZoomStage>
    </div>
  ) : (
    <div className="cmp-empty">Для этой проверки нет сопоставленных листов: в комплекте нет страниц разных стадий с общим листом.</div>
  );

  return (
    <div className="cmp-container">
      <div className="cmp-root cmp-slots">
        <div className="cmp-main">
          {controls}
          {viewer}
        </div>
      </div>
    </div>
  );
};
