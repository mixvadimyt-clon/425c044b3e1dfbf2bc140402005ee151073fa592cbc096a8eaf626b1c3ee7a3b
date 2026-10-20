import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '@/app/providers/AuthProvider';
import type { UserRole } from '@/shared/types';
import { TrainingPage } from './TrainingPage';

const loginAs = (role: UserRole) => {
  localStorage.setItem('auth_token', 't');
  localStorage.setItem('user', JSON.stringify({ id: '1', login: 'u', full_name: 'Тест', role }));
};

const renderPage = () => {
  const view = renderRaw();
  // Сначала вводный экран: уроки открываются кнопкой «Начать обучение»
  fireEvent.click(screen.getByRole('button', { name: 'Начать обучение' }));
  return view;
};

const renderRaw = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AuthProvider>
        <MemoryRouter initialEntries={['/training']}>
          <Routes>
            <Route path="/training" element={<TrainingPage />} />
            <Route path="/dashboard" element={<div>дашборд-заглушка</div>} />
          </Routes>
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );

const press = (key: string, code?: string) => act(() => void fireEvent.keyDown(window, { key, code }));
const openLesson = (title: string) => fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^\\d+\\. ${title}$`) }));
const understood = () => fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
const stepText = () => document.querySelector('.training-coach')?.textContent ?? '';
// Окно выхода открыто, если его обёртка не скрыта: после закрытия antd оставляет её в DOM с display: none
const exitModalOpen = () => {
  const wrap = document.querySelector<HTMLElement>('.ant-modal-wrap');
  return Boolean(wrap) && wrap!.style.display !== 'none';
};
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 60))));

/** Верификация: десять шагов, дальше блок «Решение инспектора». */
const walkToDecision = () => {
  openLesson('Верификация');
  for (let i = 0; i < 10; i += 1) understood();
};

// Учебные экраны на настоящих компонентах antd: в jsdom они отрисовываются небыстро
describe('TrainingPage', { timeout: 300000 }, () => {
  // jsdom не умеет getComputedStyle с псевдоэлементом, а окно antd просит его при блокировке прокрутки
  beforeAll(() => {
    const original = window.getComputedStyle.bind(window);
    window.getComputedStyle = ((element: Element) => original(element)) as typeof window.getComputedStyle;
    // antd Table и сетка спрашивают matchMedia, которого в jsdom нет
    // и scrollIntoView, к которому прокручивают карточки дашборда
    Element.prototype.scrollIntoView = () => {};
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({ matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false }),
    });
  });
  beforeEach(() => localStorage.clear());

  it('сначала вводный экран с кнопкой «Начать обучение», уроки открываются после неё', () => {
    loginAs('INSPECTOR');
    renderRaw();
    expect(screen.getByText('Как работает обучение')).toBeInTheDocument();
    expect(screen.queryByText('Урок 1 из 8')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Начать обучение' }));
    expect(screen.getByText('Урок 1 из 8')).toBeInTheDocument();
  });

  it('инспектору показывает свои уроки, а супервизору — расширенный набор', () => {
    loginAs('INSPECTOR');
    const { unmount } = renderPage();
    expect(screen.queryByText(/Версии и модели/)).toBeNull();
    expect(screen.getByText(/^3\. Дашборд$/)).toBeInTheDocument();
    unmount();
    loginAs('SUPERVISOR');
    renderPage();
    expect(screen.getByText(/Версии и модели/)).toBeInTheDocument();
    expect(screen.getByText(/Откат финализации/)).toBeInTheDocument();
  });

  it('уроки переключаются вкладками; после последнего Enter спрашивает, закончить ли обучение, «Да» ведёт на дашборд', async () => {
    loginAs('INSPECTOR');
    renderPage();
    expect(screen.getByText('Урок 1 из 8')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Дальше' })).toBeNull();
    openLesson('Дашборд');
    expect(screen.getByText('Урок 3 из 8')).toBeInTheDocument();
    openLesson('Интеграция');
    expect(screen.getByText('Урок 8 из 8')).toBeInTheDocument();
    for (let i = 0; i < 5; i += 1) press('Enter');
    expect(stepText()).toContain('Урок пройден');
    press('Enter');
    expect(await screen.findByText(/Вы прошли все уроки/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Да' }));
    expect(screen.getByText('дашборд-заглушка')).toBeInTheDocument();
  });

  it('урок ведёт за руку: шаг засчитывается только нужным действием, остальное игнорируется с напоминанием', () => {
    loginAs('INSPECTOR');
    renderPage();
    openLesson('Дашборд');
    expect(stepText()).toContain('Шаг 1 из 6');
    // шаг-пояснение: «Дозагрузка» на экране не засчитывается, подсказка просит нажать «Далее»
    fireEvent.click(screen.getByRole('button', { name: /Дозагрузка/ }));
    expect(stepText()).toContain('Шаг 1 из 6');
    expect(stepText()).toContain('Сейчас достаточно нажать «Далее»');
    for (let i = 0; i < 6; i += 1) understood();
    expect(stepText()).toContain('Урок пройден');
  });

  it('Enter проходит урок за вас: пояснения закрывает, на шагах с действием делает действие', () => {
    loginAs('INSPECTOR');
    renderPage();
    openLesson('Дашборд');
    for (let i = 0; i < 6; i += 1) press('Enter');
    expect(stepText()).toContain('Урок пройден');
    // ещё один Enter открывает следующий урок
    press('Enter');
    expect(screen.getByText('Урок 4 из 8')).toBeInTheDocument();
  });

  it('Enter в загрузке выбирает проект, подтягивает файлы и отправляет', () => {
    loginAs('INSPECTOR');
    renderPage();
    openLesson('Загрузка');
    for (let i = 0; i < 7; i += 1) press('Enter');
    expect(stepText()).toContain('Урок пройден');
  });

  it('Enter в верификации отправляет уточнение, открывает причины, подставляет комментарий и отправляет его', () => {
    loginAs('INSPECTOR');
    renderPage();
    openLesson('Верификация');
    for (let i = 0; i < 15; i += 1) press('Enter');
    expect(stepText()).toContain('Урок пройден');
    expect(screen.getAllByText('2/3 проверено').length).toBeGreaterThan(0);
  });

  it('Esc на уроке выходит из урока (досрочно), второй Esc спрашивает про обучение; «Нет» остаётся, «Да» уходит на дашборд', async () => {
    loginAs('INSPECTOR');
    renderPage();
    press('Escape');
    expect(stepText()).toContain('Урок завершён досрочно');
    expect(exitModalOpen()).toBe(false);
    press('Escape');
    expect(await screen.findByText('Закончить обучение?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Нет' }));
    await waitFor(() => expect(exitModalOpen()).toBe(false));
    expect(screen.queryByText('дашборд-заглушка')).toBeNull();
    press('Escape');
    fireEvent.click(await screen.findByRole('button', { name: 'Да' }));
    expect(screen.getByText('дашборд-заглушка')).toBeInTheDocument();
  });

  it('кнопка «Выйти из обучения» тоже открывает окно, а Esc внутри окна равен «Нет»', async () => {
    loginAs('INSPECTOR');
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Выйти из обучения' }));
    expect(await screen.findByText('Закончить обучение?')).toBeInTheDocument();
    expect(exitModalOpen()).toBe(true);
    press('Escape');
    await waitFor(() => expect(exitModalOpen()).toBe(false));
    // тот же Esc не открыл окно заново, и на дашборд мы не ушли
    await settle();
    expect(exitModalOpen()).toBe(false);
    expect(screen.queryByText('дашборд-заглушка')).toBeNull();
  });

  it('верификация: блок решения, форма комментария у «Уточнить» и у «Отклонить», потом «Изменить решение»', () => {
    loginAs('INSPECTOR');
    renderPage();
    walkToDecision();
    expect(stepText()).toContain('Шаг 11 из 15');
    // клавиша 2 сейчас не нужна: список причин не открывается
    press('2');
    expect(screen.queryByText('Неверная редакция')).toBeNull();
    expect(stepText()).toContain('Сейчас достаточно нажать «Далее»');
    // «Далее» открывает форму уточнения: комментарий обязателен
    understood();
    expect(stepText()).toContain('Шаг 12 из 15');
    expect(screen.getByText('Что нужно уточнить *')).toBeInTheDocument();
    expect(screen.getAllByText('0/3 проверено').length).toBeGreaterThan(0);
    // «Далее» отправляет уточнение и открывает список причин у другого кандидата
    understood();
    expect(stepText()).toContain('Шаг 13 из 15');
    expect(screen.getAllByText('1/3 проверено').length).toBeGreaterThan(0);
    expect(screen.getByText('Неверная редакция')).toBeInTheDocument();
    understood();
    expect(stepText()).toContain('Шаг 14 из 15');
    expect(screen.getByRole('button', { name: 'Отправить на дообучение' })).toBeInTheDocument();
    // решение сохраняется только после отправки комментария
    expect(screen.getAllByText('1/3 проверено').length).toBeGreaterThan(0);
    understood();
    expect(stepText()).toContain('Шаг 15 из 15');
    expect(screen.getAllByText('2/3 проверено').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Изменить решение/ })).toBeInTheDocument();
    understood();
    expect(stepText()).toContain('Урок пройден');
  });

  it('после прохождения урока экран свободный: «Изменить решение» возвращает кнопки, клавиши работают', () => {
    loginAs('INSPECTOR');
    renderPage();
    walkToDecision();
    for (let i = 0; i < 5; i += 1) understood();
    expect(stepText()).toContain('Урок пройден');
    // у кандидата с решением кнопок решения нет, клавиша 2 молчит
    press('2');
    expect(screen.queryByRole('button', { name: /Неверная редакция/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Изменить решение/ }));
    expect(screen.getAllByText('1/3 проверено').length).toBeGreaterThan(0);
    press('2');
    expect(screen.getByText('Неверная редакция')).toBeInTheDocument();
    press('Escape');
    expect(screen.queryByText('Неверная редакция')).toBeNull();
  });

  it('полный экран: F входит, панель «Проверка» свёрнута, решение клавишей, Esc выходит без окна выхода', async () => {
    loginAs('INSPECTOR');
    renderPage();
    openLesson('Полный экран');
    press('f', 'KeyF');
    expect(await screen.findByRole('button', { name: /Показать проверку/ })).toBeInTheDocument();
    expect(stepText()).toContain('Шаг 2 из 8');
    fireEvent.click(screen.getByRole('button', { name: /Показать список/ }));
    expect(screen.getByText('Кандидаты')).toBeInTheDocument();
    expect(stepText()).toContain('Шаг 3 из 8');
    understood();
    expect(stepText()).toContain('Шаг 4 из 8');
    fireEvent.click(screen.getByRole('button', { name: /Показать проверку/ }));
    expect(screen.getByRole('button', { name: /Свернуть проверку/ })).toBeInTheDocument();
    expect(stepText()).toContain('Шаг 5 из 8');
    understood();
    expect(stepText()).toContain('Шаг 6 из 8');
    press('1');
    expect(stepText()).toContain('Шаг 7 из 8');
    // Шаг про перетаскивание и размер панелей: последний перед выходом
    expect(stepText()).toContain('перетащить за заголовок');
    understood();
    expect(stepText()).toContain('Шаг 8 из 8');
    press('Escape');
    expect(screen.queryByRole('button', { name: /Показать проверку/ })).toBeNull();
    await settle();
    expect(exitModalOpen()).toBe(false);
    expect(stepText()).toContain('Урок пройден');
  });

  it('в полном экране Esc раньше времени выходит из урока, а не закрывает экран и не открывает окно выхода', async () => {
    loginAs('INSPECTOR');
    renderPage();
    openLesson('Полный экран');
    press('f', 'KeyF');
    await screen.findByRole('button', { name: /Показать проверку/ });
    press('Escape');
    await settle();
    expect(stepText()).toContain('Урок завершён досрочно');
    expect(exitModalOpen()).toBe(false);
  });

  it('пока открыто окно выхода, клавиши учебного экрана молчат', async () => {
    loginAs('INSPECTOR');
    renderPage();
    walkToDecision();
    fireEvent.click(screen.getByRole('button', { name: 'Выйти из обучения' }));
    await screen.findByText('Закончить обучение?');
    press('2');
    expect(screen.queryByText('Неверная редакция')).toBeNull();
    expect(stepText()).toContain('Шаг 11 из 15');
  });

  it('у супервизора есть уроки отката и «Версии и модели»', () => {
    loginAs('SUPERVISOR');
    renderPage();
    openLesson('Откат финализации');
    expect(stepText()).toContain('Шаг 1 из 3');
    understood();
    expect(stepText()).toContain('Шаг 2 из 3');
    understood();
    expect(stepText()).toContain('Шаг 3 из 3');
    understood();
    expect(stepText()).toContain('Урок пройден');
    openLesson('Версии и модели');
    understood();
    expect(stepText()).toContain('Шаг 2 из 4');
    expect(screen.getByRole('tab', { name: 'Модели' })).toHaveAttribute('aria-selected', 'true');
    understood();
    expect(screen.getByRole('tab', { name: 'Недельный отчёт' })).toHaveAttribute('aria-selected', 'true');
  });

  it('«Назад»: на первом шаге кнопки нет, на пояснении возвращает на шаг назад', async () => {
    loginAs('INSPECTOR');
    renderPage();
    openLesson('Дашборд');
    expect(screen.queryByRole('button', { name: 'Назад' })).toBeNull();
    press('Enter');
    expect(stepText()).toContain('Шаг 2 из 6');
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    await waitFor(() => expect(stepText()).toContain('Шаг 1 из 6'), { timeout: 10000 });
  }, 30000);

  it('«Назад» после решений в верификации возвращает экран в состояние того шага', () => {
    loginAs('INSPECTOR');
    renderPage();
    walkToDecision();
    understood();
    understood();
    expect(stepText()).toContain('Шаг 13 из 15');
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    // сразу предыдущий шаг: форма уточнения открыта, решения ещё нет
    expect(stepText()).toContain('Шаг 12 из 15');
    expect(screen.getByText('Что нужно уточнить *')).toBeInTheDocument();
    expect(screen.getAllByText('0/3 проверено').length).toBeGreaterThan(0);
  });

});
