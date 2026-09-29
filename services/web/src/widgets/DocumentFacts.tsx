import React from 'react';
import { Typography } from 'antd';
import { StatusPill } from './StatusPill';
import { documentFacts } from '@/shared/documentFacts';
import type { FileInfo } from '@/api/processes';

const { Text } = Typography;

/** Сведения о документе из разбора под названием файла: шифр, язык, доля сканов, чем сделан PDF; зашифрованный PDF помечен отдельно. */
export const DocumentFacts: React.FC<{ file: FileInfo }> = ({ file }) => {
  const facts = documentFacts(file);
  if (facts.length === 0 && !file.encrypted) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 8px', marginTop: 2 }}>
      {file.encrypted && <StatusPill tone="error">PDF зашифрован</StatusPill>}
      {facts.length > 0 && (
        <Text type="secondary" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>
          {facts.join(', ')}
        </Text>
      )}
    </div>
  );
};
