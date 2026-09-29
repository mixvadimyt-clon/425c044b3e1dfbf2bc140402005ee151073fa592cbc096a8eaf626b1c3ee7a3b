import React, { useState } from 'react';
import { Form, Input, Button, Card, Typography, App, Divider, Space } from 'antd';
import { UserOutlined, LockOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/app/providers/useAuth';
import { apiClient } from '@/api/client';
import { DEMO_MODE } from '@/app/config';
import { ROLE_LABEL } from '@/shared/roles';
import type { components } from '@/api/schema';

const { Title, Text } = Typography;

type AuthAccount = components['schemas']['AuthAccount'];

interface LoginForm {
  username: string;
  password: string;
}

export const LoginPage: React.FC = () => {
  const [loading, setLoading] = useState(false);
  // Вход временно закрыт (429 TOO_MANY_LOGIN_ATTEMPTS): до этого момента кнопка недоступна
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [lockedIn, setLockedIn] = useState(0);
  const navigate = useNavigate();
  const { login } = useAuth();
  const { message } = App.useApp();
  // Открытый вход на время экспертизы (OPEN_ACCESS у api, 29.09): кнопки ролей вместо пароля
  const [accounts, setAccounts] = useState<AuthAccount[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    apiClient
      .GET('/api/v1/auth/options')
      .then(({ data }) => {
        if (!cancelled && data?.open_access) setAccounts(data.accounts);
      })
      .catch(() => {
        // api старее 0.24.0 или недоступен: остаётся вход по паролю
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (!lockedUntil) return;
    const tick = () => {
      const left = Math.ceil((lockedUntil - Date.now()) / 1000);
      if (left <= 0) {
        setLockedUntil(null);
        setLockedIn(0);
      } else {
        setLockedIn(left);
      }
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [lockedUntil]);

  const signIn = async (loginName: string, password: string) => {
    setLoading(true);
    try {
      const { data, error, response } = await apiClient.POST('/api/v1/auth/login', {
        body: {
          login: loginName,
          password,
        },
      });

      if (error || !data) {
        if (response.status === 429) {
          const retryAfterS = Number(response.headers.get('Retry-After')) || (error?.details?.retry_after_s as number | undefined);
          message.error(error?.message ?? 'Слишком много неудачных попыток входа.');
          if (retryAfterS) setLockedUntil(Date.now() + retryAfterS * 1000);
        } else {
          message.error('Неверный логин или пароль');
        }
        return;
      }

      login(data.access_token, data.user);
      navigate('/', { replace: true });
    } catch {
      message.error('Ошибка подключения к серверу');
    } finally {
      setLoading(false);
    }
  };

  const onFinish = (values: LoginForm) => signIn(values.username, values.password);

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #131416 0%, #1D1F23 100%)',
      }}
    >
      <Card
        style={{
          width: 400,
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <Title level={2} style={{ marginBottom: 8 }}>
            Инспектор ИИ
          </Title>
          <Text type="secondary">Автоматическая сверка проектной документации</Text>
        </div>

        {accounts.length > 0 && (
          <>
            <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
              На время экспертизы вход открыт. Выберите роль:
            </Text>
            <Space direction="vertical" style={{ width: '100%' }}>
              {accounts.map((account) => (
                <Button
                  key={account.login}
                  type="primary"
                  size="large"
                  block
                  loading={loading}
                  onClick={() => signIn(account.login, '')}
                >
                  Войти: {ROLE_LABEL[account.role] ?? account.role} · {account.login}
                </Button>
              ))}
            </Space>
            <Divider plain>
              <Text type="secondary">или по паролю</Text>
            </Divider>
          </>
        )}

        <Form
          name="login"
          onFinish={onFinish}
          autoComplete="off"
          layout="vertical"
          size="large"
        >
          <Form.Item
            name="username"
            rules={[{ required: true, message: 'Введите имя пользователя' }]}
          >
            <Input prefix={<UserOutlined />} placeholder="Имя пользователя" />
          </Form.Item>

          <Form.Item
            name="password"
            rules={[{ required: true, message: 'Введите пароль' }]}
          >
            <Input.Password prefix={<LockOutlined />} placeholder="Пароль" />
          </Form.Item>

          <Form.Item>
            <Button type="primary" htmlType="submit" block loading={loading} disabled={lockedIn > 0}>
              {lockedIn > 0 ? `Повторите через ${lockedIn} с` : 'Войти'}
            </Button>
          </Form.Item>
        </Form>

        {DEMO_MODE && (
          <div style={{ marginTop: 24, textAlign: 'center' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Тестовые учётные записи: inspector/inspector или admin/admin
            </Text>
          </div>
        )}
      </Card>
    </div>
  );
};
