import React from 'react';
import { Button, Result } from 'antd';
import { useProjects } from '@/app/providers/useProjects';

/** Вместо страницы, когда сервер недоступен и показывать нечего: ошибка, а не демонстрационные данные. */
export const ApiUnavailable: React.FC = () => {
  const { reload } = useProjects();
  const [retrying, setRetrying] = React.useState(false);

  return (
    <Result
      status="error"
      title="Нет связи с сервером"
      subTitle="Проекты и протоколы не загружены. Проверьте, что сервер запущен, и повторите. Демонстрационные данные не подставляются: решения по ним не были бы настоящими."
      extra={
        <Button
          type="primary"
          loading={retrying}
          onClick={() => {
            setRetrying(true);
            void reload().finally(() => setRetrying(false));
          }}
        >
          Повторить
        </Button>
      }
    />
  );
};
