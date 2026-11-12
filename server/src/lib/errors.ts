export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new HttpError(400, code, message, details);
export const unauthorized = (message = 'Требуется вход в систему') =>
  new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Недостаточно прав', details?: unknown) =>
  new HttpError(403, 'forbidden', message, details);
export const notFound = (message = 'Объект не найден') =>
  new HttpError(404, 'not_found', message);
export const conflict = (code: string, message: string, details?: unknown) =>
  new HttpError(409, code, message, details);
export const unavailable = (code: string, message: string, details?: unknown) =>
  new HttpError(503, code, message, details);

export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}
