import React from 'react';
import { AntdConfigProvider } from './providers/AntdConfigProvider';
import { ReactQueryProvider } from './providers/ReactQueryProvider';
import { AuthProvider } from './providers/AuthProvider';
import { ProjectProvider } from './providers/ProjectProvider';
import { AppRouter } from './router';

export const App: React.FC = () => {
  return (
    <AntdConfigProvider>
      <ReactQueryProvider>
        <AuthProvider>
          <ProjectProvider>
            <AppRouter />
          </ProjectProvider>
        </AuthProvider>
      </ReactQueryProvider>
    </AntdConfigProvider>
  );
};
