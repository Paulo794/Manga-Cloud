import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';


// Interface customizada para manter o TypeScript 100% seguro (sem usar 'any')
export interface AuthRequest extends Request {
  user?: string | jwt.JwtPayload;
}

export const verifyToken = (req: AuthRequest, res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Token não fornecido ou formato inválido' });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    if (!process.env.JWT_SECRET) { res.status(503).json({ error: 'Autenticação não configurada.' }); return; }
    const decoded = jwt.verify(token!, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    // Agora o TypeScript sabe que req tem a propriedade user
    req.user = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Token inválido ou expirado' });
  }
};
