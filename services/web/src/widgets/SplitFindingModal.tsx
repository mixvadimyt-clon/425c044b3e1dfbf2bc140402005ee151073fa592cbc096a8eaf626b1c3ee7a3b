import React from 'react';
import { Button, Checkbox, Form, Input, Modal, Space, Typography, theme } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import type { FragmentInfo } from '@/shared/verification';

const { Text } = Typography;

export interface SplitPartValues {
  rule_key: string;
  expected_value?: string;
  actual_value?: string;
  fragment_ids: string[];
  comment?: string;
}

interface Props {
  open: boolean;
  /** Название и правило составного несоответствия — подсказка для ключей частей. */
  title: string;
  baseRuleKey?: string;
  fragments: FragmentInfo[];
  saving: boolean;
  onCancel: () => void;
  onSubmit: (parts: SplitPartValues[]) => void;
}

/** Разделение составного кандидата на атомарные (REQ-VER-05): каждая часть получает свои фрагменты доказательств. */
export const SplitFindingModal: React.FC<Props> = ({ open, title, baseRuleKey, fragments, saving, onCancel, onSubmit }) => {
  const { token } = theme.useToken();
  const [form] = Form.useForm<{ parts: SplitPartValues[] }>();
  const base = baseRuleKey || 'часть';

  return (
    <Modal
      open={open}
      title="Разделить кандидата на части"
      okText="Разделить"
      cancelText="Отмена"
      width={640}
      confirmLoading={saving}
      onCancel={onCancel}
      afterClose={() => form.resetFields()}
      onOk={() => form.validateFields().then((values) => onSubmit(values.parts))}
      destroyOnHidden
    >
      <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
        «{title}»: каждая часть станет отдельным кандидатом со своими фрагментами доказательств. Исходное перестанет верифицироваться, решения принимаются по частям.
      </Text>
      <Form
        form={form}
        layout="vertical"
        initialValues={{ parts: [{ rule_key: `${base} - 1`, fragment_ids: [] }, { rule_key: `${base} - 2`, fragment_ids: [] }] }}
      >
        <Form.List
          name="parts"
          rules={[{ validator: async (_, parts) => (parts && parts.length >= 2 ? undefined : Promise.reject(new Error('Нужно минимум две части'))) }]}
        >
          {(fields, { add, remove }, { errors }) => (
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              {fields.map((field, index) => (
                <div key={field.key} style={{ border: `1px solid ${token.colorBorder}`, background: token.colorBgContainer, borderRadius: 8, padding: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <Text strong>Часть {index + 1}</Text>
                    {fields.length > 2 && <Button type="text" size="small" className="negative-action" icon={<DeleteOutlined />} onClick={() => remove(field.name)} aria-label="Убрать часть" />}
                  </div>
                  <Form.Item name={[field.name, 'rule_key']} label="Ключ части (элемент, помещение)" rules={[{ required: true, message: 'Укажите ключ части' }]}>
                    <Input />
                  </Form.Item>
                  <Space size={12} style={{ width: '100%' }} align="start">
                    <Form.Item name={[field.name, 'expected_value']} label="Ожидается" style={{ flex: 1 }}>
                      <Input />
                    </Form.Item>
                    <Form.Item name={[field.name, 'actual_value']} label="Фактически" style={{ flex: 1 }}>
                      <Input />
                    </Form.Item>
                  </Space>
                  <Form.Item
                    name={[field.name, 'fragment_ids']}
                    label="Фрагменты доказательств этой части"
                    rules={[{ required: true, type: 'array', min: 1, message: 'Выберите хотя бы один фрагмент' }]}
                  >
                    <Checkbox.Group style={{ display: 'grid', gap: 4 }} options={fragments.map((f) => ({ value: f.id, label: `${f.stage}, стр. ${f.page}, ${f.value || 'нет'}` }))} />
                  </Form.Item>
                  <Form.Item name={[field.name, 'comment']} label="Комментарий (необязательно)" style={{ marginBottom: 0 }}>
                    <Input />
                  </Form.Item>
                </div>
              ))}
              <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ rule_key: `${base} - ${fields.length + 1}`, fragment_ids: [] })} block>
                Добавить часть
              </Button>
              <Form.ErrorList errors={errors} />
            </Space>
          )}
        </Form.List>
      </Form>
    </Modal>
  );
};
