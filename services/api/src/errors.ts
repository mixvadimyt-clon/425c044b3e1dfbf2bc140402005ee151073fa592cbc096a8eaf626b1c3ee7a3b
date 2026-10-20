/** Ошибка API: превращается в объект Error из контракта ({code, message, details}). */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>, code = 'BAD_REQUEST') =>
  new ApiError(400, code, message, details);
export const forbidden = (message = 'Недостаточно прав для этого действия') =>
  new ApiError(403, 'FORBIDDEN', message);
export const notFound = (what: string) => new ApiError(404, 'NOT_FOUND', `${what} не найден(а)`);
export const conflict = (message: string, code = 'INVALID_STATUS', details?: Record<string, unknown>) =>
  new ApiError(409, code, message, details);
