/**
 * Тексты, которые приходят с сервера (сообщения, причины, рекомендации), заменяют длинное тире запятой:
 * в интерфейсе длинных тире нет. Пока сервер не переписан, чистим при показе.
 */
/** Первая буква строчная: подпись после двоеточия, «Причина: неверная редакция». */
export const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

export const withoutLongDash = (text: string): string => text.replace(/\s+[—–]\s+/g, ', ');

/** Код причины отклонения в тексте сервера («Причина WRONG_REVISION») заменяем названием причины. */
export const withReasonNames = (text: string, labels: Record<string, string>): string =>
  text.replace(/\b[A-Z]+(?:_[A-Z]+)+\b/g, (code) => {
    const label = labels[code];
    return label ? label.charAt(0).toLowerCase() + label.slice(1) : code;
  });

/** «лист 3, стр. 5»; без названия листа или файла просто «стр. 5», без висящей запятой. */
export const pageLabel = (where: string | null | undefined, page: number): string => (where?.trim() ? `${where.trim()}, стр. ${page}` : `стр. ${page}`);
