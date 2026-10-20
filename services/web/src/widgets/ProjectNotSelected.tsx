import React from 'react';
import { Button, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/app/providers/useAuth';

const { Title, Text } = Typography;

interface Props {
  /** Какая страница: определяет, на какую таблицу дашборда сослаться. */
  context: 'protocol' | 'verification';
  /** Заголовок; по умолчанию «Проект не выбран» (в разборе дообучения выбирают запись, а не проект). */
  heading?: string;
}

/** Таблица дашборда, где реально взять проект, — своя для роли и страницы. */
const tableHint = (isAdmin: boolean, context: Props['context']): string => {
  if (!isAdmin) return 'Проекты на проверке';
  return context === 'protocol' ? 'Запросы на откат финализации' : 'Записи для дообучения';
};

/** Подсказка вместо содержимого страницы, пока не выбран проект. */
export const ProjectNotSelected: React.FC<Props> = ({ context, heading = 'Проект не выбран' }) => {
  const navigate = useNavigate();
  const { user } = useAuth();
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div style={{ maxWidth: 520, textAlign: 'center' }}>
        <Title level={4} style={{ marginBottom: 12 }}>
          {heading}
        </Title>
        <Text type="secondary" style={{ fontSize: 15, lineHeight: 1.6, display: 'block', marginBottom: 20 }}>
          Выберите проект в списке «Проект» вверху страницы или откройте его на дашборде, в таблице «{tableHint(user?.role === 'ADMIN', context)}».
        </Text>
        <Button type="primary" onClick={() => navigate('/dashboard')}>
          К дашборду
        </Button>
      </div>
    </div>
  );
};
