import React from 'react';
import { Button, Drawer, Typography, theme } from 'antd';
import { APPROVAL_STATUS, CHECK_PRIORITY, REJECT_REASON, findingStatusView } from '@/shared/statuses';
import { lowerFirst, pageLabel, withoutLongDash } from '@/shared/text';
import { StatusPill } from '@/widgets/StatusPill';
import { StageComparisonTable } from '@/widgets/StageComparisonTable';
import type { ProtocolFinding } from './protocolData';

const { Text } = Typography;

const STAGE_COLORS: Record<string, string> = {
  'ПД': '#2450C7',
  'РД': '#B4620B',
  'ИД': '#5B4FBE',
};

const DECISION_LABEL = {
  CONFIRM: 'Подтверждено',
  REJECT: 'Отклонено',
  CLARIFY: 'Требует уточнения',
} as const;

interface EvidenceCardDrawerProps {
  finding: ProtocolFinding | null;
  onClose: () => void;
  /** Без обработчика кнопки «Открыть в верификации» нет (у администратора верификации проектов нет). */
  onOpenVerification?: () => void;
}

/** Карточка доказательства (REQ-CMP-09): все поля, которые обязан содержать протокол. */
export const EvidenceCardDrawer: React.FC<EvidenceCardDrawerProps> = ({ finding, onClose, onOpenVerification }) => {
  const { token } = theme.useToken();
  const vars = {
    '--pr-teal': '#12988C',
    '--pr-border': token.colorBorder,
    '--pr-muted': token.colorTextSecondary,
  } as React.CSSProperties;
  const status = finding ? findingStatusView(finding.status, Boolean(finding.decision)) : undefined;
  const priority = finding?.priority ? CHECK_PRIORITY[finding.priority] : undefined;

  return (
    <Drawer
      open={Boolean(finding)}
      onClose={onClose}
      width="min(760px, 100vw)"
      title={
        finding && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Карточка доказательства: {finding.id}
            </Text>
            <span style={{ fontSize: 18, fontWeight: 600 }}>
              {finding.paramCode}, {finding.paramName}
            </span>
          </div>
        )
      }
      extra={
        finding &&
        onOpenVerification &&
        finding.sources.length > 0 && (
          <Button type="primary" onClick={onOpenVerification}>
            Открыть в верификации
          </Button>
        )
      }
    >
      {finding && status && (
        <div className="pr-card-body" style={vars}>
          <div className="pr-card-row">
            <StatusPill color={status.color}>{status.label}</StatusPill>
            {priority && <StatusPill color={priority.color}>Приоритет проверки: {lowerFirst(priority.label)}</StatusPill>}
            <Text type="secondary" code style={{ fontSize: 12 }}>
              {finding.ruleKey}
            </Text>
          </div>

          {(finding.expected || finding.actual) && (
            <section>
              <h4>Ожидается и фактически</h4>
              <div className="pr-values">
                <div className="pr-value-box">
                  <span className="pr-ev-stage" style={{ background: STAGE_COLORS['ПД'] }}>
                    Ожидается
                  </span>
                  <div className="pr-value-big">{finding.expected ?? 'нет'}</div>
                </div>
                <div className="pr-value-box">
                  <span className="pr-ev-stage" style={{ background: STAGE_COLORS['РД'] }}>
                    Фактически
                  </span>
                  <div className="pr-value-big">{finding.actual ?? 'нет'}</div>
                </div>
                <div className="pr-value-box">
                  <span className="pr-ev-stage pr-ev-stage-neutral">Отклонение</span>
                  <div className="pr-value-big">{finding.delta ?? 'нет'}</div>
                </div>
              </div>
            </section>
          )}

          {finding.stageComparisons && finding.stageComparisons.length > 0 && (
            <section>
              <h4>Сравнение по стадиям</h4>
              <StageComparisonTable rows={finding.stageComparisons} />
              {finding.triggerLogic && (
                <p style={{ marginTop: 8, fontSize: 13 }}>
                  <Text type="secondary">Правило срабатывания. </Text>
                  {finding.triggerLogic}
                </p>
              )}
            </section>
          )}

          <section>
            <h4>Обоснование</h4>
            <p>{withoutLongDash(finding.rationale)}</p>
            <div className="pr-meta">
              <span>Источник обоснования: {finding.rationaleSource === 'RULES' ? 'правила' : 'ИИ'}</span>
              {finding.normative && <span>Норматив: {finding.normative}</span>}
              <span>Версия доказательств: {finding.evidenceVersion}</span>
            </div>
          </section>

          <section>
            <h4>Источники ({finding.sources.length})</h4>
            {finding.sources.length === 0 ? (
              <div className="pr-empty-inline">Нет доказательств. {finding.request}</div>
            ) : (
              finding.sources.map((src) => {
                const approval = APPROVAL_STATUS[src.approval];
                return (
                  <div className="pr-source" key={`${src.role}-${src.fileId}-${src.page}`}>
                    <div className="pr-source-head">
                      <span className="pr-ev-stage" style={{ background: STAGE_COLORS[src.stage] }}>
                        {src.stage}
                      </span>
                      <b>{src.value}</b>
                      <StatusPill color={approval.color}>{approval.label}</StatusPill>
                    </div>
                    <div className="pr-details-grid">
                      <div>
                        <b>Файл</b>
                        {src.fileName}
                        <small>{src.fileId}</small>
                      </div>
                      <div>
                        <b>Шифр и редакция</b>
                        {src.cipher}, {src.revision}
                      </div>
                      <div>
                        <b>Лист и страница</b>
                        {pageLabel(src.sheet, src.page)}
                      </div>
                      <div>
                        <b>Область на странице (доли)</b>
                        {src.bbox ? src.bbox.map((n) => n.toFixed(2)).join(', ') : 'нет'}
                      </div>
                      <div style={{ gridColumn: '1 / -1' }}>
                        <b>SHA-256</b>
                        <Text code copyable={{ text: src.sha256 }} style={{ fontSize: 12, wordBreak: 'break-all' }}>
                          {src.sha256}
                        </Text>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </section>

          <section>
            <h4>Решение инспектора</h4>
            {finding.decision ? (
              <div className="pr-details-grid">
                <div>
                  <b>Решение</b>
                  {DECISION_LABEL[finding.decision.action]}
                </div>
                {finding.decision.reasonCode && (
                  <div>
                    <b>Причина</b>
                    {REJECT_REASON[finding.decision.reasonCode].label}
                  </div>
                )}
                <div>
                  <b>Кто и когда</b>
                  {finding.decision.by}, {finding.decision.at}
                </div>
                {/* Документ-основание бывает не у каждого решения: без причины «Согласованное изменение» строку не показываем */}
                {(finding.approvedChangeRef || finding.decision.reasonCode === 'APPROVED_CHANGE') && (
                  <div>
                    <b>Документ согласования</b>
                    {finding.approvedChangeRef ?? 'Не указан'}
                  </div>
                )}
                <div style={{ gridColumn: '1 / -1' }}>
                  <b>Комментарий</b>
                  {finding.decision.comment}
                </div>
              </div>
            ) : (
              <div className="pr-empty-inline">
                {finding.status === 'CANDIDATE' ? 'Решение ещё не принято. Откройте кандидата в верификации.' : finding.status === 'NEGATIVE_VERIFIED' ? 'Решения инспектора нет: система не нашла нарушения.' : 'Решения инспектора нет.'}
              </div>
            )}
          </section>

          {finding.request && finding.sources.length > 0 && (
            <section>
              <h4>Что сделать</h4>
              <p>{finding.request}</p>
            </section>
          )}
        </div>
      )}
    </Drawer>
  );
};
