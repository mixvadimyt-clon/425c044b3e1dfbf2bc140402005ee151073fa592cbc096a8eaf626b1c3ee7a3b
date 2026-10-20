import React from 'react';
import { Tabs } from 'antd';
import { highlight } from '@/shared/guide';
import { DatasetVersionsTab } from '@/widgets/ml/DatasetVersionsTab';
import { ModelsTab } from '@/widgets/ml/ModelsTab';
import { WeeklyReportTab } from '@/widgets/ml/WeeklyReportTab';
import { PageTitle, SceneFrame } from '../guideUi';
import type { SceneProps } from '../guideUi';

/**
 * «Версии и модели» руководителя: настоящие вкладки только для чтения (canAct выключен), поэтому ничего изменить нельзя.
 * Это общие сведения о системе, а не об учебном проекте, поэтому данные берутся с сервера как есть.
 */
export const ModelsScene: React.FC<SceneProps> = ({ step, coach }) => {
  const hl = (target: string) => highlight(step, target);
  const [active, setActive] = React.useState('versions');

  // Урок сам переключает вкладки: «Далее» ведёт к следующей; после урока вкладки свободные
  React.useEffect(() => {
    if (step?.target === 'tab-models') setActive('models');
    else if (step?.target === 'tab-report' || step?.target === 'readonly') setActive('report');
    else if (step) setActive('versions');
  }, [step]);

  const area = (key: string, children: React.ReactNode) => (
    <div className={hl(`table-${key}`)} data-tt={`table-${key}`} style={{ padding: 4, borderRadius: 8 }}>
      {children}
    </div>
  );

  return (
    <>
      {coach}
      <SceneFrame height={720}>
        <PageTitle>Версии и модели</PageTitle>
        <div className={hl('readonly')} data-tt="readonly" style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
          <div data-scroll-for="tab-versions tab-models tab-report readonly" style={{ height: 0 }} />
          <Tabs
            activeKey={active}
            onChange={(key) => {
              if (!step) setActive(key);
            }}
            items={[
              { key: 'versions', label: <span className={hl('tab-versions')} data-tt="tab-versions">Версии набора</span>, children: area('versions', <DatasetVersionsTab canAct={false} />) },
              { key: 'models', label: <span className={hl('tab-models')} data-tt="tab-models">Модели</span>, children: area('models', <ModelsTab canAct={false} />) },
              { key: 'report', label: <span className={hl('tab-report')} data-tt="tab-report">Недельный отчёт</span>, children: area('report', <WeeklyReportTab />) },
            ]}
          />
        </div>
      </SceneFrame>
    </>
  );
};
