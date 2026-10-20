import React from 'react';
import { Card, Typography, theme } from 'antd';
import { ArrowRightOutlined } from '@ant-design/icons';
import { highlight } from '@/shared/guide';
import { SceneFrame } from '../guideUi';
import type { SceneProps } from '../guideUi';

const { Text } = Typography;

const FLOW: Array<[string, string]> = [
  ['Загрузка', 'Вы добавляете документы проекта'],
  ['Разбор', 'Система читает документы и сверяет их по матрице'],
  ['Верификация', 'Вы решаете по каждому расхождению'],
  ['Протокол', 'Итог проверки: завершение и выгрузка'],
  ['ИАИС «РиН»', 'Результат уходит во внешнюю систему'],
];

const TERMS: Record<string, Array<[string, string]>> = {
  docs: [
    ['ПД', 'проектная документация: что собираются строить'],
    ['РД', 'рабочая документация: по каким чертежам строят'],
    ['ИД', 'исполнительная документация: что построено (например, акты скрытых работ)'],
  ],
  check: [
    ['Матрица', '132 параметра (M-001…M-132): по каждому система ищет значение в ПД, РД и ИД и сверяет их'],
    ['Кандидат', 'найденное системой расхождение: по нему вы принимаете решение'],
    ['Гипотеза', 'подозрение вне матрицы (свободный поиск): не нарушение, пока вы не сделаете её кандидатом'],
  ],
  status: [
    ['Ожидает', 'решения ещё нет'],
    ['Подтверждено', 'вы признали нарушение'],
    ['Отклонено', 'нарушения нет, причина указана'],
    ['Уточнено', 'нужно уточнение, вывода о нарушении нет'],
    ['Финализирован', 'проверка завершена, результат передан'],
  ],
};

/**
 * Обзор без действий: путь документа по системе и словарь терминов, чтобы дальше уроки не объясняли их на ходу.
 */
export const OverviewScene: React.FC<SceneProps> = ({ step, coach }) => {
  const { token } = theme.useToken();
  const hl = (target: string) => highlight(step, target);
  const cardStyle: React.CSSProperties = { borderRadius: 12, background: token.colorBgContainer, border: `1px solid ${token.colorBorder}` };

  const terms = (key: string, title: string) => (
    <Card className={hl(`terms-${key}`)} data-tt={`terms-${key}`} style={cardStyle} title={<Text strong style={{ fontSize: 15 }}>{title}</Text>}>
      <div style={{ display: 'grid', gap: 10 }}>
        {TERMS[key].map(([term, text]) => (
          <div key={term} style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
            <Text strong style={{ flex: '0 0 120px' }}>
              {term}
            </Text>
            <Text>{text}</Text>
          </div>
        ))}
      </div>
    </Card>
  );

  return (
    <>
      {coach}
      <SceneFrame height="auto">
        <div style={{ padding: 24, display: 'grid', gap: 16 }}>
          <Card className={hl('flow')} data-tt="flow" style={cardStyle} title={<Text strong style={{ fontSize: 15 }}>Путь проверки</Text>}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 8 }}>
              {FLOW.map(([title, text], i) => (
                <React.Fragment key={title}>
                  <div style={{ flex: '1 1 150px', border: `1px solid ${token.colorBorder}`, borderRadius: 8, padding: '10px 12px', minWidth: 140 }}>
                    <Text strong style={{ display: 'block' }}>
                      {i + 1}. {title}
                    </Text>
                    <Text type="secondary" style={{ fontSize: 13 }}>
                      {text}
                    </Text>
                  </div>
                  {i < FLOW.length - 1 && <ArrowRightOutlined style={{ alignSelf: 'center', color: token.colorTextSecondary }} />}
                </React.Fragment>
              ))}
            </div>
          </Card>
          {terms('docs', 'Три стадии документации')}
          {terms('check', 'Как система находит расхождения')}
          {terms('status', 'Статусы решения')}
        </div>
      </SceneFrame>
    </>
  );
};
