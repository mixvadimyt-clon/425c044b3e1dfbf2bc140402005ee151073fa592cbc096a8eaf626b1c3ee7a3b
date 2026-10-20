import React from 'react';
import { Progress, Tooltip, Typography } from 'antd';
import { StatusPill } from './StatusPill';
import type { PillTone } from './StatusPill';
import { PROCESS_STATUS } from '@/shared/statuses';
import type { Project, ProjectCounts } from '@/shared/projects';

const { Text } = Typography;

const COUNTERS: Array<{ key: keyof Omit<ProjectCounts, 'compliancePercent'>; label: string; tone: PillTone; hint: string }> = [
  { key: 'candidatesPending', label: 'Ожидают', tone: 'warning', hint: 'Кандидаты, по которым инспектор ещё не принял решение' },
  { key: 'confirmedViolations', label: 'Нарушений', tone: 'error', hint: 'Нарушения, подтверждённые инспектором' },
  { key: 'clarificationRequired', label: 'Уточнение', tone: 'info', hint: 'Отправлено на уточнение' },
  { key: 'missingEvidence', label: 'Без доказательств', tone: 'default', hint: 'Параметры, для которых не хватает документов' },
  { key: 'suspicions', label: 'Гипотез', tone: 'default', hint: 'Подозрения вне матрицы: не нарушения, пока инспектор не сделал их кандидатами' },
];

/** Статус последней проверки объекта и счётчики: показываются только ненулевые. */
export const CheckCell: React.FC<{ project: Project }> = ({ project }) => {
  // Демо-проект (запасной режим) не связан с проверкой в api: у него нет и `processId`
  if (project.processId === undefined) return <Text type="secondary">нет</Text>;
  const status = project.processStatus ? PROCESS_STATUS[project.processStatus as keyof typeof PROCESS_STATUS] : undefined;
  if (!status) return <Text type="secondary">Проверки не было</Text>;
  const counts = project.counts;
  const shown = counts ? COUNTERS.filter((c) => counts[c.key] > 0) : [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
      <StatusPill color={status.color}>{status.label}</StatusPill>
      {counts && shown.length === 0 && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          Замечаний нет
        </Text>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {shown.map((c) => (
          <Tooltip key={c.key} title={c.hint}>
            <span>
              <StatusPill tone={c.tone}>
                {c.label}: {counts![c.key]}
              </StatusPill>
            </span>
          </Tooltip>
        ))}
      </div>
    </div>
  );
};

/** «Соответствие»: доля сопоставимых проверок без расхождения. */
export const ComplianceCell: React.FC<{ project: Project }> = ({ project }) => {
  const percent = project.counts?.compliancePercent;
  if (percent === undefined) return <Text type="secondary">нет</Text>;
  if (percent === null) {
    return (
      <Tooltip title="Пока нет ни одной сопоставимой проверки">
        <Text type="secondary">нет</Text>
      </Tooltip>
    );
  }
  const rounded = Math.round(percent);
  return (
    <Tooltip title="Доля проверок без расхождения среди сопоставимых: проверено без расхождения / (без расхождения + кандидаты без решения + подтверждённые нарушения)">
      <div style={{ minWidth: 70 }}>
        <Text strong style={{ fontSize: 14 }}>
          {rounded} %
        </Text>
        <Progress percent={rounded} showInfo={false} size="small" strokeColor="#12988C" style={{ marginBottom: 0, lineHeight: 1 }} />
      </div>
    </Tooltip>
  );
};
