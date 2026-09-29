import React from 'react';
import { PdfPage } from './PdfPage';
import type { PdfMark } from './PdfPage';
import { ZoomStage } from './ZoomStage';
import { DEFAULT_ZOOM_VIEW } from './zoomView';
import type { ZoomView } from './zoomView';
import { STAGE_COLOR, boxOf, stageLabel } from '@/api/pagePairs';
import type { ApiSuspicion } from '@/api/suspicions';
import type { FileInfo } from '@/api/processes';
import './Compare.css';

const STAGES = ['PD', 'RD', 'ID'] as const;

interface Props {
  suspicion?: ApiSuspicion;
  files: FileInfo[];
  /** Масштаб и сдвиг меняются во всех панелях сразу. */
  sync?: boolean;
  /** Панель стадии без области гипотезы: та же, что у кандидата («Документы не загружены», «Дозагрузить»). */
  renderEmpty: (stage: string) => React.ReactNode;
}

/** Панели ПД / РД / ИД для гипотезы, как у кандидата: страница с рамкой и масштабом; у стадии без области — пустая панель с пояснением. */
export const HypothesisPanels: React.FC<Props> = ({ suspicion, files, sync, renderEmpty }) => {
  const [shared, setShared] = React.useState<ZoomView>(DEFAULT_ZOOM_VIEW);
  if (!suspicion) return <div className="cmp-empty">Выберите гипотезу в списке.</div>;

  const evidence = suspicion.evidence ?? [];
  const panels = STAGES.map((stage) => {
    const fragments = evidence.filter((f) => f.stage === stage);
    if (fragments.length === 0) return { stage, first: undefined, marks: [] as PdfMark[], name: '' };
    const first = fragments[0];
    const sameSheet = fragments.filter((f) => f.file_id === first.file_id && f.page === first.page);
    const marks: PdfMark[] = sameSheet.map((f) => ({
      bbox: boxOf(f.bbox),
      color: STAGE_COLOR[stage],
      label: f.extracted_value || undefined,
      title: f.text_snippet ?? undefined,
    }));
    const file = files.find((x) => x.id === first.file_id);
    return { stage, first, marks, name: first.document_code || file?.original_name || 'Документ' };
  });

  if (panels.every((panel) => !panel.first)) return <div className="cmp-empty">У гипотезы нет привязанных страниц: посмотрите её на сравнении листов.</div>;

  return (
    <div className="hyp-docs" style={{ gridTemplateColumns: panels.map((panel) => (panel.first ? 'minmax(0, 1fr)' : 'minmax(170px, 0.45fr)')).join(' ') }}>
      {panels.map((panel) =>
        !panel.first ? (
          renderEmpty(stageLabel(panel.stage))
        ) : (
        <div key={panel.stage} className="doc-panel">
          <div className="doc-panel-head">
            <span className="stage" style={{ background: STAGE_COLOR[panel.stage] }}>
              {stageLabel(panel.stage)}
            </span>
            <span className="dname">{panel.name}</span>
            <span style={{ fontSize: '11px', color: '#667085', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
              {panel.first.sheet ? `лист ${panel.first.sheet}, ` : ''}стр. {panel.first.page}
            </span>
          </div>
          <div className="hyp-doc-body">
            <ZoomStage resetKey={`${suspicion.suspicion_id}-${panel.stage}`} view={sync ? shared : undefined} onView={sync ? setShared : undefined}>
              <PdfPage
                fileId={panel.first.file_id}
                page={panel.first.page}
                marks={panel.marks}
                fragment={{ fileName: panel.name, value: panel.first.extracted_value ?? undefined, snippet: panel.first.text_snippet ?? undefined }}
              />
            </ZoomStage>
          </div>
        </div>
        )
      )}
    </div>
  );
};
