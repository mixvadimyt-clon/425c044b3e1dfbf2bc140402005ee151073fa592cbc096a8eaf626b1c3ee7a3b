import React from 'react';
import { Tooltip } from 'antd';
import { useHealth, useIntegrationStatus, summarizeSystem } from '@/api/system';
import type { StatusLevel } from '@/api/system';
import { useAuth } from '@/app/providers/useAuth';
import { useProjects } from '@/app/providers/useProjects';

const COLORS: Record<StatusLevel, string> = { ok: '#12B76A', warn: '#F79009', bad: '#F04438', off: '#98A2B3' };

/** Состояние системы в шапке: api, разбор документов и обмен с внешней ИС. В демонстрационном режиме не показывается. */
export const SystemStatus: React.FC = () => {
  const { mode, projects } = useProjects();
  const { user } = useAuth();
  const live = mode === 'live' || mode === 'stale';
  const health = useHealth(live);
  // Обмен с внешней ИС доступен ролям, которые работают с проверками
  const integration = useIntegrationStatus(live && user?.role !== 'ML_ENGINEER');

  if (!live) return null;
  const chips = summarizeSystem({ health: health.data, integration: integration.data, processStatuses: projects.map((p) => p.processStatus) });

  return (
    <div className="system-status" aria-label="Состояние системы">
      {chips.map((chip) => (
        <Tooltip key={chip.key} title={chip.detail}>
          <span className="system-chip">
            <span className="system-dot" style={{ background: COLORS[chip.level] }} />
            <span className="system-chip-label">{chip.label}</span>
          </span>
        </Tooltip>
      ))}
    </div>
  );
};
