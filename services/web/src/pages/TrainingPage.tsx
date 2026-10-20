import React from 'react';
import { Button, Card, Modal, Tabs, Typography, theme } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/app/providers/useAuth';
import { trainingLessons } from '@/shared/training';
import { GuidedLesson } from '@/widgets/training/GuidedLesson';

const { Title, Text } = Typography;

/**
 * Обучение: один учебный проект проходит через все вкладки меню своей роли. Каждый урок ведёт «за руку»: подсвечивает
 * нужный элемент учебного экрана, объясняет и ждёт, пока человек сам сделает действие. Прогресс не сохраняется
 * (при каждом заходе с первого урока), учебные экраны не обращаются к серверу.
 */
export const TrainingPage: React.FC = () => {
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const { user } = useAuth();
  const lessons = React.useMemo(() => trainingLessons(user?.role), [user?.role]);
  const [index, setIndex] = React.useState(0);
  const [exitOpen, setExitOpen] = React.useState(false);
  // Вводный экран: правила обучения, и только потом уроки (так подсказка и прокрутка не перекрывают текст)
  const [started, setStarted] = React.useState(false);
  // Окно открыто после последнего урока: в тексте поздравление вместо предупреждения о выходе
  const [finishing, setFinishing] = React.useState(false);
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  // Функция тренажёра для Esc: закрывает открытое в нём (список причин, полный экран) и сообщает, закрыла ли что-то
  const escapeRef = React.useRef<(() => boolean) | null>(null);
  const registerEscape = React.useCallback((close: (() => boolean) | null) => {
    escapeRef.current = close;
  }, []);

  // Выход из урока (Esc): заканчивает урок досрочно, а если урок уже закончен, спрашиваем про выход из обучения
  const exitLessonRef = React.useRef<(() => boolean) | null>(null);
  const registerExitLesson = React.useCallback((exit: (() => boolean) | null) => {
    exitLessonRef.current = exit;
  }, []);

  const lesson = lessons[Math.min(index, lessons.length - 1)];

  // Единственный обработчик Esc на странице: сначала окно выхода («Нет»), потом открытое в тренажёре, иначе спрашиваем про выход
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (exitOpen) {
        setExitOpen(false);
        setFinishing(false);
        return;
      }
      if (escapeRef.current?.()) return;
      if (exitLessonRef.current?.()) return;
      setExitOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [exitOpen]);

  // Новый урок или старт: страница с самого верха, чтобы заголовок и подсказка были на виду
  React.useEffect(() => {
    scrollerRef.current?.scrollTo?.({ top: 0 });
  }, [index, started]);

  if (!lesson) return null;

  const last = index >= lessons.length - 1;
  const cardStyle: React.CSSProperties = {
    borderRadius: 12,
    background: token.colorBgContainer,
    border: `1px solid ${token.colorBorder}`,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          padding: '16px 24px',
          background: token.colorBgContainer,
          borderBottom: `1px solid ${token.colorBorder}`,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <Title level={2} style={{ margin: 0 }}>
          Обучение
        </Title>
        <Button danger onClick={() => setExitOpen(true)}>
          Выйти из обучения
        </Button>
      </div>

      <div ref={scrollerRef} style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {!started ? (
          <div style={{ maxWidth: 'min(1320px, 92%)', margin: '24px auto' }}>
            <Card style={cardStyle} styles={{ body: { padding: 32 } }}>
              <Title level={2} style={{ marginTop: 0, fontSize: 'clamp(28px, 2.2vw, 40px)' }}>
                Как работает обучение
              </Title>
              <ul style={{ paddingLeft: 28, lineHeight: 1.65, fontSize: 'clamp(19px, 1.4vw, 26px)', margin: '0 0 24px' }}>
                <li>
                  Один учебный проект «Комплект 1» проходит через все вкладки меню: настоящие
                  документы, ничего не сохраняется и никуда не отправляется.
                </li>
                <li>
                  Комплект: шесть документов: проектная (ПД), рабочая (РД) и исполнительная (ИД)
                  документация. Вы загрузите его, разберёте три расхождения и завершите проверку.
                </li>
                <li>
                  Читайте подсказку и нажимайте «Далее»: урок сам показывает действия на учебном
                  экране. Клавиша Enter делает то же самое.
                </li>
                <li>
                  Уроков {lessons.length}: {lessons.map(l => l.title).join(', ')}. Их можно
                  проходить в любом порядке.
                </li>
                <li>
                  Выйти можно кнопкой «Выйти из обучения». Из урока можно выйти досрочно кнопкой «Выйти из урока» или клавишей Esc.
                </li>
              </ul>
              <Button type="primary" size="large" style={{ height: 52, fontSize: 18, paddingInline: 32 }} onClick={() => setStarted(true)}>
                Начать обучение
              </Button>
            </Card>
          </div>
        ) : (
          <div
            style={{
              maxWidth: 1600,
              margin: '0 auto',
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr)',
              gap: 12,
              paddingBottom: 12,
            }}
          >
            {/* Уроки по вкладкам меню: переходить можно к любому, в каком порядке удобно */}
            <Card style={cardStyle} styles={{ body: { padding: '0 16px' } }}>
              <Tabs
                activeKey={lesson.id}
                onChange={key => setIndex(lessons.findIndex(l => l.id === key))}
                items={lessons.map((l, i) => ({ key: l.id, label: `${i + 1}. ${l.title}` }))}
              />
            </Card>

            {/* Сюда встаёт сообщение «Урок пройден»: под вкладками уроков и перед названием урока */}
            <div className="training-done-slot" />

            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                Урок {index + 1} из {lessons.length}
              </Text>
              <Title level={4} style={{ margin: '4px 0 16px' }}>
                {lesson.title}
              </Title>

              <GuidedLesson
                key={lesson.id}
                lesson={lesson}
                paused={exitOpen}
                registerEscape={registerEscape}
                registerExitLesson={registerExitLesson}
                onNext={last ? undefined : () => setIndex(i => i + 1)}
                onFinish={
                  last
                    ? () => {
                        setFinishing(true);
                        setExitOpen(true);
                      }
                    : undefined
                }
              />

              {last && (
                <Text type="secondary" style={{ display: 'block', marginTop: 12, fontSize: 13 }}>
                  Всё пройденное можно перечитать в кратком виде: меню пользователя, «Как работать в
                  системе».
                </Text>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Esc обрабатывает страница (keyboard=false), чтобы он не открывал окно заново сразу после закрытия */}
      <Modal
        open={exitOpen}
        title="Закончить обучение?"
        okText="Да"
        cancelText="Нет"
        keyboard={false}
        maskClosable={false}
        onOk={() => navigate('/dashboard')}
        onCancel={() => {
          setExitOpen(false);
          setFinishing(false);
        }}
      >
        <Text>
          {finishing
            ? 'Вы прошли все уроки. Закончить обучение и вернуться на дашборд? Прогресс не сохраняется, при следующем заходе оно начнётся с первого урока.'
            : 'Вы уверены, что хотите выйти из обучения? Прогресс не сохраняется, при следующем заходе оно начнётся с первого урока.'}
        </Text>
      </Modal>
    </div>
  );
};
