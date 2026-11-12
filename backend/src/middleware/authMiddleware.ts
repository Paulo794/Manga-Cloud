import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import pool from '../db';
import { HttpError } from '../http';

export interface JwtUserPayload { id: number; email: string; role: 'leitor' | 'curador' | 'admin'; }
export interface AuthRequest extends Request { user?: JwtUserPayload; }

export function makeAuthenticate(db: Pool = pool, optional = false) {
  return async (req: AuthRequest, _res: Response, next: NextFunction) => {
    try {
      const header = req.headers.authorization;
      if (!header && optional) { next(); return; }
      if (!header || !/^Bearer \S+$/.test(header)) throw new HttpError(401, 'UNAUTHORIZED', 'Entre para continuar.');
      const secret = process.env.JWT_SECRET;
      if (!secret) throw new HttpError(503, 'AUTH_UNAVAILABLE', 'Autenticação não configurada.');
      let payload;
      try { payload = jwt.verify(header.slice(7), secret, { algorithms: ['HS256'] }); }
      catch { throw new HttpError(401, 'UNAUTHORIZED', 'Sessão inválida ou expirada.'); }
      if (typeof payload !== 'object' || !Number.isSafeInteger(payload.id) || payload.id <= 0) {
        throw new HttpError(401, 'UNAUTHORIZED', 'Sessão inválida.');
      }
      const [rows] = await db.query<RowDataPacket[]>('SELECT id, email, role FROM usuarios WHERE id = ?', [payload.id]);
      const current = rows[0];
      if (!current || !['leitor', 'curador', 'admin'].includes(current.role)) throw new HttpError(401, 'UNAUTHORIZED', 'Conta inválida.');
      req.user = { id: Number(current.id), email: current.email, role: current.role };
      next();
    } catch (error) { next(error); }
  };
}
export const authenticateToken = makeAuthenticate();
