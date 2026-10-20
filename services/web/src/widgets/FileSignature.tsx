import React from 'react';
import { Button, Tooltip, Typography } from 'antd';
import { PaperClipOutlined } from '@ant-design/icons';
import { StatusPill } from './StatusPill';
import { SIGNATURE_EXTENSIONS, SIGNATURE_MAX_BYTES, SIGNATURE_NOT_VERIFIED_NOTE, formatFileSize } from '@/api/signature';
import { formatDateTime } from '@/api/protocols';
import type { FileInfo } from '@/api/processes';

const { Text } = Typography;

interface Props {
  file: FileInfo;
  /** Приложить подпись можно, пока проверка не финализирована и не идёт разбор. */
  canAttach: boolean;
  busy: boolean;
  onPick: () => void;
}

/** Электронная подпись файла в таблице загрузки: кнопка «Приложить / Заменить подпись» и сведения о приложенном файле. */
export const FileSignature: React.FC<Props> = ({ file, canAttach, busy, onPick }) => {
  const signature = file.signature;
  if (!signature && !canAttach) return null;
  return (
    <div style={{ marginTop: 4 }}>
      {signature && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 8px' }}>
            <StatusPill tone="default">Подпись приложена, не проверена</StatusPill>
            <Tooltip
              title={
                <>
                  SHA-256: {signature.sha256}
                  <br />
                  Приложена {formatDateTime(signature.uploaded_at)}
                </>
              }
            >
              <Text style={{ fontSize: 12, overflowWrap: 'anywhere' }}>
                <PaperClipOutlined /> {signature.file_name}, {formatFileSize(signature.size_bytes)}, SHA-256 {signature.sha256.slice(0, 10)}…
              </Text>
            </Tooltip>
          </div>
          <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
            {SIGNATURE_NOT_VERIFIED_NOTE}
          </Text>
        </>
      )}
      {canAttach && (
        <Tooltip title={`Открепленная подпись ${SIGNATURE_EXTENSIONS.join(', ')} до ${SIGNATURE_MAX_BYTES / 1024} КБ. ${SIGNATURE_NOT_VERIFIED_NOTE}`}>
          <Button type="link" size="small" icon={<PaperClipOutlined />} loading={busy} onClick={onPick} style={{ padding: 0, height: 'auto' }}>
            {signature ? 'Заменить подпись' : 'Приложить подпись'}
          </Button>
        </Tooltip>
      )}
    </div>
  );
};
