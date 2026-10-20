import React from 'react';
import { Typography, theme } from 'antd';
import { TRAINING_PROJECT } from '@/shared/training';
import type { GuideStep } from '@/shared/guide';

/** То, что урок отдаёт учебному экрану. */
export interface SceneProps {
  /** Текущий шаг; после прохождения урока его нет, и экран работает свободно. */
  step?: GuideStep;
  /**
   * Действие на экране: клик или клавиша. `true` — шаг его ждал (или урок уже пройден), экран выполняет действие;
   * `false` — действие не то, экран его игнорирует, а подсказка просит нажать подсвеченное.
   */
  act: (action: string) => boolean;
  /** Подсказка шага: экран сам решает, где её показать (в полном экране она должна быть поверх него). */
  coach: React.ReactNode;
  /** Открыто окно выхода: клавиши экрана молчат. */
  paused: boolean;
  /** Экран отдаёт функцию для Esc: закрывает открытое на нём и возвращает true; если закрывать нечего, false. */
  registerEscape: (close: (() => boolean) | null) => void;
  /** Экран отдаёт функцию для Enter: она выполняет действие, которого урок ждёт на текущем шаге (выбрать, нажать, отправить). */
  registerEnter: (run: (() => void) | null) => void;
  /** Перейти к следующему уроку (например, с дашборда в верификацию). */
  onNext?: () => void;
}

/**
 * Рамка учебного экрана: сверху пометка, что проект учебный, ниже страница нужной высоты в оформлении настоящей.
 * Страница внутри занимает всю рамку и сама прокручивается, как настоящая.
 */
export const SceneFrame: React.FC<{ children: React.ReactNode; height?: number | string }> = ({ children, height = 720 }) => {
  const { token } = theme.useToken();
  return (
    <div style={{ border: `1px solid ${token.colorBorder}`, borderRadius: 12, overflow: 'hidden', background: token.colorBgLayout }}>
      <div style={{ padding: '8px 16px', background: token.colorBgContainer, borderBottom: `1px solid ${token.colorBorder}` }}>
        <span className="badge badge-teal">УЧЕБНЫЙ ПРОЕКТ</span>{' '}
        <span style={{ fontSize: 13, color: token.colorTextSecondary }}>
          {TRAINING_PROJECT}. Ничего не сохраняется и никуда не отправляется, переходы на другие страницы отключены.
        </span>
      </div>
      <div className="training-dim-root" style={{ height, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative', isolation: 'isolate' }}>
        {children}
      </div>
    </div>
  );
};

/** Заголовок страницы, как на настоящих вкладках. */
export const PageTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { token } = theme.useToken();
  return (
    <div style={{ padding: '16px 24px', background: token.colorBgContainer, borderBottom: `1px solid ${token.colorBorder}`, flex: '0 0 auto' }}>
      <Typography.Title level={2} style={{ margin: 0 }}>
        {children}
      </Typography.Title>
    </div>
  );
};
