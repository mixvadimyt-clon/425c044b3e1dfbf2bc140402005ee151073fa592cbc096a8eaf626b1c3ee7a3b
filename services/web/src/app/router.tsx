import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './providers/useAuth';
import { LoginPage } from '@/pages/LoginPage';
import { WorkspaceLayout } from '@/app/layouts/WorkspaceLayout';
import { DashboardPage } from '@/pages/DashboardPage';
import { UploadPage } from '@/pages/UploadPage';
import { VerificationPage } from '@/pages/VerificationPage';
import { ProtocolPage } from '@/pages/ProtocolPage';
import { AdminPage } from '@/pages/AdminPage';
import { MlflowPage } from '@/pages/MlflowPage';
import { IntegrationPage } from '@/pages/IntegrationPage';
import { MlPage } from '@/pages/MlPage';
import type { UserRole } from '@/shared/types';

interface ProtectedRouteProps {
  children: React.ReactNode;
  allowedRoles?: UserRole[];
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children, allowedRoles }) => {
  const { isAuthenticated, user } = useAuth();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (allowedRoles && user && !allowedRoles.includes(user.role)) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
};

export const AppRouter: React.FC = () => {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/*"
          element={
            <ProtectedRoute>
              <WorkspaceLayout />
            </ProtectedRoute>
          }
        >
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="upload" element={<UploadPage />} />
          <Route path="verification" element={<VerificationPage />} />
          <Route path="protocol" element={<ProtocolPage />} />
          <Route path="projects/:projectId/verification" element={<VerificationPage />} />
          <Route path="projects/:projectId/protocol" element={<ProtocolPage />} />
          <Route
            path="admin"
            element={
              <ProtectedRoute allowedRoles={['ADMIN']}>
                <AdminPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="experiments"
            element={
              <ProtectedRoute allowedRoles={['ADMIN', 'ML_ENGINEER']}>
                <MlflowPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="integration"
            element={
              <ProtectedRoute allowedRoles={['INSPECTOR', 'SUPERVISOR']}>
                <IntegrationPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="ml"
            element={
              <ProtectedRoute allowedRoles={['ML_ENGINEER', 'ADMIN', 'SUPERVISOR']}>
                <MlPage />
              </ProtectedRoute>
            }
          />
          <Route index element={<Navigate to="/dashboard" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
};
