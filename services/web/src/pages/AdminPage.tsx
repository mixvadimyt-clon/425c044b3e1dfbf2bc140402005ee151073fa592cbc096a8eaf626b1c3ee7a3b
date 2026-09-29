import React from 'react';
import { Card, Tabs, Table, Switch, Button, Space, Typography, theme, Modal, Input, Tooltip, App, Select, Form, InputNumber, DatePicker } from 'antd';
import { useSearchParams } from 'react-router-dom';
import { useProjects } from '@/app/providers/useProjects';
import { auditDetailsOf, auditObjectOf, fetchAuditAll, useAuditPage } from '@/api/audit';
import type { AuditEntry, AuditFilters } from '@/api/audit';
import { auditToCsv } from '@/shared/auditCsv';
import { formatDateTime } from '@/api/protocols';
import { DeleteOutlined, DownloadOutlined, PlusOutlined, SearchOutlined, EditOutlined, HistoryOutlined } from '@ant-design/icons';
import { StatusPill } from '@/widgets/StatusPill';
import {
  useMatrixParams,
  useMatrixVersions,
  useCreateParam,
  useSetParamsActive,
  useUpdateParam,
  useDeactivateParam,
  useNormativeDocs,
  useCreateNormativeDoc,
  useUpdateNormativeDoc,
  useDeactivateNormativeDoc,
  useLogicalRules,
  useCreateLogicalRule,
  useUpdateLogicalRule,
  useDeactivateLogicalRule,
} from '@/api/matrix';
import type { MatrixParam, MatrixParamInput, NormativeDoc, NormativeDocInput, LogicalRule, LogicalRuleInput } from '@/api/matrix';

const { Title, Text } = Typography;

const REVIEW_PRIORITY_LABEL: Record<string, string> = { HIGH: 'Высокий', MEDIUM: 'Средний', LOW: 'Низкий' };
const DATA_TYPE_LABEL: Record<string, string> = { number: 'Число', string: 'Строка', boolean: 'Да/нет', coordinate: 'Координата', enum: 'Список значений' };

/** Пороги параметра зависят от типа: число — min/max, строка — regex, список — enum_values. */
/** regex_pattern — способ извлечения значения (ML), не зависит от типа и порогов (docs/domain/matrix.md);
    показываем его всегда, чтобы форма не роняла сохранённое значение при типах number/coordinate/enum. */
const ParamThresholdFields: React.FC = () => {
  const dataType = Form.useWatch('data_type');
  return (
    <>
      {(dataType === 'number' || dataType === 'coordinate') && (
        <Space.Compact style={{ width: '100%' }}>
          <Form.Item name="min_value" label="Минимум" style={{ width: '50%' }}>
            <InputNumber style={{ width: '100%' }} placeholder="без ограничения" />
          </Form.Item>
          <Form.Item name="max_value" label="Максимум" style={{ width: '50%' }}>
            <InputNumber style={{ width: '100%' }} placeholder="без ограничения" />
          </Form.Item>
        </Space.Compact>
      )}
      {dataType === 'enum' && (
        <Form.Item name="enum_values" label="Допустимые значения (по порядку)">
          <Select mode="tags" placeholder="например B15, B20, B25, B30" tokenSeparators={[',']} />
        </Form.Item>
      )}
      <Form.Item name="regex_pattern" label="Регулярное выражение для извлечения (Python)">
        <Input placeholder="например (?i)площадь\s+застройки\D{0,40}(\d+)" />
      </Form.Item>
    </>
  );
};

const ParamModal: React.FC<{ open: boolean; initial?: MatrixParam; onClose: () => void }> = ({ open, initial, onClose }) => {
  const [form] = Form.useForm<MatrixParamInput>();
  const { message } = App.useApp();
  const createParam = useCreateParam();
  const updateParam = useUpdateParam();

  React.useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (initial) form.setFieldsValue(initial);
  }, [open, initial, form]);

  const handleSubmit = async () => {
    const values = await form.validateFields();
    try {
      if (initial) {
        await updateParam.mutateAsync({ id: initial.id, body: values });
        message.success('Параметр изменён, создана новая версия матрицы');
      } else {
        await createParam.mutateAsync(values);
        message.success('Параметр добавлен, создана новая версия матрицы');
      }
      onClose();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Не удалось сохранить параметр');
    }
  };

  return (
    <Modal
      title={initial ? `Изменить параметр ${initial.code}` : 'Добавить параметр'}
      open={open}
      onOk={handleSubmit}
      onCancel={onClose}
      okText="Сохранить"
      cancelText="Отмена"
      confirmLoading={createParam.isPending || updateParam.isPending}
      width={640}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" initialValues={{ data_type: 'number', review_priority: 'MEDIUM', is_active: true }}>
        <Space.Compact style={{ width: '100%' }}>
          <Form.Item name="code" label="Код" rules={[{ required: true, message: 'Обязательно' }]} style={{ width: '35%' }}>
            <Input placeholder="M-079" />
          </Form.Item>
          <Form.Item name="external_code" label="Код организаторов" style={{ width: '35%' }}>
            <Input placeholder="KR-079" />
          </Form.Item>
          <Form.Item name="section" label="Раздел" rules={[{ required: true, message: 'Обязательно' }]} style={{ width: '30%' }}>
            <Input placeholder="КР" />
          </Form.Item>
        </Space.Compact>
        <Form.Item name="parameter_name" label="Название" rules={[{ required: true, message: 'Обязательно' }]}>
          <Input placeholder="Класс прочности бетона" />
        </Form.Item>
        <Space.Compact style={{ width: '100%' }}>
          <Form.Item name="unit" label="Единица измерения" style={{ width: '33%' }}>
            <Input placeholder="м²" />
          </Form.Item>
          <Form.Item name="data_type" label="Тип значения" rules={[{ required: true }]} style={{ width: '33%' }}>
            <Select options={Object.entries(DATA_TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
          </Form.Item>
          <Form.Item name="review_priority" label="Приоритет проверки" rules={[{ required: true }]} style={{ width: '34%' }}>
            <Select options={Object.entries(REVIEW_PRIORITY_LABEL).map(([value, label]) => ({ value, label }))} />
          </Form.Item>
        </Space.Compact>
        <ParamThresholdFields />
        <Form.Item name="semantic_anchors" label="Фразы-якоря для поиска">
          <Select mode="tags" placeholder="например площадь застройки, пятно застройки" tokenSeparators={[',']} />
        </Form.Item>
        <Space.Compact style={{ width: '100%' }}>
          <Form.Item name="source_pd" label="Источник в ПД" style={{ width: '33%' }}>
            <Input />
          </Form.Item>
          <Form.Item name="source_rd" label="Источник в РД" style={{ width: '33%' }}>
            <Input />
          </Form.Item>
          <Form.Item name="source_id" label="Источник в ИД" style={{ width: '34%' }}>
            <Input />
          </Form.Item>
        </Space.Compact>
        <Space.Compact style={{ width: '100%' }}>
          <Form.Item name="sp_reference" label="СП" style={{ width: '33%' }}>
            <Input />
          </Form.Item>
          <Form.Item name="gost_reference" label="ГОСТ" style={{ width: '33%' }}>
            <Input />
          </Form.Item>
          <Form.Item name="fz_reference" label="ФЗ" style={{ width: '34%' }}>
            <Input />
          </Form.Item>
        </Space.Compact>
        <Form.Item name="trigger_logic" label="Условие срабатывания">
          <Input placeholder="например: понижение класса" />
        </Form.Item>
      </Form>
    </Modal>
  );
};

const ParamsTab: React.FC = () => {
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const [query, setQuery] = React.useState('');
  const [sectionFilter, setSectionFilter] = React.useState<string | undefined>(undefined);
  const [activeFilter, setActiveFilter] = React.useState<boolean | undefined>(undefined);
  const [modalState, setModalState] = React.useState<{ open: boolean; param?: MatrixParam }>({ open: false });
  const [versionsOpen, setVersionsOpen] = React.useState(false);

  const paramsQuery = useMatrixParams({ q: query || undefined, section: sectionFilter, is_active: activeFilter });
  const allParamsQuery = useMatrixParams({});
  const versionsQuery = useMatrixVersions();
  const deactivateParam = useDeactivateParam();
  const updateParam = useUpdateParam();
  const setParamsActive = useSetParamsActive();
  const [enablingAll, setEnablingAll] = React.useState(false);

  const params = React.useMemo(() => paramsQuery.data ?? [], [paramsQuery.data]);
  const sections = React.useMemo(() => Array.from(new Set((allParamsQuery.data ?? []).map((p) => p.section))).sort(), [allParamsQuery.data]);
  // Кнопка «Включить/Выключить все» действует на выбранный раздел, а без фильтра — на всю матрицу
  const scopeParams = React.useMemo(
    () => (allParamsQuery.data ?? []).filter((p) => !sectionFilter || p.section === sectionFilter),
    [allParamsQuery.data, sectionFilter]
  );
  const inactiveCount = React.useMemo(() => scopeParams.filter((p) => !p.is_active).length, [scopeParams]);
  const activeCount = React.useMemo(() => scopeParams.filter((p) => p.is_active).length, [scopeParams]);
  const toggleAllIsEnable = inactiveCount > 0;
  const toggleAllCount = toggleAllIsEnable ? inactiveCount : activeCount;

  const handleToggleActive = async (param: MatrixParam, active: boolean) => {
    try {
      if (active) {
        await updateParam.mutateAsync({ id: param.id, body: { ...param, is_active: true } });
      } else {
        await deactivateParam.mutateAsync(param.id);
      }
    } catch {
      message.error('Не удалось изменить параметр');
    }
  };

  // Одна кнопка на оба направления: пока есть выключенные — включает их;
  // когда все активны — тем же местом выключает все параметры матрицы разом.
  const handleToggleAll = () => {
    const all = scopeParams;
    const inactive = all.filter((p) => !p.is_active);
    const turningOn = inactive.length > 0;
    const targets = turningOn ? inactive : all.filter((p) => p.is_active);
    if (targets.length === 0) return;
    Modal.confirm({
      title: `${turningOn ? 'Включить' : 'Выключить'} все параметры${sectionFilter ? ` раздела ${sectionFilter}` : ''}?`,
      content: turningOn
        ? `Будет активировано ${targets.length} отключённых параметров${sectionFilter ? ` раздела ${sectionFilter}` : ' матрицы'}.`
        : `Будет отключено ${targets.length} активных параметров${sectionFilter ? ` раздела ${sectionFilter}` : ' матрицы'}.`,
      okText: turningOn ? 'Включить все' : 'Выключить все',
      cancelText: 'Отмена',
      onOk: async () => {
        setEnablingAll(true);
        try {
          await setParamsActive.mutateAsync({ params: targets, active: turningOn });
        } catch {
          message.error(turningOn ? 'Не удалось включить часть параметров' : 'Не удалось выключить часть параметров');
        } finally {
          setEnablingAll(false);
        }
      },
    });
  };

  const columns = [
    { title: 'Код', dataIndex: 'code', key: 'code', width: 90, render: (v: string) => <Text strong style={{ fontSize: 13 }}>{v}</Text> },
    { title: 'Раздел', dataIndex: 'section', key: 'section', width: 90 },
    { title: 'Название', dataIndex: 'parameter_name', key: 'parameter_name' },
    { title: 'Тип', dataIndex: 'data_type', key: 'data_type', width: 110, render: (v: string) => DATA_TYPE_LABEL[v] ?? v },
    {
      title: 'Приоритет',
      dataIndex: 'review_priority',
      key: 'review_priority',
      width: 110,
      render: (v: string) => {
        const tone = v === 'HIGH' ? 'error' : v === 'MEDIUM' ? 'warning' : 'default';
        return <StatusPill tone={tone}>{REVIEW_PRIORITY_LABEL[v] ?? v}</StatusPill>;
      },
    },
    {
      title: 'Порог / формат',
      key: 'threshold',
      width: 220,
      render: (_: unknown, p: MatrixParam) => {
        if (p.data_type === 'enum') return <Text style={{ fontSize: 12 }}>{(p.enum_values ?? []).join(' → ')}</Text>;
        if (p.min_value != null || p.max_value != null) return <Text style={{ fontSize: 12 }}>{p.min_value ?? '−∞'} … {p.max_value ?? '+∞'}</Text>;
        if (p.regex_pattern) return <Text code style={{ fontSize: 11 }}>{p.regex_pattern}</Text>;
        return <Text type="secondary">нет</Text>;
      },
    },
    {
      title: 'Активен',
      dataIndex: 'is_active',
      key: 'is_active',
      width: 90,
      render: (active: boolean, record: MatrixParam) => <Switch checked={active} onChange={(checked) => handleToggleActive(record, checked)} />,
    },
    {
      title: 'Действия',
      key: 'actions',
      width: 60,
      render: (_: unknown, record: MatrixParam) => (
        <Tooltip title="Изменить">
          <Button type="text" icon={<EditOutlined />} aria-label="Изменить параметр" title="Изменить параметр" onClick={() => setModalState({ open: true, param: record })} />
        </Tooltip>
      ),
    },
  ];

  return (
    <Card
      title={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', whiteSpace: 'normal' }}>
          <Text strong style={{ fontSize: 15 }}>Параметры верификации</Text>
          <Space wrap>
            <Button icon={<HistoryOutlined />} onClick={() => setVersionsOpen(true)}>
              История версий{versionsQuery.data ? ` (${versionsQuery.data.length})` : ''}
            </Button>
            <Button onClick={handleToggleAll} loading={enablingAll} disabled={toggleAllCount === 0}>
              {toggleAllIsEnable ? 'Включить' : 'Выключить'} все параметры{sectionFilter ? ` раздела ${sectionFilter}` : ''}{toggleAllCount ? ` (${toggleAllCount})` : ''}
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalState({ open: true })}>
              Добавить параметр
            </Button>
          </Space>
        </div>
      }
      style={{ borderRadius: 12, background: token.colorBgContainer, border: `1px solid ${token.colorBorder}` }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
        <Input
          allowClear
          size="large"
          prefix={<SearchOutlined />}
          placeholder="Поиск по коду или названию, например M-055 или бетон"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: '1 1 320px', maxWidth: 420 }}
        />
        <Select
          allowClear
          placeholder="Раздел"
          size="large"
          value={sectionFilter}
          onChange={setSectionFilter}
          options={sections.map((s) => ({ value: s, label: s }))}
          style={{ width: 140 }}
        />
        <Select
          allowClear
          placeholder="Активность"
          size="large"
          value={activeFilter}
          onChange={setActiveFilter}
          options={[
            { value: true, label: 'Активные' },
            { value: false, label: 'Отключённые' },
          ]}
          style={{ width: 160 }}
        />
        <Text type="secondary">Показано {params.length} из 132</Text>
      </div>
      <Table
        columns={columns}
        dataSource={params}
        rowKey="id"
        loading={paramsQuery.isLoading}
        pagination={{ defaultPageSize: 20, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'] }}
        scroll={{ x: 960 }}
        tableLayout="auto"
        locale={{ emptyText: query || sectionFilter || activeFilter !== undefined ? 'По вашему запросу параметры не найдены' : 'Нет параметров' }}
      />
      <ParamModal open={modalState.open} initial={modalState.param} onClose={() => setModalState({ open: false })} />
      <Modal title="История версий матрицы" open={versionsOpen} onCancel={() => setVersionsOpen(false)} footer={null}>
        <Table
          size="small"
          rowKey="version"
          dataSource={versionsQuery.data ?? []}
          loading={versionsQuery.isLoading}
          pagination={false}
          columns={[
            { title: 'Версия', dataIndex: 'version', key: 'version' },
            { title: 'Параметров', dataIndex: 'params_count', key: 'params_count', width: 100 },
            { title: 'Комментарий', dataIndex: 'comment', key: 'comment' },
            { title: 'Дата', dataIndex: 'created_at', key: 'created_at', width: 160, render: (v: string) => new Date(v).toLocaleString('ru-RU') },
          ]}
        />
      </Modal>
    </Card>
  );
};

const NormativeDocModal: React.FC<{ open: boolean; initial?: NormativeDoc; onClose: () => void }> = ({ open, initial, onClose }) => {
  const [form] = Form.useForm<NormativeDocInput>();
  const { message } = App.useApp();
  const createDoc = useCreateNormativeDoc();
  const updateDoc = useUpdateNormativeDoc();

  React.useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (initial) form.setFieldsValue(initial);
  }, [open, initial, form]);

  const handleSubmit = async () => {
    const values = await form.validateFields();
    try {
      if (initial) {
        await updateDoc.mutateAsync({ id: initial.id, body: values });
        message.success('Документ изменён');
      } else {
        await createDoc.mutateAsync(values);
        message.success('Документ добавлен');
      }
      onClose();
    } catch {
      message.error('Не удалось сохранить документ');
    }
  };

  return (
    <Modal
      title={initial ? 'Изменить нормативный документ' : 'Добавить нормативный документ'}
      open={open}
      onOk={handleSubmit}
      onCancel={onClose}
      okText="Сохранить"
      cancelText="Отмена"
      confirmLoading={createDoc.isPending || updateDoc.isPending}
      destroyOnHidden
    >
      <Form form={form} layout="vertical">
        <Form.Item name="document_name" label="Название" rules={[{ required: true, message: 'Обязательно' }]}>
          <Input placeholder="СП 63.13330.2018" />
        </Form.Item>
        <Form.Item name="document_number" label="Номер" rules={[{ required: true, message: 'Обязательно' }]}>
          <Input placeholder="63.13330.2018" />
        </Form.Item>
        <Space.Compact style={{ width: '100%' }}>
          <Form.Item name="section" label="Раздел" style={{ width: '50%' }}>
            <Input placeholder="КР" />
          </Form.Item>
          <Form.Item name="parameter_name" label="Параметр" style={{ width: '50%' }}>
            <Input placeholder="Класс бетона" />
          </Form.Item>
        </Space.Compact>
        <Space.Compact style={{ width: '100%' }}>
          <Form.Item name="min_value" label="Минимум" style={{ width: '50%' }}>
            <InputNumber style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="max_value" label="Максимум" style={{ width: '50%' }}>
            <InputNumber style={{ width: '100%' }} />
          </Form.Item>
        </Space.Compact>
      </Form>
    </Modal>
  );
};

const NormativeDocsTab: React.FC = () => {
  const { message, modal } = App.useApp();
  const { token } = theme.useToken();
  const docsQuery = useNormativeDocs();
  const deactivateDoc = useDeactivateNormativeDoc();
  const [modalState, setModalState] = React.useState<{ open: boolean; doc?: NormativeDoc }>({ open: false });
  const [query, setQuery] = React.useState('');

  const docs = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const items = docsQuery.data ?? [];
    if (!q) return items;
    return items.filter((d) => [d.document_name, d.document_number, d.section, d.parameter_name].join(' ').toLowerCase().includes(q));
  }, [docsQuery.data, query]);

  const handleDelete = (doc: NormativeDoc) => {
    modal.confirm({
      title: `Деактивировать «${doc.document_name}»?`,
      okText: 'Деактивировать',
      cancelText: 'Отмена',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await deactivateDoc.mutateAsync(doc.id);
          message.success('Документ деактивирован');
        } catch {
          message.error('Не удалось деактивировать документ');
        }
      },
    });
  };

  const columns = [
    { title: 'Документ', dataIndex: 'document_name', key: 'document_name' },
    { title: 'Номер', dataIndex: 'document_number', key: 'document_number', width: 180 },
    { title: 'Раздел', dataIndex: 'section', key: 'section', width: 100 },
    { title: 'Параметр', dataIndex: 'parameter_name', key: 'parameter_name', width: 200 },
    {
      title: 'Действует',
      key: 'effective',
      width: 200,
      render: (_: unknown, d: NormativeDoc) => `${d.effective_from ? `с ${d.effective_from}` : 'без даты начала'}, ${d.effective_to ? `по ${d.effective_to}` : 'бессрочно'}`,
    },
    {
      title: 'Действия',
      key: 'actions',
      width: 100,
      render: (_: unknown, record: NormativeDoc) => (
        <Space>
          <Tooltip title="Изменить">
            <Button type="text" icon={<EditOutlined />} aria-label="Изменить документ" title="Изменить документ" onClick={() => setModalState({ open: true, doc: record })} />
          </Tooltip>
          <Tooltip title="Деактивировать">
            <Button type="text" danger icon={<DeleteOutlined />} aria-label="Удалить документ" title="Удалить документ" onClick={() => handleDelete(record)} />
          </Tooltip>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap', whiteSpace: 'normal' }}>
          <Text strong style={{ fontSize: 15 }}>Нормативная база</Text>
          <Space size={16} wrap>
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="Поиск: документ, номер, раздел, параметр"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ width: 320 }}
            />
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalState({ open: true })}>
              Добавить документ
            </Button>
          </Space>
        </div>
      }
      style={{ borderRadius: 12, background: token.colorBgContainer, border: `1px solid ${token.colorBorder}` }}
    >
      <Table
        columns={columns}
        dataSource={docs}
        rowKey="id"
        loading={docsQuery.isLoading}
        pagination={{ defaultPageSize: 20, hideOnSinglePage: true, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'] }}
        scroll={{ x: 780 }}
        tableLayout="auto"
        locale={{ emptyText: query.trim() ? 'По запросу ничего не найдено' : 'Нормативных документов пока нет: добавьте первый кнопкой «Добавить документ»' }}
      />
      <NormativeDocModal open={modalState.open} initial={modalState.doc} onClose={() => setModalState({ open: false })} />
    </Card>
  );
};

const LogicalRuleModal: React.FC<{ open: boolean; initial?: LogicalRule; onClose: () => void }> = ({ open, initial, onClose }) => {
  const [form] = Form.useForm<LogicalRuleInput>();
  const { message } = App.useApp();
  const createRule = useCreateLogicalRule();
  const updateRule = useUpdateLogicalRule();

  React.useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (initial) form.setFieldsValue(initial);
  }, [open, initial, form]);

  const handleSubmit = async () => {
    const values = await form.validateFields();
    try {
      if (initial) {
        await updateRule.mutateAsync({ id: initial.id, body: values });
        message.success('Правило изменено');
      } else {
        await createRule.mutateAsync(values);
        message.success('Правило добавлено');
      }
      onClose();
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось сохранить правило');
    }
  };

  return (
    <Modal
      title={initial ? 'Изменить логическое правило' : 'Добавить логическое правило'}
      open={open}
      onOk={handleSubmit}
      onCancel={onClose}
      okText="Сохранить"
      cancelText="Отмена"
      confirmLoading={createRule.isPending || updateRule.isPending}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" initialValues={{ review_priority: 'MEDIUM' }}>
        <Form.Item name="rule_name" label="Название" rules={[{ required: true, message: 'Обязательно' }]}>
          <Input placeholder="Элемент есть в ПД: должен быть и в РД" />
        </Form.Item>
        <Form.Item
          name="condition"
          label="Условие"
          rules={[{ required: true, message: 'Обязательно' }]}
          extra="Ссылка на параметр - КОД.СТАДИЯ (ПД/РД/ИД), например M-055.PD; сравнения ==, !=, >, >=, <, <=, and/or/not, exists(…) / missing(…)"
        >
          <Input placeholder="exists(M-055.PD)" />
        </Form.Item>
        <Form.Item
          name="expected"
          label="Ожидаемое следствие"
          rules={[{ required: true, message: 'Обязательно' }]}
          extra="Тот же язык, что и в условии"
        >
          <Input placeholder="exists(M-055.RD)" />
        </Form.Item>
        <Form.Item name="normative_base" label="Нормативное основание">
          <Input placeholder="СП 59.13330" />
        </Form.Item>
        <Form.Item name="review_priority" label="Приоритет проверки" rules={[{ required: true }]}>
          <Select options={Object.entries(REVIEW_PRIORITY_LABEL).map(([value, label]) => ({ value, label }))} />
        </Form.Item>
      </Form>
    </Modal>
  );
};

const LogicalRulesTab: React.FC = () => {
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const rulesQuery = useLogicalRules();
  const deactivateRule = useDeactivateLogicalRule();
  const updateRule = useUpdateLogicalRule();
  const [modalState, setModalState] = React.useState<{ open: boolean; rule?: LogicalRule }>({ open: false });
  const [query, setQuery] = React.useState('');

  const rules = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const items = rulesQuery.data ?? [];
    if (!q) return items;
    return items.filter((r) => [r.rule_name, r.condition, r.expected, r.normative_base].join(' ').toLowerCase().includes(q));
  }, [rulesQuery.data, query]);

  const handleToggleActive = async (rule: LogicalRule, active: boolean) => {
    try {
      if (active) {
        await updateRule.mutateAsync({ id: rule.id, body: { ...rule, is_active: true } });
      } else {
        await deactivateRule.mutateAsync(rule.id);
      }
    } catch (error) {
      // Включение заново проверяет условие правила: устаревшая запись без кодов параметров api не примет, её нужно поправить
      message.error({
        content: `${error instanceof Error ? error.message : 'Не удалось изменить правило'}. Откройте правило («Изменить») и поправьте условие.`,
        duration: 8,
      });
    }
  };

  const columns = [
    { title: 'Название', dataIndex: 'rule_name', key: 'rule_name', width: 220 },
    { title: 'Условие', dataIndex: 'condition', key: 'condition', render: (v: string) => <Text code>{v}</Text> },
    { title: 'Ожидается', dataIndex: 'expected', key: 'expected', render: (v: string) => <Text code>{v}</Text> },
    { title: 'Основание', dataIndex: 'normative_base', key: 'normative_base', width: 160 },
    {
      title: 'Приоритет',
      dataIndex: 'review_priority',
      key: 'review_priority',
      width: 110,
      render: (v: string) => (
        <StatusPill tone={v === 'HIGH' ? 'error' : v === 'MEDIUM' ? 'warning' : 'default'}>{REVIEW_PRIORITY_LABEL[v] ?? v}</StatusPill>
      ),
    },
    {
      title: 'Активно',
      dataIndex: 'is_active',
      key: 'is_active',
      width: 90,
      render: (active: boolean, record: LogicalRule) => <Switch checked={active} onChange={(checked) => handleToggleActive(record, checked)} />,
    },
    {
      title: 'Действия',
      key: 'actions',
      width: 60,
      render: (_: unknown, record: LogicalRule) => (
        <Tooltip title="Изменить">
          <Button type="text" icon={<EditOutlined />} aria-label="Изменить правило" title="Изменить правило" onClick={() => setModalState({ open: true, rule: record })} />
        </Tooltip>
      ),
    },
  ];

  return (
    <Card
      title={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap', whiteSpace: 'normal' }}>
          <Text strong style={{ fontSize: 15 }}>Логические правила согласованности</Text>
          <Space size={16} wrap>
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="Поиск: название, условие, основание"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ width: 320 }}
            />
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalState({ open: true })}>
              Добавить правило
            </Button>
          </Space>
        </div>
      }
      style={{ borderRadius: 12, background: token.colorBgContainer, border: `1px solid ${token.colorBorder}` }}
    >
      <Table
        columns={columns}
        dataSource={rules}
        rowKey="id"
        loading={rulesQuery.isLoading}
        pagination={{ defaultPageSize: 20, hideOnSinglePage: true, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'] }}
        scroll={{ x: 900 }}
        tableLayout="auto"
        locale={{ emptyText: query.trim() ? 'По запросу ничего не найдено' : 'Логических правил пока нет: правило связывает значения параметров, например «M-002.RD == M-002.PD». Добавьте первое кнопкой «Добавить правило»' }}
      />
      <LogicalRuleModal open={modalState.open} initial={modalState.rule} onClose={() => setModalState({ open: false })} />
    </Card>
  );
};

const ACTOR_TYPE_LABEL: Record<string, string> = { USER: 'Пользователи', SYSTEM: 'Система' };

/** Журнал аудита (GET /audit): все действия пользователей и системы, читают ADMIN и SUPERVISOR. */
const AuditTab: React.FC<{ projects: Array<{ id: string; name: string }> }> = ({ projects }) => {
  const { token } = theme.useToken();
  const { message } = App.useApp();
  const [pageSize, setPageSize] = React.useState(50);
  const [filters, setFilters] = React.useState<AuditFilters>({});
  const [page, setPage] = React.useState(1);
  const [query, setQuery] = React.useState('');
  const [exporting, setExporting] = React.useState(false);
  // Действия для выбора собираем из уже полученных записей: отдельного списка типов у api нет
  const [knownActions, setKnownActions] = React.useState<string[]>([]);
  const auditQuery = useAuditPage(filters, page, pageSize);
  const projectNames = React.useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);

  React.useEffect(() => {
    const seen = auditQuery.data?.items.map((e) => e.action) ?? [];
    if (seen.length === 0) return;
    setKnownActions((prev) => Array.from(new Set([...prev, ...seen])).sort());
  }, [auditQuery.data]);

  const changeFilters = (patch: Partial<AuditFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
    setPage(1);
  };
  const hasFilters = Object.values(filters).some(Boolean);

  const handleExport = async () => {
    setExporting(true);
    try {
      const { items, total } = await fetchAuditAll(filters);
      const blob = new Blob([auditToCsv(items, projectNames)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      message.success(items.length < total ? `Выгружено ${items.length} из ${total} записей: выгрузка ограничена, сузьте период` : `Выгружено записей: ${items.length}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось выгрузить журнал');
    } finally {
      setExporting(false);
    }
  };

  // Поиск по тексту работает по записям текущей страницы; фильтры выше отбирает сервер по всему журналу
  const entries = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const items = auditQuery.data?.items ?? [];
    if (!q) return items;
    return items.filter((e) =>
      [e.user_name, e.action, auditObjectOf(e, projectNames), auditDetailsOf(e)].join(' ').toLowerCase().includes(q)
    );
  }, [auditQuery.data, query, projectNames]);

  const columns = [
    {
      title: 'Время',
      dataIndex: 'timestamp',
      key: 'timestamp',
      width: 150,
      render: (v: string) => <Text style={{ fontSize: 13 }}>{formatDateTime(v)}</Text>,
    },
    {
      title: 'Кто',
      key: 'user',
      width: 200,
      render: (_: unknown, e: AuditEntry) =>
        e.actor_type === 'SYSTEM' ? (
          <Text type="secondary" style={{ fontSize: 13 }}>
            Система
          </Text>
        ) : (
          <Text style={{ fontSize: 13 }}>
            {e.user_name ?? 'нет'}
            {e.user_role ? <Text type="secondary">, {e.user_role}</Text> : null}
          </Text>
        ),
    },
    {
      title: 'Действие',
      dataIndex: 'action',
      key: 'action',
      width: 220,
      render: (v: string) => <Text style={{ fontSize: 13 }} code>{v}</Text>,
    },
    {
      title: 'Проект',
      key: 'object',
      width: 180,
      className: 'col-wrap',
      render: (_: unknown, e: AuditEntry) => <Text style={{ fontSize: 13 }}>{auditObjectOf(e, projectNames)}</Text>,
    },
    {
      title: 'Детали',
      key: 'details',
      className: 'col-wrap',
      render: (_: unknown, e: AuditEntry) => <Text type="secondary" style={{ fontSize: 13 }}>{auditDetailsOf(e)}</Text>,
    },
  ];

  return (
    <Card style={{ borderRadius: 12, background: token.colorBgContainer, border: `1px solid ${token.colorBorder}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <Select
          allowClear
          placeholder="Все исполнители"
          value={filters.actorType}
          onChange={(value) => changeFilters({ actorType: value })}
          style={{ width: 170 }}
          options={Object.entries(ACTOR_TYPE_LABEL).map(([value, label]) => ({ value, label }))}
        />
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="Все проекты"
          value={filters.objectId}
          onChange={(value) => changeFilters({ objectId: value })}
          style={{ width: 220 }}
          notFoundContent="Проектов нет"
          options={projects.map((p) => ({ value: p.id, label: p.name }))}
        />
        <Select
          allowClear
          showSearch
          placeholder="Все действия"
          value={filters.action}
          onChange={(value) => changeFilters({ action: value })}
          style={{ width: 220 }}
          notFoundContent="Действий пока нет"
          options={knownActions.map((action) => ({ value: action, label: action }))}
        />
        <DatePicker.RangePicker
          allowClear
          placeholder={['С даты', 'По дату']}
          format="DD.MM.YYYY"
          onChange={(range) => changeFilters({ dateFrom: range?.[0]?.startOf('day').toISOString(), dateTo: range?.[1]?.endOf('day').toISOString() })}
        />
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="Поиск на странице: кто, действие, проект, причина"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: '1 1 260px', maxWidth: 420 }}
        />
        {hasFilters && (
          <Button
            onClick={() => {
              setFilters({});
              setPage(1);
            }}
          >
            Сбросить фильтры
          </Button>
        )}
        <Button icon={<DownloadOutlined />} loading={exporting} onClick={() => void handleExport()}>
          Скачать CSV
        </Button>
      </div>
      <Table
        columns={columns}
        dataSource={entries}
        rowKey="id"
        loading={auditQuery.isLoading}
        pagination={{ current: page, pageSize, total: auditQuery.data?.total ?? 0, hideOnSinglePage: true, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'], onChange: (p, size) => { setPage(size !== pageSize ? 1 : p); setPageSize(size); }, showTotal: (total) => `Всего записей: ${total}` }}
        scroll={{ x: 900 }}
        tableLayout="auto"
        locale={{ emptyText: auditQuery.isError ? 'Не удалось загрузить журнал аудита' : query.trim() ? 'На этой странице ничего не найдено' : hasFilters ? 'По выбранным фильтрам записей нет' : 'Записей пока нет' }}
      />
    </Card>
  );
};

export const AdminPage: React.FC = () => {
  const { projects } = useProjects();
  const { token } = theme.useToken();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') || 'parameters';

  const tabItems = [
    { key: 'parameters', label: 'Матрица параметров', children: <ParamsTab /> },
    { key: 'normative', label: 'Нормативные документы', children: <NormativeDocsTab /> },
    { key: 'rules', label: 'Логические правила', children: <LogicalRulesTab /> },
    { key: 'audit', label: 'Журнал аудита', children: <AuditTab projects={projects} /> },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 24px', background: token.colorBgContainer, borderBottom: `1px solid ${token.colorBorder}` }}>
        <Title level={2} style={{ margin: 0 }}>
          Администрирование
        </Title>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        <Tabs
          items={tabItems}
          activeKey={activeTab}
          onChange={(key) => setSearchParams({ tab: key }, { replace: true })}
        />
      </div>
    </div>
  );
};
