import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '@/app/providers/AuthProvider';
import type { UserRole } from '@/shared/types';
import { ProjectNotSelected } from './ProjectNotSelected';

const loginAs = (role: UserRole) => {
  localStorage.setItem('auth_token', 't');
  localStorage.setItem('user', JSON.stringify({ id: '1', login: 'u', full_name: 'Тест', role }));
};

const renderAt = (path: string, context: 'protocol' | 'verification') =>
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/protocol" element={<ProjectNotSelected context={context} />} />
          <Route path="/verification" element={<ProjectNotSelected context={context} />} />
          <Route path="/dashboard" element={<div>дашборд-заглушка</div>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );

describe('ProjectNotSelected: подсказка на странице протокола и верификации без выбранного проекта', () => {
  beforeEach(() => localStorage.clear());

  it('инспектору ссылается на таблицу «Проекты на проверке» независимо от страницы', () => {
    loginAs('INSPECTOR');
    renderAt('/verification', 'verification');
    expect(screen.getByText(/таблице «Проекты на проверке»/)).toBeInTheDocument();
  });

  it('администратору в протоколе ссылается на «Запросы на откат финализации»', () => {
    loginAs('ADMIN');
    renderAt('/protocol', 'protocol');
    expect(screen.getByText(/таблице «Запросы на откат финализации»/)).toBeInTheDocument();
  });

  it('администратору в верификации ссылается на «Записи для дообучения»', () => {
    loginAs('ADMIN');
    renderAt('/verification', 'verification');
    expect(screen.getByText(/таблице «Записи для дообучения»/)).toBeInTheDocument();
  });

  it('кнопка «К дашборду» ведёт на дашборд', () => {
    loginAs('INSPECTOR');
    renderAt('/protocol', 'protocol');
    fireEvent.click(screen.getByRole('button', { name: 'К дашборду' }));
    expect(screen.getByText('дашборд-заглушка')).toBeInTheDocument();
  });

  it('заголовок можно заменить (разбор дообучения: выбирают запись, а не проект)', () => {
    loginAs('ADMIN');
    render(
      <AuthProvider>
        <MemoryRouter>
          <ProjectNotSelected context="verification" heading="Запись не выбрана" />
        </MemoryRouter>
      </AuthProvider>,
    );
    expect(screen.getByText('Запись не выбрана')).toBeInTheDocument();
    expect(screen.getByText(/таблице «Записи для дообучения»/)).toBeInTheDocument();
  });
});
