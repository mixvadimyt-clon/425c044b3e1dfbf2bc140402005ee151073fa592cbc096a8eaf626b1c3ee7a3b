import React from 'react';
import { Tabs, Typography, theme } from 'antd';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '@/app/providers/useAuth';
import { DatasetItemsTab } from '@/widgets/ml/DatasetItemsTab';
import { DatasetVersionsTab } from '@/widgets/ml/DatasetVersionsTab';
import { ModelsTab } from '@/widgets/ml/ModelsTab';
import { WeeklyReportTab } from '@/widgets/ml/WeeklyReportTab';

const { Title } = Typography;

/** ML-контур: записи GOLD-набора, версии, модели и недельный отчёт. ML-инженер и администратор работают, руководитель только читает. */
export const MlPage: React.FC = () => {
  const { token } = theme.useToken();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const canAct = user?.role === 'ML_ENGINEER' || user?.role === 'ADMIN';

  const items = [
    // Записи набора разбирает отдельная роль ML-инженера. У администратора этот шаг уже есть в его верификации
    // («Отправить на дообучение»), поэтому вкладка ему не нужна.
    ...(user?.role === 'ML_ENGINEER' ? [{ key: 'items', label: 'Записи набора', children: <DatasetItemsTab canAct={canAct} /> }] : []),
    { key: 'versions', label: 'Версии набора', children: <DatasetVersionsTab canAct={canAct} /> },
    { key: 'models', label: 'Модели', children: <ModelsTab canAct={canAct} /> },
    { key: 'report', label: 'Недельный отчёт', children: <WeeklyReportTab /> },
  ];
  const requested = searchParams.get('tab');
  const activeTab = items.some((item) => item.key === requested) ? (requested as string) : items[0].key;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 24px', background: token.colorBgContainer, borderBottom: `1px solid ${token.colorBorder}` }}>
        <Title level={2} style={{ margin: 0 }}>
          {user?.role === 'ML_ENGINEER' ? 'Дообучение' : 'Версии и модели'}
        </Title>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        <Tabs items={items} activeKey={activeTab} onChange={(key) => setSearchParams({ tab: key }, { replace: true })} />
      </div>
    </div>
  );
};
