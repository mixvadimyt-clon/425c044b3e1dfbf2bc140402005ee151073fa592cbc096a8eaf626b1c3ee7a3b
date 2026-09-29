import React from 'react';
import { App, Layout, Menu, Button, Dropdown, Space, Typography, theme, Tooltip, Select } from 'antd';
import {
  DashboardOutlined,
  FileTextOutlined,
  ExperimentOutlined,
  RobotOutlined,
  SettingOutlined,
  SwapOutlined,
  UserOutlined,
  LogoutOutlined,
  BulbOutlined,
  MenuFoldOutlined,
  QuestionCircleOutlined,
  WarningOutlined,
  MenuUnfoldOutlined,
  CheckSquareOutlined,
  FileProtectOutlined,
} from '@ant-design/icons';
import { useNavigate, useLocation, useSearchParams, Outlet } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../providers/useAuth';
import { useProjects } from '../providers/useProjects';
import { NotificationsBell } from '@/widgets/NotificationsBell';
import { WelcomeModal } from '@/widgets/WelcomeGuide';
import { SystemStatus } from '@/widgets/SystemStatus';
import { ApiUnavailable } from '@/widgets/ApiUnavailable';
import { ThemeContext } from '../providers/ThemeContext';
import { CompletenessBadge } from '@/widgets/CompletenessBadge';
import { TrafficLight } from '@/widgets/TrafficLight';
import { apiClient } from '@/api/client';
import { useOpenAccessAccounts } from '@/api/openAccess';
import type { AuthAccount } from '@/api/openAccess';
import { ROLE_LABEL } from '@/shared/roles';
import { useRetrainItems } from '@/api/retrain';
import { useUnfinalizeRequests } from '@/api/unfinalizeRequests';
import { retrainProjectIds as retrainProjectIdsOf } from '@/shared/retrainQueue';
import { projectsWithOpenRollbackRequest } from '@/shared/projects';

const { Header, Sider, Content } = Layout;
const { Text } = Typography;

const TOGGLE_KEY = '__toggle';
const COMPACT_MAX_WIDTH = 1599;
const NEW_PROJECT_VALUE = '__new';
// Страницы, которые работают с выбранным проектом
const PROJECT_PAGES = ['/verification', '/protocol'];

export const WorkspaceLayout: React.FC = () => {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, login, logout } = useAuth();
  const queryClient = useQueryClient();
  const { isDark, toggleTheme } = React.useContext(ThemeContext);
  const [collapsed, setCollapsed] = React.useState(
    () => window.matchMedia(`(max-width: ${COMPACT_MAX_WIDTH}px)`).matches,
  );
  const { token } = theme.useToken();
  const [searchParams] = useSearchParams();
  const { projects, selectedProjectId, selectProject, mode, reload, source } = useProjects();
  const [retrying, setRetrying] = React.useState(false);
  // Всё, что не «данные сервера», видно на любой странице: демо-режим, нет связи, устаревшие данные
  const strip = mode !== 'live';

  const isAdmin = user?.role === 'ADMIN';
  const isProjectPage = PROJECT_PAGES.includes(location.pathname);
  const isVerificationPage = location.pathname === '/verification';
  const isRetrainMode = searchParams.get('mode') === 'retrain';
  const objectFromUrl = searchParams.get('object');

  // Администратор: в верификации — записи для дообучения (проекты, где есть отклонённые или подтверждённые
  // инспектором записи, ждущие решения куратора), в протоколе — финализированные проекты, чей протокол можно откатить
  const retrain = useRetrainItems(isAdmin && source === 'api');
  const retrainProjectIds = React.useMemo(() => retrainProjectIdsOf(retrain.items), [retrain.items]);
  // Протокол: только проекты, где инспектор попросил откат — иначе список финализированных длинный, и в нём легко открыть не тот
  const rollbackRequests = useUnfinalizeRequests(isAdmin && source === 'api' && !isVerificationPage);
  const rollbackRequestProjectIds = React.useMemo(() => new Set((rollbackRequests.data ?? []).map((r) => r.object_id)), [rollbackRequests.data]);
  const listedProjects = isAdmin
    ? isVerificationPage
      ? retrainProjectIds.flatMap((id) => projects.filter((p) => p.id === id))
      : projectsWithOpenRollbackRequest(projects, rollbackRequestProjectIds)
    : projects;
  const currentProjectId = isAdmin && isVerificationPage ? objectFromUrl : selectedProjectId;
  const selectedInList = !isAdmin || listedProjects.some((p) => p.id === currentProjectId);

  // Открыли верификацию или протокол проекта — запоминаем его в выпадающем списке
  React.useEffect(() => {
    if (isProjectPage && !isRetrainMode && objectFromUrl) {
      selectProject(objectFromUrl);
    }
  }, [isProjectPage, isRetrainMode, objectFromUrl, selectProject]);

  const handleProjectChange = (value: string) => {
    if (value === NEW_PROJECT_VALUE) {
      navigate('/upload?new=true');
      return;
    }
    selectProject(value);
    navigate(isRetrainMode ? `/verification?mode=retrain&object=${value}` : `${location.pathname}?object=${value}`);
  };

  // Верификация администратора — разбор запросов на дообучение: открываем проект, где есть ждущие решения
  const retrainTarget = (preferred: string | null | undefined) => (preferred && retrainProjectIds.includes(preferred) ? preferred : retrainProjectIds[0]);
  React.useEffect(() => {
    if (!isAdmin || source !== 'api' || !isVerificationPage || isRetrainMode || retrain.isLoading) return;
    const target = retrainTarget(objectFromUrl);
    if (!target) message.info('Нет записей, ждущих решения: все записи уже разобраны');
    navigate(target ? `/verification?mode=retrain&object=${target}` : '/dashboard', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, source, isVerificationPage, isRetrainMode, retrain.isLoading, objectFromUrl, retrainProjectIds]);

  // Из меню в верификацию и протокол идём уже с выбранным проектом, без возврата через дашборд
  const handleMenuNavigate = (key: string) => {
    if (isAdmin && key === '/verification') {
      const target = retrainTarget(selectedProjectId);
      if (!target) message.info('Нет записей, ждущих решения: все записи уже разобраны');
      navigate(target ? `/verification?mode=retrain&object=${target}` : '/dashboard');
      return;
    }
    if (PROJECT_PAGES.includes(key) && selectedProjectId) {
      navigate(`${key}?object=${selectedProjectId}`);
      return;
    }
    navigate(key);
  };

  // На экранах уже 1600 px меню по умолчанию свёрнуто, чтобы рабочей области хватало места.
  // Ручное переключение работает как обычно и сбрасывается только при переходе через границу.
  React.useEffect(() => {
    const media = window.matchMedia(`(max-width: ${COMPACT_MAX_WIDTH}px)`);
    const onChange = (event: MediaQueryListEvent) => setCollapsed(event.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const [helpOpen, setHelpOpen] = React.useState(false);

  // Открытый вход на время экспертизы: роль можно сменить, не возвращаясь на страницу входа
  const openAccounts = useOpenAccessAccounts(source === 'api').data ?? [];
  const otherAccounts = openAccounts.filter((account) => account.role !== user?.role);
  const switchRole = async (account: AuthAccount) => {
    try {
      const { data, error } = await apiClient.POST('/api/v1/auth/login', { body: { login: account.login, password: '' } });
      if (error || !data) {
        message.error('Не удалось сменить роль');
        return;
      }
      // Данные прежней роли (проекты, уведомления, списки) не должны остаться на экране новой
      queryClient.clear();
      login(data.access_token, data.user);
      navigate('/dashboard', { replace: true });
    } catch {
      message.error('Ошибка подключения к серверу');
    }
  };

  const userMenuItems = [
    {
      key: 'help',
      icon: <QuestionCircleOutlined />,
      label: 'Как работать в системе',
      onClick: () => setHelpOpen(true),
    },
    ...(otherAccounts.length > 0
      ? [
          {
            key: 'switch-role',
            icon: <SwapOutlined />,
            label: 'Сменить роль',
            children: otherAccounts.map((account) => ({
              key: `role-${account.login}`,
              label: ROLE_LABEL[account.role],
              onClick: () => void switchRole(account),
            })),
          },
        ]
      : []),
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: 'Выйти',
      onClick: handleLogout,
    },
  ];

  const sidebarMenuItems = [
    {
      key: '/dashboard',
      icon: <DashboardOutlined />,
      label: 'Дашборд',
    },
    {
      key: '/upload',
      icon: <FileTextOutlined />,
      label: 'Загрузка',
    },
    {
      key: '/verification',
      icon: <CheckSquareOutlined />,
      label: isAdmin ? 'Записи для дообучения' : 'Верификация',
    },
    {
      key: '/protocol',
      icon: <FileProtectOutlined />,
      label: 'Протокол',
    },
  ];

  const toggleMenuItem = {
    key: TOGGLE_KEY,
    icon: collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />,
    label: collapsed ? 'Развернуть' : 'Свернуть',
    onClick: () => setCollapsed((value) => !value),
  };

  // Администратор документы не загружает: у него дашборд, верификация (запросы на дообучение), протоколы финализированных проектов и администрирование
  if (isAdmin) {
    for (let i = sidebarMenuItems.length - 1; i >= 0; i--) {
      if (sidebarMenuItems[i].key === '/upload') sidebarMenuItems.splice(i, 1);
    }
    sidebarMenuItems.push({
      key: '/admin',
      icon: <SettingOutlined />,
      label: 'Администрирование',
    });
  }

  // ML-инженер работает с данными дообучения и экспериментами: загрузка, верификация и протокол это инструменты инспектора
  if (user?.role === 'ML_ENGINEER') {
    for (let i = sidebarMenuItems.length - 1; i >= 0; i--) {
      if (['/upload', '/verification', '/protocol'].includes(sidebarMenuItems[i].key)) sidebarMenuItems.splice(i, 1);
    }
  }

  // Обмен с внешней ИС: забор пакетов документов и создание проверок из них: работа инспектора и руководителя.
  // Администратор документы не загружает, а состояние обмена видит в индикаторе шапки.
  if (user?.role === 'INSPECTOR' || user?.role === 'SUPERVISOR') {
    sidebarMenuItems.push({ key: '/integration', icon: <SwapOutlined />, label: 'Интеграция' });
  }

  // Дообучение (записи набора, версии, модели, отчёт): ML-инженеру, администратору и руководителю (только чтение)
  if (isAdmin || user?.role === 'ML_ENGINEER' || user?.role === 'SUPERVISOR') {
    // У ML-инженера здесь ещё записи набора (сам разбор дообучения), у остальных только версии, модели и отчёт
    sidebarMenuItems.push({ key: '/ml', icon: <RobotOutlined />, label: user?.role === 'ML_ENGINEER' ? 'Дообучение' : 'Версии и модели' });
  }

  // MLflow с экспериментами и моделями нужен администратору и ML-инженеру. Адрес /mlflow занят прокси
  // (там сам MLflow), поэтому страница живёт на /experiments
  if (isAdmin || user?.role === 'ML_ENGINEER') {
    sidebarMenuItems.push({ key: '/experiments', icon: <ExperimentOutlined />, label: 'MLflow' });
  }

  return (
    <Layout style={{ minHeight: '100vh', ['--strip-h' as string]: strip ? '36px' : '0px' }}>
      <Header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 24px',
          background: token.colorBgContainer,
          borderBottom: `1px solid ${token.colorBorder}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {/* Ширина блока логотипа привязана к боковому меню, чтобы список проектов начинался вровень с содержимым страницы */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto', width: collapsed ? 200 : 232 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 6,
                background: 'linear-gradient(135deg, #2DD4BF 0%, #12988C 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 700,
                color: '#0F172A',
              }}
            >
              ИИ
            </div>
            <Text strong style={{ fontSize: 16 }}>
              Инспектор ИИ
            </Text>
          </div>

          {isProjectPage && (!isRetrainMode || isAdmin) && mode !== 'offline' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Text type="secondary" style={{ whiteSpace: 'nowrap' }}>
                Проект
              </Text>
              <Select
                value={selectedInList ? currentProjectId : undefined}
                placeholder={isAdmin ? (isVerificationPage ? 'Выберите проект с запросами' : 'Выберите проект с запросом на откат') : 'Выберите проект'}
                onChange={handleProjectChange}
                className="project-select-wide"
                classNames={{ popup: { root: 'project-select-wide-dropdown' } }}
                style={{ width: 'clamp(170px, 20vw, 300px)' }}
                popupMatchSelectWidth={420}
                showSearch
                filterOption={(input, option) => String(option?.searchText ?? '').toLowerCase().includes(input.trim().toLowerCase())}
                notFoundContent={
                  listedProjects.length === 0
                    ? isAdmin
                      ? isVerificationPage
                        ? 'Нет проектов с записями для дообучения'
                        : 'Нет проектов с запросом на откат'
                      : 'Проектов пока нет'
                    : 'Проектов с таким названием нет'
                }
                options={[
                  ...listedProjects.map((project) => ({
                    value: project.id,
                    searchText: project.name,
                    label: (
                      <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                        {!isAdmin && <TrafficLight indicator={project.indicator} />}
                        {project.name}
                      </span>
                    ),
                  })),
                  ...(isAdmin ? [] : [{ value: NEW_PROJECT_VALUE, searchText: 'добавить новый проект', label: '+ Добавить новый проект' }]),
                ]}
              />
              {!isAdmin && <CompletenessBadge processId={projects.find((p) => p.id === selectedProjectId)?.processId} />}
            </div>
          )}
        </div>

        <Space size="large">
          <SystemStatus />
          <Tooltip title={isDark ? 'Светлая тема' : 'Тёмная тема'}>
            <Button
              type="text"
              icon={<BulbOutlined />}
              aria-label={isDark ? 'Светлая тема' : 'Тёмная тема'}
              onClick={toggleTheme}
            />
          </Tooltip>

          <NotificationsBell enabled={mode === 'live'} />

          <Dropdown menu={{ items: userMenuItems }} placement="bottomRight">
            <Button type="text" className="header-user-btn" icon={<UserOutlined />}>
              {user?.full_name || user?.login}
            </Button>
          </Dropdown>
        </Space>
      </Header>

      {strip && (
        <div className={`demo-strip demo-strip-${mode}`} role="alert">
          <span>
            <WarningOutlined style={{ marginRight: 8 }} />
            {mode === 'demo' && (
              <>
                <b>ДЕМО-ДАННЫЕ</b> : режим показа без сервера: проекты и решения не настоящие и нигде не сохраняются
              </>
            )}
            {mode === 'offline' && (
              <>
                <b>API НЕДОСТУПЕН</b> : нет связи с сервером, данные не показываются, чтобы не подменять их демонстрационными
              </>
            )}
            {mode === 'stale' && (
              <>
                <b>НЕТ СВЯЗИ С СЕРВЕРОМ</b> : показаны последние загруженные данные, новые решения могут не сохраниться
              </>
            )}
          </span>
          {mode !== 'demo' && (
            <Button
              size="small"
              loading={retrying}
              onClick={() => {
                setRetrying(true);
                void reload().finally(() => setRetrying(false));
              }}
            >
              Повторить
            </Button>
          )}
        </div>
      )}

      <Layout>
        <Sider
          className="app-sider"
          width={240}
          collapsedWidth={80}
          collapsible
          collapsed={collapsed}
          onCollapse={setCollapsed}
          trigger={null}
          style={{
            background: token.colorBgContainer,
            borderRight: `1px solid ${token.colorBorder}`,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <Menu
            mode="inline"
            selectedKeys={[location.pathname]}
            items={[toggleMenuItem, { type: 'divider' }, ...sidebarMenuItems]}
            onClick={({ key }) => {
              if (key !== TOGGLE_KEY) handleMenuNavigate(key);
            }}
            style={{ background: 'transparent', border: 'none', flex: 1 }}
          />
        </Sider>

        <Layout>
          <Content
            className={location.pathname === '/verification' ? 'app-content app-content-full' : 'app-content'}
            style={{ background: token.colorBgContainer }}
          >
            {mode === 'offline' ? <ApiUnavailable /> : <Outlet />}
            <WelcomeModal open={helpOpen} onClose={() => setHelpOpen(false)} />
          </Content>
        </Layout>
      </Layout>
    </Layout>
  );
};
