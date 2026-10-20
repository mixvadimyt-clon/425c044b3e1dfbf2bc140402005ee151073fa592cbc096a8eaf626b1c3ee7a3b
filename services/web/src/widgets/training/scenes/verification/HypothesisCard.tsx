import React from 'react';
import { Button, Input, Select } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import type { DraftFragment } from '@/shared/verification';
import type { TrainerHypothesis, TrainerHypothesisStatus } from '@/shared/trainer';
import { HYPOTHESIS_BADGE, STAGE_COLORS } from './consts';
import { CONFIDENCE_NOTE } from '@/shared/confidenceNote';

const PRIORITY_LABEL = { HIGH: 'ВЫСОКИЙ', MEDIUM: 'СРЕДНИЙ', LOW: 'НИЗКИЙ' } as const;
const ROLE_OPTIONS = [
  { value: 'EXPECTED', label: 'Ожидается' },
  { value: 'ACTUAL', label: 'Фактически' },
  { value: 'CONTEXT', label: 'Контекст' },
];

/** Параметры матрицы учебного комплекта: в настоящей проверке список приходит с сервера. */
const MATRIX_PARAMS = [
  { code: 'M-002', name: 'Общая площадь здания', section: 'ПЗ' },
  { code: 'M-055', name: 'Класс прочности бетона', section: 'КР' },
];

export interface PromoteInput {
  code: string;
  name: string;
  section: string;
  expected: string;
  actual: string;
  comment: string;
  /** Какие доказательства гипотезы оставлены (индексы) и с какой ролью. */
  kept: number[];
}

/** «Сделать кандидатом»: параметр матрицы, значения и доказательства (доказательства гипотезы плюс нарисованные рамки). */
const PromoteForm: React.FC<{
  h: TrainerHypothesis;
  hl: (target: string) => string;
  drafts: DraftFragment[];
  onChangeDraft: (key: string, patch: Partial<Pick<DraftFragment, 'role' | 'value'>>) => void;
  onRemoveDraft: (key: string) => void;
  onSubmit: (input: PromoteInput) => void;
  onCancel: () => void;
}> = ({ h, hl, drafts, onChangeDraft, onRemoveDraft, onSubmit, onCancel }) => {
  const [paramCode, setParamCode] = React.useState<string | undefined>(undefined);
  const [expected, setExpected] = React.useState('');
  const [actual, setActual] = React.useState('');
  const [comment, setComment] = React.useState('');
  const [roles, setRoles] = React.useState<Record<number, string>>(() => Object.fromEntries(h.evidence.map((_, i) => [i, i === 0 ? 'EXPECTED' : 'ACTUAL'])));
  const [removed, setRemoved] = React.useState<number[]>([]);

  const kept = h.evidence.map((_, i) => i).filter((i) => !removed.includes(i));
  const total = kept.length + drafts.length;
  const missing = !paramCode ? 'Выберите параметр матрицы' : total < 1 ? 'Нужно хотя бы одно доказательство: нарисуйте рамку на странице' : '';
  const param = MATRIX_PARAMS.find((p) => p.code === paramCode);

  return (
    <div className={`decision-form decision-comment ${hl('promote-form')}`} data-tt="promote-form">
      <div style={{ fontSize: '12.5px', fontWeight: 700, marginBottom: 8 }}>Кандидат из гипотезы</div>

      <label className="sus-label">Параметр матрицы *</label>
      <Select
        showSearch
        value={paramCode}
        onChange={setParamCode}
        placeholder="Код или название"
        style={{ width: '100%' }}
        optionFilterProp="label"
        options={MATRIX_PARAMS.map((p) => ({ value: p.code, label: `${p.code}, ${p.name}` }))}
        notFoundContent="Не найдено"
      />

      <div className="sus-form-row">
        <div>
          <label className="sus-label">Ожидается</label>
          <Input value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="Например, B30" />
        </div>
        <div>
          <label className="sus-label">Фактически</label>
          <Input value={actual} onChange={(e) => setActual(e.target.value)} placeholder="Например, B25" />
        </div>
      </div>

      <label className="sus-label">Доказательства ({total})</label>
      <div className="sus-frags">
        {h.evidence.map((e, i) => (
          <div key={i} className={`sus-frag${removed.includes(i) ? ' is-removed' : ''}`}>
            <span className="sus-frag-main">
              {e.stage}, стр. {e.doc.page}, {e.value}
            </span>
            <Select size="small" value={roles[i]} onChange={(role) => setRoles((prev) => ({ ...prev, [i]: role }))} options={ROLE_OPTIONS} style={{ width: 118 }} disabled={removed.includes(i)} />
            <Button
              size="small"
              type="text"
              icon={<DeleteOutlined />}
              onClick={() => setRemoved((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]))}
              aria-label={removed.includes(i) ? 'Вернуть' : 'Убрать'}
              title={removed.includes(i) ? 'Вернуть' : 'Убрать'}
            />
          </div>
        ))}
        {drafts.map((d) => (
          <div key={d.key} className="sus-frag is-new">
            <span className="sus-frag-main">
              {d.stage}, стр. {d.page}, новая рамка
            </span>
            <Select size="small" value={d.role} onChange={(role) => onChangeDraft(d.key, { role })} options={ROLE_OPTIONS.slice(0, 2)} style={{ width: 118 }} />
            <Input size="small" value={d.value} placeholder="Значение" onChange={(e) => onChangeDraft(d.key, { value: e.target.value })} style={{ width: 100 }} />
            <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => onRemoveDraft(d.key)} aria-label="Убрать рамку" title="Убрать рамку" />
          </div>
        ))}
      </div>

      <label className="sus-label">Комментарий</label>
      <Input value={comment} onChange={(e) => setComment(e.target.value)} />

      {missing && (
        <div className="hint" style={{ fontSize: '11px', color: '#B54708', margin: '8px 0' }}>
          {missing}
        </div>
      )}
      <div className="decision-actions" style={{ marginTop: 10 }}>
        <button
          className="btn btn-primary"
          disabled={Boolean(missing)}
          onClick={() => param && onSubmit({ code: param.code, name: param.name, section: param.section, expected, actual, comment, kept })}
        >
          Сделать кандидатом
        </button>
        <button className="btn btn-ghost negative-action" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </div>
  );
};

interface Props {
  h: TrainerHypothesis;
  status: TrainerHypothesisStatus;
  /** Подсветка шага урока. */
  hl: (target: string) => string;
  promoting: boolean;
  drafts: DraftFragment[];
  onStartPromote: () => void;
  onCancelPromote: () => void;
  onChangeDraft: (key: string, patch: Partial<Pick<DraftFragment, 'role' | 'value'>>) => void;
  onRemoveDraft: (key: string) => void;
  onPromote: (input: PromoteInput) => void;
  onDecide: (kind: 'DISMISS' | 'CLARIFY', comment: string) => void;
  onOpenCandidate: () => void;
}

/** Правая колонка гипотезы: та же структура, что у карточки кандидата (приоритет, способ, источники, описание, решение). */
export const HypothesisCard: React.FC<Props> = ({ h, status, hl, promoting, drafts, onStartPromote, onCancelPromote, onChangeDraft, onRemoveDraft, onPromote, onDecide, onOpenCandidate }) => {
  const [deciding, setDeciding] = React.useState<'DISMISS' | 'CLARIFY' | null>(null);
  const [comment, setComment] = React.useState('');
  const [changing, setChanging] = React.useState(false);

  // Другая гипотеза: форма решения начинается заново
  React.useEffect(() => {
    setDeciding(null);
    setComment('');
    setChanging(false);
  }, [h.id]);

  const badge = HYPOTHESIS_BADGE[status];
  const decided = status === 'DISMISSED' || status === 'CLARIFICATION_REQUIRED';
  const open = status === 'PENDING' || (decided && changing);
  const startDeciding = (kind: 'DISMISS' | 'CLARIFY') => {
    setDeciding(kind);
    setComment('');
  };
  const save = () => {
    if (!deciding || !comment.trim()) return;
    onDecide(deciding, comment.trim());
    setDeciding(null);
    setComment('');
    setChanging(false);
  };

  return (
    <>
      <div className="ev-block">
        <div className={`prio prio-${h.priority}`}>
          <span className="flag"></span>
          {PRIORITY_LABEL[h.priority]}
        </div>
      </div>

      <div className="ev-block">
        <div className="code" style={{ fontWeight: 800, fontSize: '14px', marginBottom: 4, fontFamily: 'IBM Plex Mono, monospace' }}>
          {h.method}
        </div>
        <div style={{ fontSize: '13px', color: '#667085' }}>Уверенность {Math.round(h.confidence * 100)} %</div>
        <div style={{ fontSize: '12px', color: '#667085', marginBottom: 16 }}>{CONFIDENCE_NOTE}</div>
      </div>

      <div className="ev-block">
        <div className="ev-lbl">Источники</div>
        {h.evidence.map((e, i) => (
          <div key={i} className="src-row">
            <div className="stagechip" style={{ background: STAGE_COLORS[e.stage] }}>
              {e.stage}
            </div>
            <div className="d">
              <div className="fn">{e.value}</div>
              <div className="meta">стр. {e.doc.page}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="ev-block">
        <div className="ev-lbl">Описание</div>
        <div style={{ fontSize: '12.5px', lineHeight: 1.6 }}>{h.description}</div>
      </div>

      <div className={`ev-block ev-block-sep ${hl('hyp-decision')}`} data-tt="hyp-decision" style={{ paddingTop: 16 }}>
        <div className="ev-lbl">Решение инспектора</div>

        {status !== 'PENDING' && (
          <div className="ev-card" style={{ marginBottom: 12 }}>
            <span className={`badge ${badge.cls}`}>{badge.label}</span>
            {status === 'PROMOTED' && (
              <button className="btn btn-ghost btn-block" style={{ marginTop: 10, fontSize: '13px' }} onClick={onOpenCandidate}>
                Открыть кандидата
              </button>
            )}
            {status === 'PROMOTED' && (
              <div className="hint" style={{ fontSize: '11.5px', marginTop: 8 }}>
                Решение по нему принимается в карточке кандидата.
              </div>
            )}
            {decided && !changing && (
              <button className="btn btn-ghost btn-block" style={{ marginTop: 10, fontSize: '13px' }} onClick={() => setChanging(true)}>
                ✎ Изменить решение
              </button>
            )}
            {decided && changing && !promoting && (
              <button className="btn btn-ghost btn-block negative-action" style={{ marginTop: 10, fontSize: '13px' }} onClick={() => (setChanging(false), setDeciding(null))}>
                Не менять
              </button>
            )}
          </div>
        )}

        {open && !promoting && (
          <>
            <div className="decision-btns">
              <button className="btn btn-success btn-block" onClick={onStartPromote} disabled={Boolean(deciding)}>
                ✓ Сделать кандидатом <span className="key-hint">1</span>
              </button>
              {status !== 'DISMISSED' && (
                <button className="btn btn-danger btn-block negative-action" onClick={() => startDeciding('DISMISS')} disabled={Boolean(deciding)}>
                  ✕ Отклонить <span className="key-hint">2</span>
                </button>
              )}
              {status !== 'CLARIFICATION_REQUIRED' && (
                <button className="btn btn-primary btn-block" onClick={() => startDeciding('CLARIFY')} disabled={Boolean(deciding)}>
                  ? Уточнить <span className="key-hint">3</span>
                </button>
              )}
            </div>

            {deciding && (
              <div className="decision-form decision-comment">
                <div style={{ fontSize: '12.5px', fontWeight: 700, marginBottom: 8 }}>{deciding === 'DISMISS' ? 'Отклонение' : 'Уточнение'}</div>
                <label style={{ display: 'block', fontSize: '12px', marginBottom: 6 }}>{deciding === 'DISMISS' ? 'Почему отклоняете *' : 'Что нужно уточнить *'}</label>
                <textarea
                  autoFocus
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && comment.trim()) {
                      e.preventDefault();
                      save();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setDeciding(null);
                    }
                  }}
                  placeholder={deciding === 'DISMISS' ? 'Обоснование решения…' : 'Опишите, что нужно уточнить…'}
                  style={{ width: '100%', minHeight: 80, resize: 'vertical', fontSize: '13px', border: '1px solid #CBD3DE', borderRadius: '5px', padding: '8px 10px', fontFamily: 'inherit', marginBottom: 8, boxSizing: 'border-box' }}
                />
                <div className="hint" style={{ fontSize: '11px', color: '#667085', marginBottom: 10 }}>
                  Комментарий обязателен: он сохранится вместе с решением по гипотезе.
                </div>
                <div className="decision-actions">
                  <button className="btn btn-primary" onClick={save} disabled={!comment.trim()}>
                    {deciding === 'DISMISS' ? 'Отклонить гипотезу' : 'Отправить на уточнение'}
                  </button>
                  <button className="btn btn-ghost negative-action" onClick={() => setDeciding(null)}>
                    Отмена
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {promoting && <PromoteForm h={h} hl={hl} drafts={drafts} onChangeDraft={onChangeDraft} onRemoveDraft={onRemoveDraft} onSubmit={onPromote} onCancel={onCancelPromote} />}
      </div>
    </>
  );
};
