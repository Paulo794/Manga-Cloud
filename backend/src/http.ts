import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { ProviderError } from './providers/types';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function id(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw new HttpError(400, 'INVALID_ID', 'Identificador inválido.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new HttpError(400, 'INVALID_ID', 'Identificador inválido.');
  return parsed;
}
export function text(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) {
    throw new HttpError(400, 'INVALID_INPUT', `Texto inválido: máximo de ${max} caracteres.`);
  }
  return value.trim();
}
export function pagination(query: Request['query']) {
  const parse = (v: unknown, fallback: number, max: number) => {
    if (v === undefined) return fallback;
    if (typeof v !== 'string' || !/^\d+$/.test(v)) throw new HttpError(400, 'INVALID_PAGINATION', 'Paginação inválida.');
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new HttpError(400, 'INVALID_PAGINATION', 'Paginação fora do limite.');
    return n;
  };
  const page = parse(query.page, 1, 10000), limit = parse(query.limit, 20, 100);
  return { page, limit, offset: (page - 1) * limit };
}
export const missing = () => new HttpError(404, 'NOT_FOUND', 'Registro não encontrado.');
export function requestId(_req: Request, res: Response, next: NextFunction) {
  res.locals.requestId = crypto.randomUUID();
  res.setHeader('X-Request-ID', res.locals.requestId);
  next();
}
export function errorHandler(error: any, _req: Request, res: Response, _next: NextFunction) {
  if (res.headersSent) { res.destroy(); return; }
  let status = 500, code = 'INTERNAL_ERROR', message = 'Não foi possível concluir a operação.';
  if (error instanceof HttpError) { status = error.status; code = error.code; message = error.message; }
  else if (error instanceof ProviderError) {
    status = error.statusCode; code = error.code;
    message = 'A fonte de leitura não está disponível para esta operação. Tente novamente.';
    if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
  } else if (error.code === 'ER_DUP_ENTRY') { status = 409; code = 'CONFLICT'; message = 'Este registro já existe.'; }
  else if (error.code === 'LIMIT_FILE_SIZE') { status = 413; code = 'FILE_TOO_LARGE'; message = 'A imagem deve ter até 5 MiB.'; }
  else if (error.type === 'entity.too.large') { status = 413; code = 'PAYLOAD_TOO_LARGE'; message = 'Requisição acima do limite.'; }
  else if (error.code?.startsWith('LIMIT_')) { status = 400; code = 'INVALID_UPLOAD'; message = 'Upload inválido.'; }
  else if (error instanceof SyntaxError || error.type === 'entity.parse.failed') { status = 400; code = 'INVALID_JSON'; message = 'JSON inválido.'; }
  else if (error.code === 'LIMIT_UNEXPECTED_FILE') { status = 400; code = 'INVALID_UPLOAD'; message = 'Campo de arquivo inválido.'; }
  else if (error.code?.startsWith('ER_') || ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'].includes(error.code)) {
    status = 503; code = 'DEPENDENCY_UNAVAILABLE'; message = 'Serviço temporariamente indisponível.';
  }
  if (status >= 500) console.error(`[${res.locals.requestId}] ${code}`);
  res.status(status).json({ code, message, error: message, requestId: res.locals.requestId });
}
