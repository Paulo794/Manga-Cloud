import { Response, NextFunction } from 'express';
import { AuthRequest } from './authMiddleware';
import { HttpError } from '../http';

export const requireRole = (...roles: string[]) => (req: AuthRequest, _res: Response, next: NextFunction) => {
  if (!req.user) { next(new HttpError(401, 'UNAUTHORIZED', 'Entre para continuar.')); return; }
  if (!roles.includes(req.user.role)) { next(new HttpError(403, 'FORBIDDEN', 'Seu papel não permite esta operação.')); return; }
  next();
};
