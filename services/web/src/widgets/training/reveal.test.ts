import { describe, expect, it } from 'vitest';
import { scrollDeltaFor, scrollDeltaX } from './reveal';

const area = { top: 0, bottom: 800 };

describe('scrollDeltaFor', () => {
  it('подсвеченное уже удобно стоит: ничего не прокручиваем', () => {
    expect(scrollDeltaFor({ top: 200, bottom: 300 }, area)).toBe(0);
  });

  it('подсвеченное у самого низа окна: прокручиваем так, чтобы середина встала на 35 % высоты', () => {
    // середина 770, нужна 280: прокрутить вниз на 490
    expect(scrollDeltaFor({ top: 740, bottom: 800 }, area)).toBe(490);
  });

  it('подсвеченное спрятано сверху (под шапкой): прокручиваем вверх', () => {
    expect(scrollDeltaFor({ top: -40, bottom: 20 }, area)).toBeLessThan(0);
  });

  it('высокое подсвеченное (таблица) верхом с отступом, если верх не в зоне', () => {
    expect(scrollDeltaFor({ top: 600, bottom: 1500 }, area)).toBe(600 - 16);
  });

  it('высокое подсвеченное с верхом в зоне не двигаем', () => {
    expect(scrollDeltaFor({ top: 120, bottom: 1000 }, area)).toBe(0);
  });

  it('высокое подсвеченное: над ним остаётся место под подпись (reserveTop)', () => {
    // подпись 250 px: верх подсвеченного должен встать на 250 от верха окна, а не на 16
    expect(scrollDeltaFor({ top: 500, bottom: 1300 }, area, 250)).toBe(500 - 250);
    expect(scrollDeltaFor({ top: 100, bottom: 900 }, area, 250)).toBe(100 - 250);
  });

  it('широкое невысокое подсвеченное: над ним остаётся место под подпись, а не просто середина окна', () => {
    // без запаса оно стоит удобно (верх на 20 %), но подписи над ним негде встать: нужно опустить до reserveTop
    expect(scrollDeltaFor({ top: 160, bottom: 400 }, area)).toBe(0);
    expect(scrollDeltaFor({ top: 160, bottom: 400 }, area, 260)).toBe(160 - 260);
  });

  it('пустая область: 0', () => {
    expect(scrollDeltaFor({ top: 10, bottom: 20 }, { top: 0, bottom: 0 })).toBe(0);
  });
});

describe('scrollDeltaX', () => {
  const horizontal = { left: 0, right: 1000 };

  it('колонка целиком на виду: не двигаем', () => {
    expect(scrollDeltaX({ left: 100, right: 300 }, horizontal)).toBe(0);
  });

  it('колонка за правым краем таблицы: ставим по центру', () => {
    // середина 1250, центр области 500: прокрутить вправо на 750
    expect(scrollDeltaX({ left: 1200, right: 1300 }, horizontal)).toBe(750);
  });

  it('колонка шире области: левым краем', () => {
    expect(scrollDeltaX({ left: 300, right: 1500 }, horizontal)).toBe(300 - 8);
  });
});
