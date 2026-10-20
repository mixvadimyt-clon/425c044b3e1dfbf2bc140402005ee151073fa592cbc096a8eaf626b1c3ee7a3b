import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { VerificationScene } from './VerificationScene';

// После урока экран свободный: act пропускает всё, как при ручной работе
const renderScene = () =>
  render(<VerificationScene step={undefined} act={() => true} coach={null} paused={false} registerEscape={() => undefined} registerEnter={() => undefined} />);

const listItem = (code: string, index = 0) => screen.getAllByText(code, { selector: '.code' })[index].closest('.finding-item') as HTMLElement;

describe('учебная верификация: всё как в настоящей, без сохранения', { timeout: 120000 }, () => {
  beforeAll(() => {
    const original = window.getComputedStyle.bind(window);
    window.getComputedStyle = ((element: Element) => original(element)) as typeof window.getComputedStyle;
    window.matchMedia =
      window.matchMedia ||
      ((query: string) => ({ matches: false, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined, addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false }) as MediaQueryList);
    Element.prototype.scrollIntoView = () => undefined;
    // ResizeObserver нужен режиму «Сравнение листов»
    window.ResizeObserver =
      window.ResizeObserver ||
      (class {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver);
  });
  afterEach(() => cleanup());

  it('кнопка «?» открывает окно с горячими клавишами', async () => {
    renderScene();
    fireEvent.click(screen.getByRole('button', { name: 'Горячие клавиши' }));
    expect(await screen.findByText('Горячие клавиши верификации')).toBeInTheDocument();
    expect(screen.getByText(/Разделить на части \(у составного несоответствия\)/)).toBeInTheDocument();
  });

  it('«Уточнить» открывает форму с обязательным комментарием, после отправки комментарий виден в карточке и в истории', () => {
    renderScene();
    fireEvent.click(screen.getByRole('button', { name: /Уточнить/ }));
    expect(screen.getByText('Что нужно уточнить *')).toBeInTheDocument();
    const send = screen.getByRole('button', { name: 'Отправить на уточнение' });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('Опишите, что нужно уточнить…'), { target: { value: 'Какая редакция площади действует' } });
    fireEvent.click(send);
    expect(screen.getAllByText('1/3 проверено').length).toBeGreaterThan(0);
    // список остаётся на месте, у кандидата плашка «Уточнено»
    expect(within(listItem('M-002')).getByText('УТОЧНЕНО')).toBeInTheDocument();
    fireEvent.click(listItem('M-002'));
    expect(screen.getAllByText('Какая редакция площади действует').length).toBeGreaterThan(0);
    expect(screen.getByText('История решений (1)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Изменить решение/ })).toBeInTheDocument();
  });

  it('у параметра с двумя кандидатами работает массовый выбор с подтверждением', async () => {
    renderScene();
    fireEvent.click(listItem('M-055', 0));
    fireEvent.click(screen.getByRole('button', { name: /Выбрать все по M-055: 2 шт\. и решить сразу/ }));
    expect(screen.getByText('Выбрано: 2 по M-055')).toBeInTheDocument();
    expect(screen.getByText(/Массового отклонения нет/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Подтвердить: 2 шт\./ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Подтвердить' }));
    await waitFor(() => expect(screen.getAllByText('2/3 проверено').length).toBeGreaterThan(0));
  });

  it('есть выбор раздела и фильтр «Только эта страница»', () => {
    renderScene();
    expect(screen.getByText('Все разделы (3)')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Только эта страница/));
    // у открытого M-002 нет общих страниц с другими кандидатами: из кандидатов остаётся он один, затем две гипотезы
    expect(screen.getByText(/1 из 3/)).toBeInTheDocument();
  });

  it('«Править доказательства» открывает редактор настоящего вида и закрывается кнопкой «Отмена»', () => {
    renderScene();
    fireEvent.click(screen.getByRole('button', { name: /Править доказательства/ }));
    expect(screen.getByTestId('evidence-editor')).toBeInTheDocument();
    expect(screen.getByText('Нарисуйте рамку на странице или уберите фрагмент')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(screen.queryByTestId('evidence-editor')).toBeNull();
  });

  it('«Разделить на части» открывает форму разделения', async () => {
    renderScene();
    fireEvent.click(screen.getByRole('button', { name: /Разделить на части/ }));
    expect(await screen.findByText('Разделить кандидата на части')).toBeInTheDocument();
  });

  it('гипотеза открывается из списка, её можно отклонить с комментарием, плашка меняется', async () => {
    renderScene();
    fireEvent.click(screen.getByText(/^Гипотеза: Логика/).closest('.finding-item') as HTMLElement);
    expect(screen.getByText('Уверенность 72 %')).toBeInTheDocument();
    // у гипотезы те же кнопки над документами и три панели ПД / РД / ИД, у стадии без области пустая
    expect(screen.getByRole('button', { name: /Во весь экран/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Панели ПД/ })).toBeInTheDocument();
    expect(screen.getByText('Документы стадии ИД загружены, но у гипотезы нет области на этой стадии.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Отклонить/ }));
    fireEvent.change(screen.getByPlaceholderText('Обоснование решения…'), { target: { value: 'Показатель не обязателен' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Отклонить гипотезу' }));
    });
    const row = screen.getByText(/^Гипотеза: Логика/).closest('.finding-item') as HTMLElement;
    expect(within(row).getByText('ОТКЛОНЕНО')).toBeInTheDocument();
  });

  it('«Сделать кандидатом» добавляет нового кандидата в список', async () => {
    renderScene();
    fireEvent.click(screen.getByText(/^Гипотеза: Нормы/).closest('.finding-item') as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: /Сделать кандидатом/ }));
    expect(screen.getByText('Кандидат из гипотезы')).toBeInTheDocument();
    // без параметра матрицы кнопка недоступна
    const create = screen.getAllByRole('button', { name: 'Сделать кандидатом' }).find((b) => b.className.includes('btn-primary')) as HTMLElement;
    expect(create).toBeDisabled();
  });

  it('«Сравнение листов» показывает пару листов, наложение и режим «Рядом»', () => {
    renderScene();
    fireEvent.click(screen.getByRole('button', { name: /Сравнение листов/ }));
    expect(screen.getByRole('button', { name: 'Наложение' })).toBeInTheDocument();
    expect(screen.getByLabelText('Насколько видна правая страница')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Рядом' }));
    expect(screen.queryByLabelText('Насколько видна правая страница')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Панели ПД/ }));
    expect(screen.queryByRole('button', { name: 'Наложение' })).toBeNull();
  });

  it('«Версии доказательств» и «Сравнение по стадиям» есть в карточке', () => {
    renderScene();
    expect(screen.getByText('Версии доказательств (1)')).toBeInTheDocument();
    expect(screen.getByText('Сравнение по стадиям')).toBeInTheDocument();
    expect(screen.getByText('Нормативное основание')).toBeInTheDocument();
  });
});
