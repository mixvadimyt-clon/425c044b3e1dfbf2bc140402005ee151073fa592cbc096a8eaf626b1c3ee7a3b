import React from 'react';
import { Button, Input, Select } from 'antd';
import { DeleteOutlined, UndoOutlined } from '@ant-design/icons';
import type { DraftFragment, FragmentInfo } from '@/shared/verification';

const ROLE_LABEL = { EXPECTED: 'Ожидается', ACTUAL: 'Фактически', CONTEXT: 'Контекст' } as const;

interface Props {
  fragments: FragmentInfo[];
  removedIds: string[];
  drafts: DraftFragment[];
  saving: boolean;
  onToggleRemove: (id: string) => void;
  onChangeDraft: (key: string, patch: Partial<Pick<DraftFragment, 'role' | 'value'>>) => void;
  onRemoveDraft: (key: string) => void;
  onSave: (reason: string, reference: string) => void;
  onCancel: () => void;
}

/** Правка доказательств (REQ-CMP-09): рамки рисуются на страницах документов, здесь — список изменений, причина и ссылка. */
export const EvidenceEditor: React.FC<Props> = ({ fragments, removedIds, drafts, saving, onToggleRemove, onChangeDraft, onRemoveDraft, onSave, onCancel }) => {
  const [reason, setReason] = React.useState('');
  const [reference, setReference] = React.useState('');

  const changes = drafts.length + removedIds.length;
  const remaining = fragments.length - removedIds.length + drafts.length;
  const missing = changes === 0 ? 'Нарисуйте рамку на странице или уберите фрагмент' : remaining < 1 ? 'Должен остаться хотя бы один фрагмент' : !reason.trim() ? 'Укажите причину' : !reference.trim() ? 'Укажите ссылку на основание' : '';

  return (
    <div className="ev-editor" data-testid="evidence-editor">
      <div className="ev-editor-title">Правка доказательств</div>
      <div className="ev-editor-hint">Потяните мышью по странице документа, чтобы обвести значение. Машинная версия сохранится в истории, правка станет новой версией.</div>

      <div className="ev-editor-list">
        {fragments.map((f) => {
          const removed = removedIds.includes(f.id);
          return (
            <div key={f.id} className={`ev-editor-row${removed ? ' is-removed' : ''}`}>
              <div className="ev-editor-row-main">
                <b>{f.stage}</b>, стр. {f.page}, {f.value || 'нет'}
                <span className="ev-editor-role">
                  {ROLE_LABEL[f.role]}
                  {f.manual ? ', нарисовано инспектором' : ''}
                </span>
              </div>
              <Button
                size="small"
                type="text"
                icon={removed ? <UndoOutlined /> : <DeleteOutlined />}
                onClick={() => onToggleRemove(f.id)}
                aria-label={removed ? 'Вернуть фрагмент' : 'Убрать фрагмент'}
                title={removed ? 'Вернуть фрагмент' : 'Убрать фрагмент'}
              />
            </div>
          );
        })}

        {drafts.map((d) => (
          <div key={d.key} className="ev-editor-row is-new">
            <div className="ev-editor-row-main">
              <b>{d.stage}</b>, стр. {d.page}, новая рамка
              <div className="ev-editor-fields">
                <Select
                  size="small"
                  value={d.role}
                  onChange={(role) => onChangeDraft(d.key, { role })}
                  style={{ width: '100%' }}
                  options={[
                    { value: 'EXPECTED', label: ROLE_LABEL.EXPECTED },
                    { value: 'ACTUAL', label: ROLE_LABEL.ACTUAL },
                  ]}
                />
                <span className="ev-editor-caption">Значение, которое обведено (например, B30)</span>
                <Input size="small" value={d.value} placeholder="B30" onChange={(e) => onChangeDraft(d.key, { value: e.target.value })} style={{ width: '100%' }} />
              </div>
            </div>
            <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => onRemoveDraft(d.key)} aria-label="Убрать рамку" title="Убрать рамку" />
          </div>
        ))}
      </div>

      <label className="ev-editor-label">Причина правки</label>
      <Input.TextArea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Например: система взяла значение из другой таблицы" />
      <label className="ev-editor-label">Ссылка на основание</label>
      <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Лист, пункт, письмо" />

      <div className="ev-editor-actions">
        <Button type="primary" loading={saving} disabled={Boolean(missing)} onClick={() => onSave(reason, reference)}>
          Сохранить правку
        </Button>
        <Button className="negative-action" onClick={onCancel} disabled={saving}>
          Отмена
        </Button>
      </div>
      {missing && <div className="ev-editor-missing">{missing}</div>}
    </div>
  );
};
