import React from 'react';
import { ConfigProvider, theme, App } from 'antd';
import ruRU from 'antd/locale/ru_RU';
import { ThemeContext } from './ThemeContext';

// Основной цвет проекта: все кнопки, ссылки, фокус и выделения берутся из него, синего в интерфейсе нет
const BRAND = '#12988C';

// Одинаковые кнопки и поля ввода во всём проекте: без тени, скругление 8, жирный текст у кнопок
const components = {
  Button: {
    primaryShadow: 'none',
    defaultShadow: 'none',
    dangerShadow: 'none',
    fontWeight: 600,
    borderRadius: 8,
    borderRadiusSM: 8,
    borderRadiusLG: 8,
  },
  Input: { borderRadius: 8, borderRadiusSM: 8, borderRadiusLG: 8 },
  Select: { borderRadius: 8, borderRadiusSM: 8, borderRadiusLG: 8 },
};

const darkTheme = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: BRAND,
    colorInfo: BRAND,
    colorLink: BRAND,
    // Нейтральные серые без синего оттенка: зелёный бренд на них читается лучше, чем на синеватом
    colorBgBase: '#131416',
    colorBgLayout: '#131416',
    colorBgContainer: '#1D1F23',
    colorBgElevated: '#26292E',
    colorFillAlter: '#25282D',
    controlItemBgHover: '#3D4148',
    controlItemBgActive: '#4B5058',
    controlItemBgActiveHover: '#555A63',
    colorBorder: '#4A4F57',
    colorBorderSecondary: '#3A3E44',
    colorText: '#F5F6F7',
    colorTextSecondary: '#C6CACF',
    colorTextTertiary: '#A9AEB5',
    colorTextDescription: '#C6CACF',
    colorTextPlaceholder: '#8E949C',
    colorTextDisabled: '#767C84',
    colorError: '#EF4444',
    colorWarning: '#F59E0B',
    colorSuccess: '#10B981',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif",
    borderRadius: 6,
  },
  components: {
    ...components,
    // Обычные (не основные) кнопки: серые с белым текстом, как «Дозагрузить», а не зелёные при наведении и фокусе
    Button: {
      ...components.Button,
      defaultBg: '#1D1F23',
      defaultColor: '#F1F5F9',
      defaultBorderColor: '#4A4F57',
      defaultHoverBg: '#33373D',
      defaultHoverColor: '#FFFFFF',
      defaultHoverBorderColor: '#6B717B',
      defaultActiveBg: '#3D4148',
      defaultActiveColor: '#FFFFFF',
      defaultActiveBorderColor: '#6B717B',
    },
    // Выбранный и наведённый пункты: светло-серая заливка и белый текст (не зелёный), одинаково в меню, списках и выпадающих меню
    Menu: {
      darkItemBg: 'transparent',
      darkItemSelectedBg: '#4B5058',
      darkItemSelectedColor: '#FFFFFF',
      darkItemHoverBg: '#3D4148',
      darkItemHoverColor: '#FFFFFF',
      darkPopupBg: '#26292E',
      itemSelectedBg: '#4B5058',
      itemSelectedColor: '#FFFFFF',
      itemHoverBg: '#3D4148',
      itemActiveBg: '#4B5058',
    },
    Select: { ...components.Select, optionSelectedBg: '#4B5058', optionSelectedColor: '#FFFFFF', optionActiveBg: '#3D4148' },
  },
};

const lightTheme = {
  algorithm: theme.defaultAlgorithm,
  token: {
    colorPrimary: BRAND,
    colorInfo: BRAND,
    colorLink: BRAND,
    colorBgBase: '#FFFFFF',
    colorBgContainer: '#F8FAFC',
    colorBorder: '#E2E8F0',
    colorText: '#0F172A',
    colorTextSecondary: '#64748B',
    colorError: '#DC2626',
    colorWarning: '#D97706',
    colorSuccess: '#059669',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif",
    borderRadius: 6,
  },
  components,
};

export const AntdConfigProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isDark, setIsDark] = React.useState(false);

  const toggleTheme = () => {
    setIsDark((prev) => !prev);
  };

  React.useEffect(() => {
    document.body.setAttribute('data-theme', isDark ? 'dark' : 'light');
  }, [isDark]);

  return (
    <ThemeContext.Provider value={{ isDark, toggleTheme }}>
      <ConfigProvider theme={isDark ? darkTheme : lightTheme} locale={ruRU}>
        <App>{children}</App>
      </ConfigProvider>
    </ThemeContext.Provider>
  );
};
