import React from 'react';
import { Form, Input, Modal, Select } from 'antd';
import type { FileInfo } from '@/api/processes';

export type RevisionAction = 'authoritative' | 'predecessor';

interface Props {
  file: FileInfo | null;
  action: RevisionAction | null;
  /** Остальные файлы проверки — кандидаты в «предыдущую редакцию». */
  siblings: FileInfo[];
  saving: boolean;
  onCancel: () => void;
  onSubmit: (values: { comment: string; reference?: string; predecessorId?: string }) => void;
}

interface FormValues {
  comment: string;
  reference?: string;
  predecessorId?: string;
}

/** Основание обязательно: правка редакции уходит в аудит. */
export const FileRevisionModal: React.FC<Props> = ({ file, action, siblings, saving, onCancel, onSubmit }) => {
  const [form] = Form.useForm<FormValues>();

  return (
    <Modal
      open={Boolean(file && action)}
      title={action === 'authoritative' ? 'Сделать эталонной редакцией' : 'Указать предыдущую редакцию'}
      okText="Сохранить"
      cancelText="Отмена"
      confirmLoading={saving}
      onCancel={onCancel}
      afterClose={() => form.resetFields()}
      onOk={() => form.validateFields().then(onSubmit)}
      destroyOnHidden
    >
      <p style={{ marginTop: 0 }}>
        Файл: <b>{file?.original_name}</b>. После сохранения комплект будет пересчитан.
      </p>
      <Form form={form} layout="vertical">
        {action === 'predecessor' && (
          <Form.Item name="predecessorId" label="Предыдущая редакция" rules={[{ required: true, message: 'Выберите файл' }]}>
            <Select
              placeholder="Выберите файл"
              options={siblings.filter((s) => s.id !== file?.id).map((s) => ({ value: s.id, label: s.original_name }))}
            />
          </Form.Item>
        )}
        <Form.Item name="comment" label="Основание" rules={[{ required: true, min: 3, message: 'Укажите основание (не короче 3 символов)' }]}>
          <Input.TextArea rows={3} placeholder="Например: извещение об изменении № 5 от 12.09.2026" />
        </Form.Item>
        <Form.Item name="reference" label="Ссылка на документ-основание (необязательно)">
          <Input />
        </Form.Item>
      </Form>
    </Modal>
  );
};
