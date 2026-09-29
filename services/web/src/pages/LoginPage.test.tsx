import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from 'antd';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/app/providers/AuthProvider';
import { LoginPage } from './LoginPage';

const get = vi.fn();
const post = vi.fn();
vi.mock('@/api/client', () => ({ apiClient: { GET: (...args: unknown[]) => get(...args), POST: (...args: unknown[]) => post(...args) } }));

// Форма antd опирается на сетку, а сетка — на matchMedia, которого в jsdom нет
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

const renderLogin = () =>
  render(
    <App>
      <AuthProvider>
        <MemoryRouter initialEntries={['/login']}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<div>главная-заглушка</div>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </App>,
  );

describe('LoginPage: открытый вход на время экспертизы', () => {
  beforeEach(() => {
    localStorage.clear();
    get.mockReset();
    post.mockReset();
  });

  it('кнопки ролей входят без пароля', async () => {
    get.mockResolvedValue({
      data: {
        open_access: true,
        accounts: [
          { login: 'inspector', full_name: 'Инспектор', role: 'INSPECTOR' },
          { login: 'admin', full_name: 'Администратор', role: 'ADMIN' },
        ],
      },
    });
    post.mockResolvedValue({
      data: { access_token: 't', expires_in: 3600, user: { id: '1', login: 'admin', full_name: 'Администратор', role: 'ADMIN' } },
      response: new Response(null, { status: 200 }),
    });
    renderLogin();
    expect(await screen.findByRole('button', { name: /Войти: Инспектор · inspector/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Войти: Администратор · admin/ }));
    expect(await screen.findByText('главная-заглушка')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/api/v1/auth/options');
    expect(post).toHaveBeenCalledWith('/api/v1/auth/login', { body: { login: 'admin', password: '' } });
  });

  it('без открытого входа — только форма с паролем', async () => {
    get.mockResolvedValue({ data: { open_access: false, accounts: [] } });
    renderLogin();
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByText(/вход открыт/)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Пароль')).toBeInTheDocument();
  });
});
