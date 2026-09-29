import React from 'react';
import { App, Button, Input, Select } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import { buildPromoteBody, decideSuspicion, defaultRole, evidenceStages, fragmentLabel, METHOD_LABEL, promoteSuspicion, SUSPICION_BADGE, useMatrixParams } from '@/api/suspicions';
import type { ApiSuspicion, Fragment } from '@/api/suspicions';
import type { FileInfo } from '@/api/processes';
import type { DraftFragment } from '@/shared/verification';

const PRIORITY_LABEL = { HIGH: 'ВЫСОКИЙ', MEDIUM: 'СРЕДНИЙ', LOW: 'НИЗКИЙ' } as const;
const STAGE_COLORS: Record<string, string> = { PD: '#2450C7', RD: '#B4620B', ID: '#5B4FBE' };
const STAGE_SHORT: Record<string, string> = { PD: 'ПД', RD: 'РД', ID: 'ИД' };
const ROLE_OPTIONS = [
  { value: 'EXPECTED', label: 'Ожидается' },
  { value: 'ACTUAL', label: 'Фактически' },
  { value: 'CONTEXT', label: 'Контекст' },
];

interface FormProps {
  suspicion: ApiSuspicion;
  drafts: DraftFragment[];
  files: FileInfo[];
  saving: boolean;
  onChangeDraft: (key: string, patch: Partial<Pick<DraftFragment, 'role' | 'value'>>) => void;
  onRemoveDraft: (key: string) => void;
  onSubmit: (body: Parameters<typeof promoteSuspicion>[1]) => void;
  onCancel: () => void;
}

/** «Сделать кандидатом»: параметр матрицы, значения и доказательства (фрагменты гипотезы плюс нарисованные рамки). */
export const PromoteForm: React.FC<FormProps> = ({ suspicion, drafts, files, saving, onChangeDraft, onRemoveDraft, onSubmit, onCancel }) => {
  const params = useMatrixParams();
  const evidence = suspicion.evidence ?? [];
  const stages = evidenceStages(evidence);
  const [paramCode, setParamCode] = React.useState<string | undefined>(undefined);
  const [expected, setExpected] = React.useState('');
  const [actual, setActual] = React.useState('');
  const [comment, setComment] = React.useState('');
  const [roles, setRoles] = React.useState<Record<number, Fragment['role']>>(() => Object.fromEntries(evidence.map((f, i) => [i, defaultRole(f.stage, stages)])));
  const [removed, setRemoved] = React.useState<number[]>([]);

  const kept = evidence.filter((_, i) => !removed.includes(i));
  const total = kept.length + drafts.length;
  const missing = !paramCode ? 'Выберите параметр матрицы' : total < 1 ? 'Нужно хотя бы одно доказательство: нарисуйте рамку на странице' : '';

  const submit = () => onSubmit(buildPromoteBody({ paramCode: paramCode!, expected, actual, comment, evidence, roles, removed, drafts, files }));

  // Enter создаёт кандидата, Esc отменяет: как в форме решения по кандидату. Выбор в списках (свой Enter и Esc) не трогаем
  const keysRef = React.useRef({ submit, onCancel, canSubmit: false });
  keysRef.current = { submit, onCancel, canSubmit: !saving && !missing };
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing) return;
      const target = e.target as Element | null;
      if (target?.closest?.('.ant-select, .ant-select-dropdown, button, textarea')) return;
      if (e.key === 'Enter' && keysRef.current.canSubmit) {
        e.preventDefault();
        keysRef.current.submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        keysRef.current.onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="decision-form decision-comment">
      <div style={{ fontSize: '12.5px', fontWeight: 700, marginBottom: 8 }}>Кандидат из гипотезы</div>

      <label className="sus-label">Параметр матрицы *</label>
      <Select
        showSearch
        loading={params.isLoading}
        value={paramCode}
        onChange={setParamCode}
        placeholder="Код или название"
        style={{ width: '100%' }}
        optionFilterProp="label"
        options={(params.data ?? []).map((p) => ({ value: p.code, label: `${p.code}, ${p.parameter_name}` }))}
        notFoundContent={params.isError ? 'Не удалось загрузить параметры' : 'Не найдено'}
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
        {evidence.map((f, i) => (
          <div key={i} className={`sus-frag${removed.includes(i) ? ' is-removed' : ''}`}>
            <span className="sus-frag-main">{fragmentLabel(f)}</span>
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
        <button className="btn btn-primary" onClick={submit} disabled={saving || Boolean(missing)} title="Enter">
          {saving ? 'Сохраняем…' : 'Сделать кандидатом'}
        </button>
        <button className="btn btn-ghost negative-action" onClick={onCancel} disabled={saving} title="Esc">
          Отмена
        </button>
      </div>
    </div>
  );
};

interface DetailProps {
  suspicion?: ApiSuspicion;
  /** Решать и переводить в кандидаты могут инспектор и супервизор. */
  canDecide: boolean;
  promotingId?: string;
  onStartPromote: (id: string) => void;
  onCancelPromote: () => void;
  drafts: DraftFragment[];
  onChangeDraft: (key: string, patch: Partial<Pick<DraftFragment, 'role' | 'value'>>) => void;
  onRemoveDraft: (key: string) => void;
  files: FileInfo[];
  /** Гипотеза изменилась на сервере: перечитать данные. */
  onChanged: () => void;
  /** Гипотеза стала кандидатом: открыть его в карточке. */
  onOpenFinding: (findingId: string) => void;
}

/** Правая колонка гипотезы: та же структура, что у карточки несоответствия (приоритет, название, источники, описание, решение). */
export const SuspicionDetail: React.FC<DetailProps> = ({ suspicion: s, canDecide, promotingId, onStartPromote, onCancelPromote, drafts, onChangeDraft, onRemoveDraft, files, onChanged, onOpenFinding }) => {
  const { message } = App.useApp();
  const [deciding, setDeciding] = React.useState<'DISMISS' | 'CLARIFY' | null>(null);
  const [comment, setComment] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  // Решение по гипотезе можно поменять: «Изменить решение» снова открывает кнопки
  const [changing, setChanging] = React.useState(false);

  // Другая гипотеза: форма решения начинается заново
  React.useEffect(() => {
    setDeciding(null);
    setComment('');
    setChanging(false);
  }, [s?.suspicion_id]);

  // Кнопки решения: у гипотезы без решения сразу, у решённой (отклонена, уточнение) после «Изменить решение»; у ставшей кандидатом решение принимается в карточке кандидата
  const decided = s?.inspector_status === 'DISMISSED' || s?.inspector_status === 'CLARIFICATION_REQUIRED';
  const open = s?.inspector_status === 'PENDING' || (decided && changing);
  const buttonsShown = Boolean(s) && open && canDecide && promotingId !== s?.suspicion_id;

  // Те же клавиши, что у кандидата: 1 сделать кандидатом, 2 отклонить, 3 уточнить (в полях ввода не срабатывают)
  const startDeciding = (kind: 'DISMISS' | 'CLARIFY') => {
    setDeciding(kind);
    setComment('');
  };
  const keysRef = React.useRef<(key: string) => void>(() => undefined);
  keysRef.current = (key) => {
    if (!s || deciding) return;
    if (key === '1') onStartPromote(s.suspicion_id);
    else if (key === '2' && s.inspector_status !== 'DISMISSED') startDeciding('DISMISS');
    else if (key === '3' && s.inspector_status !== 'CLARIFICATION_REQUIRED') startDeciding('CLARIFY');
  };
  React.useEffect(() => {
    if (!buttonsShown) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
      if (e.ctrlKey || e.metaKey || e.altKey || !['1', '2', '3'].includes(e.key)) return;
      e.preventDefault();
      keysRef.current(e.key);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [buttonsShown]);

  if (!s) return <div className="sus-empty">Выберите гипотезу в списке слева.</div>;
  const badge = SUSPICION_BADGE[s.inspector_status];

  const saveDecision = async () => {
    if (!deciding) return;
    setSaving(true);
    try {
      await decideSuspicion(s.suspicion_id, deciding, comment);
      message.success(deciding === 'DISMISS' ? 'Гипотеза отклонена' : 'Гипотеза отправлена на уточнение');
      setDeciding(null);
      setComment('');
      setChanging(false);
      onChanged();
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось сохранить решение по гипотезе');
    } finally {
      setSaving(false);
    }
  };

  const promote = async (body: Parameters<typeof promoteSuspicion>[1]) => {
    setSaving(true);
    try {
      const finding = (await promoteSuspicion(s.suspicion_id, body)) as { id?: string };
      message.success('Гипотеза стала кандидатом: решение по нему принимается в проверке кандидатов');
      onCancelPromote();
      setChanging(false);
      onChanged();
      if (finding.id) onOpenFinding(finding.id);
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось сделать гипотезу кандидатом');
    } finally {
      setSaving(false);
    }
  };

  const sources = (s.evidence ?? []).map((f) => ({ stage: f.stage, value: f.extracted_value || f.document_code || 'Область на листе', page: f.page }));

  return (
    <>
      <div className="ev-block">
        <div className={`prio prio-${s.review_priority}`}>
          <span className="flag"></span>
          {PRIORITY_LABEL[s.review_priority]}
        </div>
      </div>

      <div className="ev-block">
        <div className="code" style={{ fontWeight: 800, fontSize: '14px', marginBottom: 4, fontFamily: 'IBM Plex Mono, monospace' }}>
          {METHOD_LABEL[s.discovery_method]}
        </div>
        <div style={{ fontSize: '13px', color: '#667085', marginBottom: 16 }}>Уверенность {Math.round(s.confidence * 100)} %</div>
      </div>

      {sources.length > 0 && (
        <div className="ev-block">
          <div className="ev-lbl">Источники</div>
          {sources.map((src, i) => (
            <div key={i} className="src-row">
              <div className="stagechip" style={{ background: STAGE_COLORS[src.stage] }}>
                {STAGE_SHORT[src.stage] ?? src.stage}
              </div>
              <div className="d">
                <div className="fn">{src.value}</div>
                <div className="meta">стр. {src.page}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {s.normative_base && (
        <div className="ev-block">
          <div className="ev-lbl">Нормативное основание</div>
          <div style={{ fontSize: '12px', lineHeight: 1.6 }}>{s.normative_base}</div>
        </div>
      )}

      <div className="ev-block">
        <div className="ev-lbl">Описание</div>
        <div style={{ fontSize: '12.5px', lineHeight: 1.6 }}>{s.description}</div>
      </div>

      <div className="ev-block ev-block-sep" style={{ paddingTop: 16 }}>
        <div className="ev-lbl">Решение инспектора</div>

        {s.inspector_status !== 'PENDING' && (
          <div className="ev-card" style={{ marginBottom: 12 }}>
            <span className={`badge ${badge.cls}`}>{badge.label}</span>
            {s.inspector_status === 'PROMOTED' && s.promoted_finding_id && (
              <button className="btn btn-ghost btn-block" style={{ marginTop: 10, fontSize: '13px' }} onClick={() => onOpenFinding(s.promoted_finding_id!)}>
                Открыть кандидата
              </button>
            )}
            {s.inspector_status === 'PROMOTED' && (
              <div className="hint" style={{ fontSize: '11.5px', marginTop: 8 }}>
                Решение по нему принимается в карточке кандидата.
              </div>
            )}
            {decided && canDecide && !changing && (
              <button className="btn btn-ghost btn-block" style={{ marginTop: 10, fontSize: '13px' }} onClick={() => setChanging(true)}>
                ✎ Изменить решение
              </button>
            )}
            {decided && changing && !promotingId && (
              <button className="btn btn-ghost btn-block negative-action" style={{ marginTop: 10, fontSize: '13px' }} onClick={() => (setChanging(false), setDeciding(null))} disabled={saving}>
                Не менять
              </button>
            )}
          </div>
        )}

        {s.inspector_status === 'PENDING' && !canDecide && (
          <div className="hint" style={{ fontSize: '12.5px', lineHeight: 1.5, marginTop: 10 }}>
            Решения по гипотезам принимают инспектор и супервизор, вашей роли доступен только просмотр.
          </div>
        )}

        {open && canDecide && promotingId !== s.suspicion_id && (
          <>
            <div className="decision-btns">
              <button className="btn btn-success btn-block" onClick={() => onStartPromote(s.suspicion_id)} disabled={Boolean(deciding)}>
                ✓ Сделать кандидатом <span className="key-hint" title="Горячая клавиша 1">1</span>
              </button>
              {s.inspector_status !== 'DISMISSED' && (
                <button className="btn btn-danger btn-block negative-action" onClick={() => (setDeciding('DISMISS'), setComment(''))} disabled={Boolean(deciding)}>
                  ✕ Отклонить <span className="key-hint" title="Горячая клавиша 2">2</span>
                </button>
              )}
              {s.inspector_status !== 'CLARIFICATION_REQUIRED' && (
                <button className="btn btn-primary btn-block" onClick={() => (setDeciding('CLARIFY'), setComment(''))} disabled={Boolean(deciding)}>
                  ? Уточнить <span className="key-hint" title="Горячая клавиша 3">3</span>
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
                    // Enter отправляет, Shift + Enter новая строка, Esc отменяет: как в форме решения по кандидату
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && comment.trim() && !saving) {
                      e.preventDefault();
                      void saveDecision();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setDeciding(null);
                    }
                  }}
                  placeholder={deciding === 'DISMISS' ? 'Обоснование решения…' : 'Опишите, что нужно уточнить…'}
                  style={{ width: '100%', minHeight: 80, resize: 'vertical', fontSize: '13px', border: '1px solid #CBD3DE', borderRadius: '5px', padding: '8px 10px', fontFamily: 'inherit', marginBottom: 8 }}
                />
                <div className="hint" style={{ fontSize: '11px', color: '#667085', marginBottom: 10 }}>
                  Комментарий обязателен: он сохранится вместе с решением по гипотезе.
                </div>
                <div className="decision-actions">
                  <button className="btn btn-primary" onClick={() => void saveDecision()} disabled={!comment.trim() || saving} title="Enter">
                    {deciding === 'DISMISS' ? 'Отклонить гипотезу' : 'Отправить на уточнение'}
                  </button>
                  <button className="btn btn-ghost negative-action" onClick={() => setDeciding(null)} disabled={saving} title="Esc">
                    Отмена
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {promotingId === s.suspicion_id && (
          <PromoteForm suspicion={s} drafts={drafts} files={files} saving={saving} onChangeDraft={onChangeDraft} onRemoveDraft={onRemoveDraft} onSubmit={(body) => void promote(body)} onCancel={onCancelPromote} />
        )}
      </div>
    </>
  );
};
