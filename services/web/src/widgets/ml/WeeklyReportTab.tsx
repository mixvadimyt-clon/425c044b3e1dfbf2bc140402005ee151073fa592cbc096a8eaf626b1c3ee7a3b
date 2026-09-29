import React from 'react';
import { Button, Card, Progress, Skeleton, Space, Table, Typography, theme } from 'antd';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import { isoWeekOf, shiftIsoWeek, useWeeklyReport } from '@/api/ml';
import { formatDateTime } from '@/api/protocols';
import { QueryErrorAlert } from '@/widgets/QueryErrorAlert';
import { InfoHint } from '@/widgets/InfoHint';
import { REJECT_REASON } from '@/shared/statuses';
import { withReasonNames, withoutLongDash } from '@/shared/text';

const { Text } = Typography;

const reasonLabels: Record<string, string> = Object.fromEntries(Object.entries(REJECT_REASON).map(([code, { label }]) => [code, label]));

const Stat: React.FC<{ label: string; value: React.ReactNode; hint?: string; info?: string }> = ({ label, value, hint, info }) => (
  <div>
    <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
      {label}
      {info && <InfoHint label={`Пояснение: ${label}`}>{info}</InfoHint>}
    </Text>
    <Text strong style={{ fontSize: 22 }}>{value}</Text>
    {hint && <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>{hint}</Text>}
  </div>
);

/** Список «название: число» с полосой доли от максимума. */
const Bars: React.FC<{ title: string; entries: Array<[string, number]> }> = ({ title, entries }) => {
  const max = Math.max(1, ...entries.map(([, n]) => n));
  return (
    <div>
      <Text strong style={{ display: 'block', marginBottom: 8 }}>{title}</Text>
      {entries.length === 0 ? (
        <Text type="secondary">Отклонений за неделю нет</Text>
      ) : (
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          {entries.map(([name, count]) => (
            <div key={name}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <Text style={{ fontSize: 13 }}>{name}</Text>
                <Text strong style={{ fontSize: 13 }}>{count}</Text>
              </div>
              <Progress percent={(count / max) * 100} showInfo={false} size="small" />
            </div>
          ))}
        </Space>
      )}
    </div>
  );
};

/** Еженедельный отчёт по дообучению: решения, отклонения по причинам и разделам, параметры с ложными срабатываниями, рекомендации (REQ-ML-06). */
export const WeeklyReportTab: React.FC = () => {
  const { token } = theme.useToken();
  const currentWeek = React.useMemo(() => isoWeekOf(new Date()), []);
  const [week, setWeek] = React.useState(currentWeek);
  const report = useWeeklyReport(week);
  const data = report.data;
  const cardStyle: React.CSSProperties = { borderRadius: 12, background: token.colorBgContainer, border: `1px solid ${token.colorBorder}` };

  const reasons = Object.entries(data?.rejections_by_reason ?? {})
    .map(([code, n]): [string, number] => [code in REJECT_REASON ? REJECT_REASON[code as keyof typeof REJECT_REASON].label : code, n])
    .sort((a, b) => b[1] - a[1]);
  const sections = Object.entries(data?.rejections_by_section ?? {}).sort((a, b) => b[1] - a[1]);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card style={cardStyle}>
        <Space size={8} wrap>
          <Button icon={<LeftOutlined />} onClick={() => setWeek(shiftIsoWeek(week, -1))} aria-label="Предыдущая неделя" />
          <Text strong style={{ fontSize: 15, minWidth: 260, display: 'inline-block', textAlign: 'center' }}>
            Неделя {week}
            {/* period_end сервер отдаёт границей следующей недели (не включительно), поэтому последний день на миллисекунду раньше */}
            {data?.period_start && data.period_end
              ? ` (${formatDateTime(data.period_start).slice(0, 10)} - ${formatDateTime(new Date(Date.parse(data.period_end) - 1).toISOString()).slice(0, 10)})`
              : ''}
          </Text>
          <Button icon={<RightOutlined />} disabled={week >= currentWeek} onClick={() => setWeek(shiftIsoWeek(week, 1))} aria-label="Следующая неделя" />
          {week !== currentWeek && <Button onClick={() => setWeek(currentWeek)}>Текущая неделя</Button>}
        </Space>
      </Card>

      {report.isLoading && (
        <Card style={cardStyle}>
          <Skeleton active paragraph={{ rows: 5 }} />
        </Card>
      )}

      {report.isError && <QueryErrorAlert title="Не удалось построить отчёт" error={report.error} onRetry={() => void report.refetch()} />}

      {data && (
        <>
          <Card style={cardStyle} title={<Text strong style={{ fontSize: 15 }}>Решения инспекторов</Text>}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16 }}>
              <Stat label="Решений всего" value={data.decisions_total ?? 0} />
              <Stat label="Подтверждено" value={data.confirmed ?? 0} />
              <Stat label="Отклонено" value={data.rejected ?? 0} hint={data.decisions_total ? `${Math.round(((data.rejected ?? 0) / data.decisions_total) * 100)} % от решений` : undefined} />
              <Stat label="Отправлено на уточнение" value={data.clarifications ?? 0} />
            </div>
          </Card>

          <Card style={cardStyle} title={<Text strong style={{ fontSize: 15 }}>Набор и модель на конец недели</Text>}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
              <Stat label="Записей ждут куратора" value={data.gold_drafts ?? 0} info="Куратор данных — это ML-инженер: он проверяет записи, пришедшие от инспекторов, и одобряет или исключает их из набора для дообучения." />
              <Stat label="Одобрены, не выпущены" value={data.gold_approved_unreleased ?? 0} />
              <Stat label="Текущая модель" value={data.current_model_version ?? 'нет'} hint={data.current_model_version ? undefined : 'работаем только по правилам'} />
            </div>
          </Card>

          <Card style={cardStyle} title={<Text strong style={{ fontSize: 15 }}>Отклонения</Text>}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 24 }}>
              <Bars title="По причинам" entries={reasons} />
              <Bars title="По разделам" entries={sections} />
            </div>
          </Card>

          <Card style={cardStyle} title={<Text strong style={{ fontSize: 15 }}>Параметры с ложными срабатываниями</Text>}>
            <Table
              rowKey={(row) => row.param_code ?? ''}
              size="middle"
              pagination={false}
              dataSource={data.top_false_positive_params ?? []}
              locale={{ emptyText: 'Ложных срабатываний за неделю нет' }}
              columns={[
                { title: 'Параметр', dataIndex: 'param_code', key: 'param_code', render: (value?: string) => <Text strong>{value ?? 'нет'}</Text> },
                { title: 'Отклонений', dataIndex: 'rejections', key: 'rejections', width: 130 },
                { title: 'Доля ложных', dataIndex: 'fp_rate', key: 'fp_rate', width: 150, render: (value?: number) => (value == null ? 'нет' : `${Math.round(value * 100)} %`) },
              ]}
            />
          </Card>

          <Card style={cardStyle} title={<Text strong style={{ fontSize: 15 }}>Рекомендации</Text>}>
            {(data.recommendations ?? []).length === 0 ? (
              <Text type="secondary">Рекомендаций нет</Text>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {(data.recommendations ?? []).map((line, i) => (
                  <li key={i} style={{ marginBottom: 4 }}>{withReasonNames(withoutLongDash(line), reasonLabels)}</li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </Space>
  );
};
