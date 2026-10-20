import React from 'react';
import { Alert, Button, Card, Skeleton, Space, Typography, theme } from 'antd';
import { LinkOutlined } from '@ant-design/icons';
import { MlflowUnavailableError, useMlflowSession } from '@/api/mlflow';
import { QueryErrorAlert } from '@/widgets/QueryErrorAlert';

const { Text } = Typography;

/** Вкладка «MLflow»: эксперименты с моделями (метрики §14) и версиями GOLD-набора; MLflow открывается во фрейме того же сайта. */
export const MlflowTab: React.FC = () => {
  const { token } = theme.useToken();
  const session = useMlflowSession();

  const cardStyle: React.CSSProperties = { borderRadius: 12, background: token.colorBgContainer, border: `1px solid ${token.colorBorder}` };

  if (session.isLoading) {
    return (
      <Card style={cardStyle}>
        <Skeleton active paragraph={{ rows: 4 }} />
      </Card>
    );
  }

  if (session.error instanceof MlflowUnavailableError) {
    return (
      <Alert
        type="warning"
        showIcon
        message="MLflow не подключён к этому api"
        description="У api не задан MLFLOW_URL. Стенд в Docker включает MLflow флагом ./start.sh --mlflow, при локальном запуске без Docker раздел недоступен."
      />
    );
  }

  if (session.isError || !session.data) {
    return <QueryErrorAlert title="Не удалось открыть MLflow" error={session.error} onRetry={() => void session.refetch()} />;
  }

  const { url } = session.data;
  return (
    <Card
      style={cardStyle}
      styles={{ body: { padding: 0 } }}
      title={
        <Space size={12} wrap>
          <Text strong style={{ fontSize: 15 }}>Эксперименты и модели</Text>
          <Text type="secondary" style={{ fontWeight: 400, fontSize: 12.5 }}>
            inspector-models: модели с метриками §14, inspector-datasets: версии GOLD-набора. Прогоны обучения: режим «Model training» слева вверху.
          </Text>
        </Space>
      }
      extra={
        <Button icon={<LinkOutlined />} href={url} target="_blank" rel="noreferrer">
          Открыть в новой вкладке
        </Button>
      }
    >
      <iframe title="MLflow" src={url} style={{ width: '100%', height: 'calc(100vh - 300px)', minHeight: 480, border: 0, borderRadius: '0 0 12px 12px' }} />
    </Card>
  );
};
