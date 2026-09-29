import React from 'react';
import { Typography } from 'antd';
import { useInspectorComment } from '@/api/retrain';

const { Text } = Typography;

/**
 * Комментарий инспектора в строке таблицы. Если он уже известен, показывает его, иначе запрашивает у api сам:
 * строки рисуются только на текущей странице таблицы, поэтому запросов ровно столько, сколько записей на экране.
 */
export const InspectorCommentCell: React.FC<{ findingId?: string; known?: string }> = ({ findingId, known }) => {
  const fetched = useInspectorComment(known ? undefined : findingId);
  return <Text style={{ fontSize: 13 }}>{known || fetched || 'нет'}</Text>;
};
