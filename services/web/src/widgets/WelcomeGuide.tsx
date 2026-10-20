import React from 'react';
import { Button, Card, Modal, Space, Typography, theme } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/app/providers/useAuth';
import type { UserRole } from '@/shared/types';
import { hasTraining } from '@/shared/training';
import { isWelcomeSeen, markWelcomeSeen, welcomeGuide } from '@/shared/welcome';

const { Text, Title } = Typography;

const Steps: React.FC<{ role: UserRole }> = ({ role }) => {
  const { token } = theme.useToken();
  const guide = welcomeGuide(role);
  return (
    <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
      {guide.steps.map((step, index) => (
        <li key={step.title} style={{ display: 'flex', gap: 12 }}>
          <span
            aria-hidden
            style={{ flexShrink: 0, width: 28, height: 28, borderRadius: '50%', background: token.colorPrimary, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}
          >
            {index + 1}
          </span>
          <div>
            <Text strong style={{ display: 'block' }}>
              {step.title}
            </Text>
            <Text type="secondary" style={{ fontSize: 13 }}>
              {step.text}
            </Text>
          </div>
        </li>
      ))}
    </ol>
  );
};

/** Короткая подсказка на дашборде при первом входе: закрывается один раз и больше не показывается. */
export const WelcomeCard: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [seen, setSeen] = React.useState(() => (user ? isWelcomeSeen(user.login) : true));
  // Показываем один раз: при первом показе сразу помечаем прочитанным, чтобы карточка не появлялась при каждом входе
  React.useEffect(() => {
    if (user && !seen) markWelcomeSeen(user.login);
  }, [user, seen]);
  if (!user || seen) return null;
  return (
    <Card style={{ marginBottom: 24, borderRadius: 12 }} styles={{ body: { padding: 20 } }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>
          {welcomeGuide(user.role).heading}
        </Title>
        <Space>
          {hasTraining(user.role) && <Button onClick={() => navigate('/training')}>Пройти обучение</Button>}
          <Button
            type="primary"
            onClick={() => setSeen(true)}
          >
            Понятно
          </Button>
        </Space>
      </div>
      <Steps role={user.role} />
      <Text type="secondary" style={{ display: 'block', marginTop: 12, fontSize: 12 }}>
        Подсказку можно открыть снова в меню пользователя, пункт «Как работать в системе».
      </Text>
    </Card>
  );
};

/** Та же подсказка по запросу: пункт меню пользователя. */
export const WelcomeModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const { user } = useAuth();
  const navigate = useNavigate();
  if (!user) return null;
  const training = hasTraining(user.role);
  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={welcomeGuide(user.role).heading}
      width={760}
      footer={[
        ...(training
          ? [
              <Button
                key="training"
                className="hover-green"
                onClick={() => {
                  onClose();
                  navigate('/training');
                }}
              >
                Пройти обучение
              </Button>,
            ]
          : []),
        <Button key="close" type="primary" onClick={onClose}>
          Закрыть
        </Button>,
      ]}
    >
      <Steps role={user.role} />
    </Modal>
  );
};
