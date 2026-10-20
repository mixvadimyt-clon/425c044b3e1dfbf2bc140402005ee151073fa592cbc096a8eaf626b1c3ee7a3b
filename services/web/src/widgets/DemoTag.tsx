import React from 'react';
import { useProjects } from '@/app/providers/useProjects';

/**
 * Красная метка рядом с заголовком там, где данные демонстрационные, а сервер работает (разбор дообучения на моках):
 * в явном демо-режиме об этом уже говорит полоса под шапкой, повторять её не нужно.
 */
export const DemoTag: React.FC = () => {
  const { mode } = useProjects();
  if (mode === 'demo') return null;
  return (
    <span className="demo-tag" title="Демонстрационные данные: не с сервера, нигде не сохраняются">
      ДЕМО-ДАННЫЕ
    </span>
  );
};
