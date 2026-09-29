import React from 'react';
import { Alert, Button } from 'antd';

interface Props {
  /** Что не удалось: «Не удалось загрузить модели». */
  title: string;
  /** Ошибка запроса: её текст показывается под заголовком. */
  error?: unknown;
  onRetry: () => void;
  style?: React.CSSProperties;
}

/** Ошибка загрузки данных с кнопкой «Повторить»: один вид для всех страниц, где данные приходят запросом. */
export const QueryErrorAlert: React.FC<Props> = ({ title, error, onRetry, style }) => (
  <Alert
    type="error"
    showIcon
    style={style}
    message={title}
    description={error instanceof Error ? error.message : undefined}
    action={
      <Button size="small" onClick={onRetry}>
        Повторить
      </Button>
    }
  />
);
