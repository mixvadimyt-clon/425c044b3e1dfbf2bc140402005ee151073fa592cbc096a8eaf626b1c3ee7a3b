import React from 'react';
import { Typography, theme } from 'antd';
import { MlflowTab } from '@/widgets/MlflowTab';

const { Title } = Typography;

/** Отдельная страница «MLflow»: доступна администратору и ML-инженеру. */
export const MlflowPage: React.FC = () => {
  const { token } = theme.useToken();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 24px', background: token.colorBgContainer, borderBottom: `1px solid ${token.colorBorder}` }}>
        <Title level={2} style={{ margin: 0 }}>
          MLflow
        </Title>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        <MlflowTab />
      </div>
    </div>
  );
};
