import React from 'react';
import { Alert } from 'antd';
import { STAGE_COLOR, stageLabel } from '@/api/pagePairs';
import { coverageSummary, fullCoverageText, hasNoSheets, isFullCoverage, limitsText, pluralRu, sheetLabel, skipReasonText } from '@/api/visualCoverage';
import type { Coverage, FileLabel, SkippedSheet } from '@/api/visualCoverage';

interface Props {
  /** Нет отчёта (404, старый ML): ничего не показываем. */
  coverage: Coverage | null | undefined;
  /** Файлы комплекта: по ним лист подписывается шифром документа. */
  files?: readonly FileLabel[];
  /** Клик по пропущенному листу: открыть его на экране сравнения. */
  onOpenSheet: (sheet: SkippedSheet) => void;
  /** Полный экран: одна строка, список пропущенных листов раскрывается кнопкой «Пропущено N» справа в этой строке. */
  compact?: boolean;
}

/**
 * Покрытие графического поиска: сколько листов и пар проверено, действовал ли лимит и какие листы пропущены с причиной.
 * Оформлено тем же `Alert`, что баннеры протокола («Все решения приняты…»): жёлтый при ограничении, пропусках или без чертежей, зелёный при полном покрытии.
 * Нет отчёта (старый ML): ничего не показываем.
 */
export const VisualCoverage: React.FC<Props> = ({ coverage, files = [], onOpenSheet, compact }) => {
  const [open, setOpen] = React.useState(false);
  if (!coverage) return null;

  if (hasNoSheets(coverage)) {
    return <Alert className="cmp-cov" type="warning" showIcon message="Листы-чертежи в комплекте не найдены, графическое сравнение не выполнялось" />;
  }

  if (isFullCoverage(coverage)) {
    return <Alert className="cmp-cov" type="success" showIcon message={fullCoverageText(coverage)} />;
  }

  const limits = limitsText(coverage.limits);
  const { skipped, skippedTotal } = coverage;
  const hasDetails = Boolean(coverage.limited && limits) || skippedTotal > 0 || coverage.textHeavy > 0;

  const message = (
    <span className="cmp-cov-title">
      <span>{coverageSummary(coverage).replace(/^./, (c) => c.toUpperCase())}</span>
      {coverage.limited && (
        <span className="cmp-cov-badge" title={limits ? `Действовали лимиты: ${limits}` : 'Прогон остановили лимиты'}>
          ограниченный прогон
        </span>
      )}
      {compact && skippedTotal > 0 && (
        <button type="button" className="cmp-cov-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          Пропущено {skippedTotal} {open ? '▴' : '▾'}
        </button>
      )}
    </span>
  );

  const description = hasDetails && (!compact || open) ? (
    <div className={`cmp-cov-body${compact ? ' cmp-cov-body-compact' : ''}`}>
      {/* Лимиты и «Пропущено» в одной строке: кнопка справа, лишней пустой строки нет */}
      <div className="cmp-cov-line">
        {coverage.limited && limits && <span>Действовали лимиты: {limits}</span>}
        {!compact && skippedTotal > 0 && (
          <button type="button" className="cmp-cov-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            Пропущено {skippedTotal} {open ? '▴' : '▾'}
          </button>
        )}
      </div>
      {(open || compact) && (
        <>
          <ul className="cmp-cov-list">
            {skipped.map((sheet) => (
              <li key={`${sheet.file_id}-${sheet.page}-${sheet.reason}`}>
                <span className="cmp-stage" style={{ background: STAGE_COLOR[sheet.stage] ?? '#667085' }}>
                  {stageLabel(sheet.stage)}
                </span>
                <span className="cmp-cov-sheet">{sheetLabel(sheet, files)}</span>
                <span className="cmp-cov-reason">{skipReasonText(sheet.reason)}</span>
                <button type="button" className="cmp-cov-open" onClick={() => onOpenSheet(sheet)}>
                  открыть лист
                </button>
              </li>
            ))}
          </ul>
          {skippedTotal > skipped.length && (
            <div>
              и ещё {skippedTotal - skipped.length} {pluralRu(skippedTotal - skipped.length, ['лист', 'листа', 'листов'])}, в список они не вошли
            </div>
          )}
        </>
      )}
      {(open || compact) && coverage.textHeavy > 0 && (
        <div>
          Без проверки остались {coverage.textHeavy} {pluralRu(coverage.textHeavy, ['страница', 'страницы', 'страниц'])} с большим текстом (записки, акты, спецификации)
        </div>
      )}
    </div>
  ) : undefined;

  return <Alert className="cmp-cov" type="warning" showIcon message={message} description={description} />;
};
