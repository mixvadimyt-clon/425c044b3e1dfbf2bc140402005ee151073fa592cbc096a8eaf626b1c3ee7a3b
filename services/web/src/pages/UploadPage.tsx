import React from 'react';
import { Alert, Card, Dropdown, Upload, Select, Space, Typography, Input, Table, Button, Progress, Tooltip, App, theme } from 'antd';
import { InboxOutlined, DeleteOutlined, FileTextOutlined, FolderOpenOutlined, MoreOutlined, SearchOutlined } from '@ant-design/icons';
import type { UploadProps } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useProjects } from '@/app/providers/useProjects';
import { createObject } from '@/api/projects';
import { uploadedLine } from '@/api/protocols';
import { isProcessBusy, isProcessStalled, patchFile, useProcess, useProcessFiles, useProcessStatus } from '@/api/processes';
import type { FileInfo } from '@/api/processes';
import {
  ALLOWED_REGISTRY_EXTENSIONS,
  MAX_BATCH_MB,
  MAX_FILE_MB,
  UploadFailedError,
  batchTooLarge,
  registryErrorsOf,
  folderPathOf,
  isArchive,
  uploadDocuments,
  uploadRegistry,
  validateFile,
} from '@/api/upload';
import type { ApiStage, UploadResponse } from '@/api/upload';
import { StatusPill } from '@/widgets/StatusPill';
import { FileRevisionModal } from '@/widgets/FileRevisionModal';
import { FileSignature } from '@/widgets/FileSignature';
import { DocumentFacts } from '@/widgets/DocumentFacts';
import { attachSignature, validateSignatureFile } from '@/api/signature';
import type { RevisionAction } from '@/widgets/FileRevisionModal';
import { APPROVAL_STATUS, COMPLETENESS_STATUS, DOC_STAGE_LABEL, FILE_PROCESSING_STATUS, PROCESS_STATUS, REGISTRY_ISSUE } from '@/shared/statuses';
import { lowerFirst } from '@/shared/text';
import { TableEmpty } from '@/widgets/TableEmpty';

const { Title, Text } = Typography;
const { Dragger } = Upload;

// Пока стадию определяет только ML по содержимому, инспектор подсказывает её для каждого файла
const STAGE_OPTIONS: Array<{ value: ApiStage; label: string }> = [
  { value: 'PD', label: 'ПД: проектная документация' },
  { value: 'RD', label: 'РД: рабочая документация' },
  { value: 'ID', label: 'ИД: исполнительная документация' },
];

interface StagedFile {
  uid: string;
  file: File;
  stage?: ApiStage;
}

type DetailKey = 'developer' | 'contractor' | 'permit';

// Реквизиты объекта для шапки протокола (protocol.md: застройщик, подрядчик, № разрешения)
const DETAIL_FIELDS: Array<{ key: DetailKey; label: string; placeholder: string }> = [
  { key: 'developer', label: 'Застройщик', placeholder: 'Введите наименование застройщика' },
  { key: 'contractor', label: 'Подрядчик', placeholder: 'Введите наименование подрядчика' },
  { key: 'permit', label: '№ разрешения на строительство', placeholder: 'Введите номер разрешения' },
];

// Демо-файлы существующих проектов: показываем только в явном демо-режиме
const MOCK_DOCS: Record<string, Array<{ name: string; stage: ApiStage }>> = {
  'obj-1': [
    { name: 'КР-АР.pdf', stage: 'PD' },
    { name: 'КЖ01-Раздел1.pdf', stage: 'RD' },
  ],
};

// Подпись: показываем только то, что важно инспектору
const SIGNATURE_PILL: Partial<Record<NonNullable<FileInfo['signature_status']>, { label: string; tone: 'success' | 'error' }>> = {
  SIGNED: { label: 'Подписан', tone: 'success' },
  QES: { label: 'УКЭП', tone: 'success' },
  ABSENT: { label: 'Нет подписи', tone: 'error' },
};

const fieldLabel = (text: string, gap = 8) => (
  <Text strong style={{ display: 'block', marginBottom: gap, fontSize: 15 }}>
    {text}
  </Text>
);

export const UploadPage: React.FC = () => {
  const { message } = App.useApp();
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const objectId = searchParams.get('object');
  const isNewProject = searchParams.get('new') === 'true';
  // Кнопки «Дозагрузить» ведут сюда с ?focus=upload: сразу к разделу загрузки, без прокрутки всей страницы
  const focusUpload = searchParams.get('focus') === 'upload';
  const uploadSectionRef = React.useRef<HTMLDivElement>(null);
  const scrolledRef = React.useRef(false);

  const { projects: existingProjects, source, updateProject, addProject, reload } = useProjects();
  const isMock = source === 'mock';
  const projectsRef = React.useRef(existingProjects);
  projectsRef.current = existingProjects;

  const [selectedProject, setSelectedProject] = React.useState<string | undefined>(isNewProject ? 'new' : objectId || undefined);
  const [projectName, setProjectName] = React.useState('');
  const [projectAddress, setProjectAddress] = React.useState('');
  const [details, setDetails] = React.useState<Record<DetailKey, string>>({ developer: '', contractor: '', permit: '' });
  const [staged, setStaged] = React.useState<StagedFile[]>([]);
  const [registryFile, setRegistryFile] = React.useState<File | undefined>();
  const [sending, setSending] = React.useState(false);
  const [sendPercent, setSendPercent] = React.useState(0);
  const [lastUpload, setLastUpload] = React.useState<UploadResponse | null>(null);
  // Проверка, созданная в этой сессии для нового объекта (в списке проектов её ещё нет)
  const [createdProcessId, setCreatedProcessId] = React.useState<string | null>(null);

  const [revisionTarget, setRevisionTarget] = React.useState<{ file: FileInfo; action: RevisionAction } | null>(null);
  const [revisionSaving, setRevisionSaving] = React.useState(false);
  // Электронная подпись файла: скрытое поле выбора файла открывается кнопкой в строке документа
  const signatureInputRef = React.useRef<HTMLInputElement>(null);
  const signatureTargetRef = React.useRef<FileInfo | null>(null);
  const [signatureBusyId, setSignatureBusyId] = React.useState<string | null>(null);
  const [registryErrors, setRegistryErrors] = React.useState<string[]>([]);
  const [highlightFileId, setHighlightFileId] = React.useState<string | null>(null);

  const project = selectedProject && selectedProject !== 'new' ? existingProjects.find((p) => p.id === selectedProject) : undefined;
  const currentProcessId = isMock ? null : (createdProcessId ?? project?.processId ?? null);

  const statusQuery = useProcessStatus(currentProcessId);
  const refreshKey = statusQuery.data?.updated_at;
  const processQuery = useProcess(currentProcessId, refreshKey);
  const filesQuery = useProcessFiles(currentProcessId, refreshKey);

  const processStatus = statusQuery.data?.status;
  const busy = isProcessBusy(processStatus);
  const finalized = processStatus === 'FINALIZED' || project?.finalized === true;
  const canAppend = !busy && !finalized;
  const registryAbsent = processQuery.data?.completeness?.registry === 'ABSENT';

  // Опрос статуса раз в 2 с не даёт нового рендера, пока ответ не меняется — тикаем сами,
  // чтобы заметить зависший разбор, а не только смену статуса.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, [busy]);
  const stalled = busy && isProcessStalled(statusQuery.data?.updated_at, now);

  // Только что созданный объект выбираем сами — итог его первой загрузки на экране не сбрасываем
  const justCreatedRef = React.useRef<string | null>(null);
  const filledForRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (selectedProject && selectedProject === justCreatedRef.current) {
      justCreatedRef.current = null;
      return;
    }
    setStaged([]);
    setRegistryFile(undefined);
    setLastUpload(null);
    setRegistryErrors([]);
    setCreatedProcessId(null);
    filledForRef.current = null;
    if (selectedProject === 'new') {
      setProjectName('');
      setProjectAddress('');
      setDetails({ developer: '', contractor: '', permit: '' });
    }
  }, [selectedProject]);

  // Реквизиты подставляем, как только проект появился в списке: при открытии страницы по ссылке список ещё грузится
  React.useEffect(() => {
    if (!project || filledForRef.current === project.id) return;
    filledForRef.current = project.id;
    setProjectName(project.name);
    setProjectAddress(project.address);
    setDetails({ developer: project.developer, contractor: project.contractor, permit: project.permit });
  }, [project]);

  const dataReady = Boolean(project) && (isMock || !currentProcessId || Boolean(statusQuery.data && processQuery.data && filesQuery.data));
  React.useEffect(() => {
    if (!focusUpload || scrolledRef.current || !dataReady) return;
    // Ждём, пока отрисуются блоки над разделом, иначе прокрутка сдвинется; флаг ставим в самой прокрутке,
    // иначе повторный запуск эффекта (StrictMode) отменит таймер и прокрутка не случится
    const timer = setTimeout(() => {
      scrolledRef.current = true;
      uploadSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 150);
    return () => clearTimeout(timer);
  }, [focusUpload, dataReady]);

  // Когда проверка дошла до «Готов к верификации», обновляем список объектов (светофор, стадии)
  const reloadRef = React.useRef(reload);
  reloadRef.current = reload;
  React.useEffect(() => {
    if (processStatus && !isProcessBusy(processStatus)) void reloadRef.current();
  }, [processStatus]);

  const addToStaged = (files: File[]) => {
    const accepted = files.filter((file) => {
      const problem = validateFile(file);
      if (problem) message.error(problem);
      return !problem;
    });
    setStaged((prev) => {
      const next = [...prev, ...accepted.map((file) => ({ uid: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`, file }))];
      if (batchTooLarge(next.map((s) => s.file))) {
        message.error(`Общий размер пакета больше ${MAX_BATCH_MB} МБ`);
        return prev;
      }
      return next;
    });
  };

  const pendingBatch = React.useRef<File[]>([]);
  const folderInputRef = React.useRef<HTMLInputElement>(null);
  const dropzoneProps: UploadProps = {
    multiple: true,
    // Без accept: этот проп фильтрует fileList до beforeUpload, и неподходящие файлы (.zip, .7z)
    // пропадали молча, без сообщения об ошибке. Формат и размер проверяет validateFile ниже.
    showUploadList: false,
    disabled: !canAppend || sending,
    // beforeUpload вызывается по файлу; собираем пачку и добавляем одним обновлением
    beforeUpload: (file, fileList) => {
      pendingBatch.current.push(file);
      if (pendingBatch.current.length === fileList.length) {
        const batch = pendingBatch.current;
        pendingBatch.current = [];
        addToStaged(batch);
      }
      return false;
    },
  };

  const registryProps: UploadProps = {
    multiple: false,
    // Без accept — та же причина, что у dropzoneProps: validateFile ниже сообщит о неверном формате сама.
    showUploadList: false,
    disabled: !canAppend || sending,
    beforeUpload: (file) => {
      const problem = validateFile(file, ALLOWED_REGISTRY_EXTENSIONS);
      if (problem) message.error(problem);
      else setRegistryFile(file);
      return false;
    },
  };

  // Название и адрес существующего проекта можно править прямо здесь — сохраняем при выходе из поля
  const saveExistingProject = () => {
    if (!project) return;
    if (!projectName.trim() || !projectAddress.trim()) {
      message.warning('Название и адрес не должны быть пустыми');
      setProjectName(project.name);
      setProjectAddress(project.address);
      return;
    }
    updateProject(project.id, {
      name: projectName.trim(),
      address: projectAddress.trim(),
      developer: details.developer.trim(),
      contractor: details.contractor.trim(),
      permit: details.permit.trim(),
    });
  };

  const handleStageChange = (uid: string, stage: ApiStage) => {
    setStaged((prev) => prev.map((s) => (s.uid === uid ? { ...s, stage } : s)));
  };

  // Стадию для файла из папки и для архива api берёт по названиям папок, вручную её выбирают для отдельных файлов
  const needsNoStage = (file: File) => isArchive(file) || folderPathOf(file) !== '';

  const validateBeforeSend = (): boolean => {
    if (selectedProject === 'new' && (!projectName.trim() || !projectAddress.trim())) {
      message.warning('Заполните название и адрес нового проекта');
      return false;
    }
    if (staged.length === 0 && !registryFile) {
      message.warning('Добавьте хотя бы один документ');
      return false;
    }
    if (staged.some((s) => !s.stage && !needsNoStage(s.file))) {
      message.warning('Выберите стадию для каждого документа');
      return false;
    }
    return true;
  };

  // Запасной режим без api: как в макете, просто заводим демо-проект
  const sendMock = () => {
    let targetId = selectedProject;
    if (selectedProject === 'new') {
      targetId = addProject({
        name: projectName.trim(),
        address: projectAddress.trim(),
        developer: details.developer.trim(),
        contractor: details.contractor.trim(),
        permit: details.permit.trim(),
        docs: (['ПД', 'РД', 'ИД'] as const).map((stage) => ({
          stage,
          loaded: staged.some((s) => s.stage && DOC_STAGE_LABEL[s.stage] === stage),
        })),
        updatedAt: new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', ''),
      });
    }
    navigate(`/verification?object=${targetId}`);
  };

  const handleSend = async () => {
    if (!validateBeforeSend()) return;
    if (isMock) {
      sendMock();
      return;
    }

    setSending(true);
    setSendPercent(0);
    setRegistryErrors([]);
    try {
      let targetObjectId = project?.id;
      if (!targetObjectId) {
        const created = await createObject({
          name: projectName.trim(),
          address: projectAddress.trim(),
          customer: details.developer.trim() || undefined,
          contractor: details.contractor.trim() || undefined,
          permit_number: details.permit.trim() || undefined,
        });
        targetObjectId = created.id;
      }

      if (staged.length === 0 && registryFile && currentProcessId) {
        const result = await uploadRegistry(currentProcessId, registryFile);
        message.success(result.analysis_started ? 'Реестр применён, анализ запущен заново' : 'Реестр применён');
      } else {
        const result = await uploadDocuments(
          {
            files: staged.map(({ file, stage }) => ({ file, stage })),
            registry: registryFile,
            processId: canAppend ? currentProcessId : null,
            objectId: targetObjectId,
          },
          setSendPercent
        );
        setLastUpload(result);
        setCreatedProcessId(result.process_id);
        const rejected = result.files.filter((f) => f.status === 'REJECTED').length;
        if (rejected > 0) message.warning(`Принято ${result.files.length - rejected}, отклонено ${rejected}`);
        else message.success(`Загружено файлов: ${result.files.length}`);
      }

      setStaged([]);
      setRegistryFile(undefined);
      // Проверка ушла на повторный разбор: статус, комплект и файлы перечитываем, опрос включится снова
      await queryClient.invalidateQueries({ queryKey: ['process-status'] });
      void queryClient.invalidateQueries({ queryKey: ['process'] });
      void queryClient.invalidateQueries({ queryKey: ['process-files'] });
      await reload();
      if (selectedProject === 'new') {
        justCreatedRef.current = targetObjectId;
        setSelectedProject(targetObjectId);
      }
    } catch (error) {
      const text = error instanceof UploadFailedError ? error.message : 'Не удалось загрузить документы';
      setRegistryErrors(registryErrorsOf(error));
      message.error(text);
    } finally {
      setSending(false);
    }
  };

  // Ссылка из замечания подсвечивает файл в таблице и прокручивает к нему
  const showFileRow = (fileId: string) => {
    setHighlightFileId(fileId);
    document.getElementById(`file-row-${fileId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => setHighlightFileId((current) => (current === fileId ? null : current)), 3000);
  };

  const refreshProcess = async () => {
    await queryClient.invalidateQueries({ queryKey: ['process-status'] });
    void queryClient.invalidateQueries({ queryKey: ['process'] });
    void queryClient.invalidateQueries({ queryKey: ['process-files'] });
    await reload();
  };

  const pickSignature = (file: FileInfo) => {
    signatureTargetRef.current = file;
    signatureInputRef.current?.click();
  };

  const handleSignatureChosen = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    const target = signatureTargetRef.current;
    event.target.value = '';
    if (!chosen || !target) return;
    const problem = validateSignatureFile(chosen);
    if (problem) {
      message.error(problem);
      return;
    }
    setSignatureBusyId(target.id);
    try {
      await attachSignature(target.id, chosen);
      message.success(`Подпись приложена к «${target.original_name}». Проверка подписи появится в следующей версии`);
      void queryClient.invalidateQueries({ queryKey: ['process-files'] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось приложить подпись');
    } finally {
      setSignatureBusyId(null);
    }
  };

  const handleRevisionSubmit = async (values: { comment: string; reference?: string; predecessorId?: string }) => {
    if (!revisionTarget) return;
    setRevisionSaving(true);
    try {
      await patchFile(
        revisionTarget.file.id,
        revisionTarget.action === 'authoritative'
          ? { is_authoritative: true, comment: values.comment, reference: values.reference }
          : { predecessor_id: values.predecessorId, comment: values.comment, reference: values.reference }
      );
      message.success('Выбор сохранён, комплект пересчитывается');
      setRevisionTarget(null);
      await refreshProcess();
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось сохранить выбор редакции');
    } finally {
      setRevisionSaving(false);
    }
  };

  const serverRows = isMock
    ? (MOCK_DOCS[project?.id ?? ''] ?? []).map((d, i) => ({ key: `mock-${i}`, name: d.name, stage: d.stage as ApiStage | null | undefined, status: 'PARSED' as FileInfo['processing_status'], note: '' }))
    : (filesQuery.data ?? []).map((f) => ({ key: f.id, name: f.original_name, stage: f.doc_stage, status: f.processing_status, note: f.error ?? f.exclusion_reason ?? '', info: f }));

  type Row = { key: string; name: string; stage?: ApiStage | null; status?: FileInfo['processing_status']; note: string; staged?: StagedFile; info?: FileInfo };
  const rows: Row[] = [
    ...serverRows,
    ...staged.map((s) => ({ key: s.uid, name: folderPathOf(s.file) || s.file.name, stage: s.stage, status: undefined, note: '', staged: s })),
  ];

  const [filesQuery2, setFilesQuery2] = React.useState('');
  const rowsShown = (() => {
    const q = filesQuery2.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => [r.name, r.info?.external_file_id, r.info?.revision, r.stage].join(' ').toLowerCase().includes(q));
  })();

  const columns = [
    {
      title: <Text strong style={{ fontSize: 15 }}>Документ</Text>,
      dataIndex: 'name',
      key: 'name',
      className: 'col-wrap',
      render: (text: string, row: Row) => (
        <div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px' }}>
            <FileTextOutlined />
            <Text style={{ fontSize: 14, overflowWrap: 'anywhere' }}>{text}</Text>
            {row.info?.external_file_id ? <Text type="secondary" style={{ fontSize: 12 }}>{row.info.external_file_id}</Text> : null}
            {row.info?.revision ? <Text type="secondary" style={{ fontSize: 12 }}>ред. {row.info.revision}</Text> : null}
            {row.info?.approval_status && row.info.approval_status !== 'UNKNOWN' && (
              <StatusPill color={APPROVAL_STATUS[row.info.approval_status].color}>{APPROVAL_STATUS[row.info.approval_status].label}</StatusPill>
            )}
            {row.info?.is_authoritative && <StatusPill tone="info">Эталон</StatusPill>}
            {row.info?.signature_status && SIGNATURE_PILL[row.info.signature_status] && (
              <StatusPill tone={SIGNATURE_PILL[row.info.signature_status]!.tone}>{SIGNATURE_PILL[row.info.signature_status]!.label}</StatusPill>
            )}
            {row.info?.excluded_from_comparison && <StatusPill tone="default">Не в сравнении</StatusPill>}
          </div>
          {row.info?.title && (
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 2, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
              {row.info.title}
            </Text>
          )}
          {row.info && uploadedLine(row.info.uploaded_by_name, row.info.uploaded_at) && (
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 2 }}>
              {uploadedLine(row.info.uploaded_by_name, row.info.uploaded_at)}
            </Text>
          )}
          {row.info && <DocumentFacts file={row.info} />}
          {row.note && (
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 2, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
              {row.note}
            </Text>
          )}
          {row.info && (
            <FileSignature file={row.info} canAttach={canAppend && !row.info.duplicate_of} busy={signatureBusyId === row.info.id} onPick={() => pickSignature(row.info!)} />
          )}
        </div>
      ),
    },
    {
      title: <Text strong style={{ fontSize: 15 }}>Страниц</Text>,
      key: 'pages',
      width: 104,
      render: (_: unknown, row: Row) => {
        const q = row.info?.quality;
        if (!q?.pages_total) return <Text type="secondary">нет</Text>;
        const detail = [q.pages_text_layer ? `текст: ${q.pages_text_layer}` : '', q.pages_ocr ? `OCR: ${q.pages_ocr}` : '', q.low_quality_pages?.length ? `плохое качество: ${q.low_quality_pages.length}` : '']
          .filter(Boolean)
          .join(', ');
        return (
          <Tooltip title={detail || undefined}>
            <Text>{q.pages_total}</Text>
          </Tooltip>
        );
      },
    },
    {
      title: <Text strong style={{ fontSize: 15 }}>Стадия</Text>,
      key: 'stage',
      width: 190,
      render: (_: unknown, row: Row) =>
        row.staged && needsNoStage(row.staged.file) ? (
          <Text type="secondary">определит система</Text>
        ) : row.staged ? (
          <Select
            value={row.staged.stage}
            placeholder="Выберите стадию"
            onChange={(value: ApiStage) => handleStageChange(row.staged!.uid, value)}
            options={STAGE_OPTIONS}
            popupMatchSelectWidth={false}
            style={{ width: '100%' }}
          />
        ) : row.stage ? (
          <Text style={{ fontSize: 14 }}>{DOC_STAGE_LABEL[row.stage]}</Text>
        ) : (
          <Text type="secondary">определит система</Text>
        ),
    },
    {
      title: <Text strong style={{ fontSize: 15 }}>Статус</Text>,
      key: 'status',
      width: 170,
      render: (_: unknown, row: Row) => {
        if (row.staged) {
          return (
            <Button type="text" size="small" className="negative-action" icon={<DeleteOutlined />} onClick={() => setStaged((prev) => prev.filter((s) => s.uid !== row.staged!.uid))}>
              Убрать
            </Button>
          );
        }
        const meta = row.status ? FILE_PROCESSING_STATUS[row.status] : undefined;
        return (
          <Space size={4}>
            {meta ? <StatusPill color={meta.color}>{meta.label}</StatusPill> : null}
            {row.info && (
              <Dropdown
                trigger={['click']}
                disabled={!canAppend}
                menu={{
                  items: [
                    { key: 'authoritative', label: 'Сделать эталонной редакцией' },
                    { key: 'predecessor', label: 'Указать предыдущую редакцию' },
                  ],
                  onClick: ({ key }) => setRevisionTarget({ file: row.info!, action: key as RevisionAction }),
                }}
              >
                <Button type="text" size="small" icon={<MoreOutlined />} disabled={!canAppend} aria-label="Действия с файлом" />
              </Dropdown>
            )}
          </Space>
        );
      },
    },
  ];

  const progress = statusQuery.data?.progress;
  const statusMeta = processStatus ? PROCESS_STATUS[processStatus] : undefined;
  const completeness = processQuery.data?.completeness;
  const canVerify = Boolean(processQuery.data?.can_verify);
  const sendLabel = selectedProject === 'new' ? 'Добавить проект и отправить на проверку' : canAppend && currentProcessId ? 'Дозагрузить и обновить проверку' : 'Отправить на проверку';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ padding: '16px 24px', background: token.colorBgContainer, borderBottom: `1px solid ${token.colorBorder}` }}>
        <Title level={2} style={{ margin: 0 }}>
          Загрузка документов
        </Title>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        <div style={{ maxWidth: 900, margin: '0 auto' }}>
          <Card style={{ borderRadius: 12, background: token.colorBgContainer, border: `1px solid ${token.colorBorder}` }}>
            <Space direction="vertical" size={24} style={{ width: '100%' }}>
              <div>
                {fieldLabel('Проект')}
                <Select
                  placeholder="Выберите проект или создайте новый"
                  value={selectedProject}
                  onChange={setSelectedProject}
                  showSearch
                  optionFilterProp="label"
                  notFoundContent="Проектов с таким названием нет"
                  options={[...existingProjects.map((p) => ({ value: p.id, label: p.name })), { value: 'new', label: '+ Добавить новый проект' }]}
                  style={{ width: '100%' }}
                  size="large"
                />
              </div>

              {selectedProject && (
                <>
                  <div>
                    {fieldLabel('Название проекта')}
                    <Input value={projectName} onChange={(e) => setProjectName(e.target.value)} onBlur={saveExistingProject} placeholder="Введите название проекта" size="large" />
                  </div>

                  <div>
                    {fieldLabel('Адрес')}
                    <Input value={projectAddress} onChange={(e) => setProjectAddress(e.target.value)} onBlur={saveExistingProject} placeholder="Введите адрес проекта" size="large" />
                  </div>

                  {DETAIL_FIELDS.map((field) => (
                    <div key={field.key}>
                      {fieldLabel(field.label)}
                      <Input
                        value={details[field.key]}
                        onChange={(e) => setDetails((prev) => ({ ...prev, [field.key]: e.target.value }))}
                        onBlur={saveExistingProject}
                        placeholder={field.placeholder}
                        size="large"
                      />
                    </div>
                  ))}

                  {currentProcessId && statusMeta && (
                    <div>
                      {fieldLabel('Состояние проверки')}
                      <Space direction="vertical" size={8} style={{ width: '100%' }}>
                        <Space size={12} wrap>
                          <StatusPill color={statusMeta.color}>{statusMeta.label}</StatusPill>
                          {completeness && <StatusPill color={COMPLETENESS_STATUS[completeness.status].color}>Комплект: {lowerFirst(COMPLETENESS_STATUS[completeness.status].label)}</StatusPill>}
                          {progress?.files_total ? <Text type="secondary">Разобрано файлов: {progress.files_parsed ?? 0} из {progress.files_total}</Text> : null}
                        </Space>
                        {busy && <Progress percent={progress?.percent ?? 0} status="active" strokeColor={token.colorPrimary} />}
                        {statusQuery.data?.error && <Alert type="error" showIcon message={statusQuery.data.error} />}
                        {finalized && <Alert type="info" showIcon message="Проверка финализирована: дозагрузка недоступна." />}
                        {busy && !stalled && <Alert type="info" showIcon message="Идёт разбор документов: дозагрузка станет доступна после его окончания." />}
                        {stalled && (
                          <Alert
                            type="warning"
                            showIcon
                            message="Разбор не двигается больше 5 минут"
                            description="Похоже, часть файлов зависла на стороне разбора. Дождаться окончания может не получиться: создайте новую проверку с тем же комплектом вместо ожидания."
                          />
                        )}
                      </Space>
                    </div>
                  )}

                  {completeness && (
                    <div>
                      {fieldLabel('Комплектность')}
                      <Space direction="vertical" size={8} style={{ width: '100%' }}>
                        <Text type="secondary" style={{ fontSize: 13 }}>
                          {completeness.registry === 'PRESENT' ? `Реестр: ${completeness.registry_file_name ?? 'загружен'}` : 'Реестр не загружен'}
                          {completeness.basis === 'MANIFEST' ? `, ожидалось файлов: ${completeness.expected_total ?? 0}, загружено: ${completeness.present_total ?? 0}` : ''}
                        </Text>
                        {completeness.missing.length > 0 && (
                          <Alert
                            type="warning"
                            showIcon
                            message="Не хватает документов"
                            description={
                              <ul style={{ margin: 0, paddingLeft: 18 }}>
                                {completeness.missing.map((m, i) => (
                                  <li key={i}>
                                    {DOC_STAGE_LABEL[m.doc_stage]}
                                    {m.document_code ? ` ${m.document_code}` : ''}
                                    {m.file_name ? `: ${m.file_name}` : ''}
                                  </li>
                                ))}
                              </ul>
                            }
                          />
                        )}
                        {completeness.issues.length > 0 && (
                          <Alert
                            type="warning"
                            showIcon
                            message="Комплектность"
                            description={
                              <ul style={{ margin: 0, paddingLeft: 18 }}>
                                {completeness.issues.slice(0, 8).map((issue, i) => (
                                  <li key={i}>
                                    {REGISTRY_ISSUE[issue.code]}
                                    {issue.file_name && issue.file_id ? (
                                      <>
                                        {': '}
                                        <a onClick={() => showFileRow(issue.file_id!)}>{issue.file_name}</a>
                                      </>
                                    ) : issue.file_name ? (
                                      `: ${issue.file_name}`
                                    ) : (
                                      ''
                                    )}
                                  </li>
                                ))}
                                {completeness.issues.length > 8 && <li>и ещё {completeness.issues.length - 8}</li>}
                              </ul>
                            }
                          />
                        )}
                      </Space>
                    </div>
                  )}

                  <div ref={uploadSectionRef}>
                    {fieldLabel('Загрузка документов', 16)}
                    <Space direction="vertical" size={16} style={{ width: '100%' }}>
                      <Dragger {...dropzoneProps} style={{ background: token.colorBgContainer }}>
                        <p className="ant-upload-drag-icon">
                          <InboxOutlined style={{ color: token.colorPrimary, fontSize: 48 }} />
                        </p>
                        <Text strong style={{ fontSize: 16, display: 'block', marginBottom: 8 }}>
                          Нажмите или перетащите файлы
                        </Text>
                        <Text type="secondary" style={{ fontSize: 14 }}>
                          PDF, DOCX, XML: до {MAX_FILE_MB} МБ на файл и {MAX_BATCH_MB} МБ на пакет. Можно выбрать несколько файлов, папку или архив ZIP (до {MAX_BATCH_MB} МБ): система раскроет его сама.
                        </Text>
                      </Dragger>
                      <input
                        ref={folderInputRef}
                        type="file"
                        multiple
                        style={{ display: 'none' }}
                        // webkitdirectory нет в типах React, но его понимают все браузеры
                        {...({ webkitdirectory: '' } as Record<string, string>)}
                        onChange={(e) => {
                          const chosen = Array.from(e.target.files ?? []);
                          e.target.value = '';
                          if (chosen.length > 0) addToStaged(chosen);
                        }}
                      />
                      <Button icon={<FolderOpenOutlined />} disabled={!canAppend || sending} onClick={() => folderInputRef.current?.click()}>
                        Выбрать папку
                      </Button>

                      <div>
                        {fieldLabel('Реестр файлов комплекта (CSV, XLSX или JSON)', 8)}
                        <Space size={12} wrap>
                          <Upload {...registryProps}>
                            <Button disabled={!canAppend || sending}>{registryFile ? 'Заменить файл реестра' : 'Выбрать реестр'}</Button>
                          </Upload>
                          {registryFile && (
                            <Space size={4}>
                              <Text>{registryFile.name}</Text>
                              <Button type="text" size="small" icon={<DeleteOutlined />} aria-label="Убрать файл реестра" title="Убрать файл реестра" onClick={() => setRegistryFile(undefined)} />
                            </Space>
                          )}
                        </Space>
                        {!registryFile && (registryAbsent || !currentProcessId) && (
                          <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 13 }}>
                            Без реестра комплект будет принят со статусом «Требует уточнения».
                          </Text>
                        )}
                      </div>
                    </Space>
                  </div>

                  <div>
                    {registryErrors.length > 0 && (
                      <Alert
                        type="error"
                        showIcon
                        style={{ marginBottom: 16 }}
                        message="Реестр не принят: исправьте строки и загрузите снова"
                        description={
                          <ul style={{ margin: 0, paddingLeft: 18 }}>
                            {registryErrors.slice(0, 10).map((line, i) => (
                              <li key={i}>{line}</li>
                            ))}
                            {registryErrors.length > 10 && <li>и ещё {registryErrors.length - 10}</li>}
                          </ul>
                        }
                      />
                    )}
                    {fieldLabel('Документы проверки', 12)}
                    {rows.length > 0 && (
                      <Input
                        allowClear
                        prefix={<SearchOutlined />}
                        placeholder="Поиск по документам: название, шифр, стадия"
                        value={filesQuery2}
                        onChange={(e) => setFilesQuery2(e.target.value)}
                        style={{ marginBottom: 12, maxWidth: 420 }}
                      />
                    )}
                    <Table
                      dataSource={rowsShown}
                      columns={columns}
                      pagination={{ defaultPageSize: 10, hideOnSinglePage: true, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'] }}
                      size="middle"
                      tableLayout="fixed"
                      scroll={{ x: 740 }}
                      onRow={(row) => ({
                        id: row.info ? `file-row-${row.info.id}` : undefined,
                        style: row.info && row.info.id === highlightFileId ? { background: token.colorPrimaryBg } : undefined,
                      })}
                      loading={filesQuery.isFetching && rows.length === 0}
                      style={{ marginBottom: 16 }}
                      locale={{ emptyText: <TableEmpty hint="Перетащите файлы, папку или архив в область загрузки выше: стадию документа система определит сама.">Нет загруженных документов</TableEmpty> }}
                    />

                    {lastUpload && lastUpload.files.some((f) => f.status === 'REJECTED' || (f.warnings && f.warnings.length > 0)) && (
                      <Alert
                        type="warning"
                        showIcon
                        style={{ marginBottom: 16 }}
                        message="Результат последней загрузки"
                        description={
                          <ul style={{ margin: 0, paddingLeft: 18 }}>
                            {lastUpload.files.flatMap((f) => [
                              ...(f.error ? [<li key={`${f.original_name}-e`}>«{f.original_name}» отклонён: {f.error.message}</li>] : []),
                              ...(f.warnings ?? []).map((w, i) => (
                                <li key={`${f.original_name}-${i}`}>
                                  «{f.original_name}»: {REGISTRY_ISSUE[w.code]}
                                </li>
                              )),
                            ])}
                          </ul>
                        }
                      />
                    )}

                    {sending && <Progress percent={sendPercent} style={{ marginBottom: 12 }} strokeColor={token.colorPrimary} />}

                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      <Button
                        type="primary"
                        size="large"
                        block
                        loading={sending}
                        disabled={(staged.length === 0 && !registryFile) || (!isMock && !canAppend)}
                        onClick={handleSend}
                      >
                        {sendLabel}
                      </Button>
                      {(canVerify || isMock) && project && (
                        <Button size="large" block onClick={() => navigate(`/verification?object=${project.id}`)}>
                          Перейти к верификации
                        </Button>
                      )}
                    </Space>
                  </div>
                </>
              )}
            </Space>
          </Card>
        </div>
      </div>

      <input ref={signatureInputRef} type="file" accept=".sig,.p7s,.sgn" style={{ display: 'none' }} onChange={(e) => void handleSignatureChosen(e)} />

      <FileRevisionModal
        file={revisionTarget?.file ?? null}
        action={revisionTarget?.action ?? null}
        siblings={filesQuery.data ?? []}
        saving={revisionSaving}
        onCancel={() => setRevisionTarget(null)}
        onSubmit={handleRevisionSubmit}
      />
    </div>
  );
};
