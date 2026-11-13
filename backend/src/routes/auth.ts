import { Router, Request, Response } from 'express';
import { AuthRequest, makeAuthenticate } from '../middleware/authMiddleware';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { requireRole } from '../middleware/requireRole';
import { HttpError } from '../http';
import { audit } from '../audit/auditClient';

export function authRouter(db: Pool, emit: typeof audit = audit) {
  const router = Router();
  const proxy = (path: (req: Request) => string, timeoutMs = 5000) => async (req: Request, res: Response) => {
    const base = process.env.AUTH_SERVICE_URL || 'http://auth-service:3000';
    try {
      const upstream = await fetch(`${base}/auth${path(req)}`, {
        method: req.method, headers: { 'Content-Type': 'application/json', ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}) },
        ...(req.method !== 'GET' ? { body: JSON.stringify(req.body) } : {}), signal: AbortSignal.timeout(timeoutMs)
      });
      const data = await upstream.json() as { code?: string; error?: string; message?: string };
      if (!upstream.ok) res.status(upstream.status).json({ code: data.code || 'AUTH_ERROR', message: data.error || data.message || 'Operação não permitida.', error: data.error || data.message, requestId: res.locals.requestId });
      else res.status(upstream.status).json(data);
    } catch { throw new HttpError(503, 'AUTH_UNAVAILABLE', 'Serviço de autenticação indisponível.'); }
  };
  for (const endpoint of ['register', 'login', 'forgot-password', 'reset-password']) router.post(`/auth/${endpoint}`, proxy(() => `/${endpoint}`, endpoint === 'forgot-password' ? 15000 : 5000));
  router.get('/auth/verify', proxy(() => '/verify'));
  router.get('/admin/usuarios', makeAuthenticate(db), requireRole('admin'), async (req: Request, res: Response) => {
    const base = process.env.AUTH_SERVICE_URL || 'http://auth-service:3000';
    let payload: { items?: Array<Record<string, unknown>>; page?: number; limit?: number; total?: number; code?: string; error?: string; message?: string };
    try {
      const upstream = await fetch(`${base}/auth/admin/usuarios?page=${encodeURIComponent(String(req.query.page ?? 1))}&limit=${encodeURIComponent(String(req.query.limit ?? 20))}`, {
        headers: { 'Content-Type': 'application/json', ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}) },
        signal: AbortSignal.timeout(5000)
      });
      payload = await upstream.json() as typeof payload;
      if (!upstream.ok) {
        res.status(upstream.status).json({ code: payload.code || 'AUTH_ERROR', message: payload.error || payload.message || 'Operação não permitida.', error: payload.error || payload.message, requestId: res.locals.requestId });
        return;
      }
    } catch { throw new HttpError(503, 'AUTH_UNAVAILABLE', 'Serviço de autenticação indisponível.'); }
    const items = payload.items ?? [];
    const ids = items.map(u => Number(u.id)).filter(n => Number.isSafeInteger(n) && n > 0);
    const plans = new Map<number, { plano: string; assinaturaStatus: string; inadimplente: boolean }>();
    if (ids.length > 0) {
      const [rows] = await db.query<RowDataPacket[]>(
        `SELECT usuario_id, status, (status='active' AND acesso_ate > UTC_TIMESTAMP()) AS is_pro FROM assinaturas WHERE usuario_id IN (${ids.map(() => '?').join(',')})`,
        ids
      );
      for (const row of rows) {
        const isPro = Number(row.is_pro) === 1;
        plans.set(Number(row.usuario_id), { plano: isPro ? 'pro' : 'free', assinaturaStatus: String(row.status), inadimplente: ['past_due', 'unpaid'].includes(String(row.status)) });
      }
    }
    res.json({ ...payload, items: items.map(u => ({ ...u, ...(plans.get(Number(u.id)) ?? { plano: 'free', assinaturaStatus: 'none', inadimplente: false }) })) });
  });
  router.patch('/admin/usuarios/:id/papel', makeAuthenticate(db), requireRole('admin'), proxy(req => `/admin/usuarios/${encodeURIComponent(String(req.params.id))}/papel`));
  router.post('/auth/logout', makeAuthenticate(db), (req: AuthRequest, res) => {
    emit({ usuario_id: req.user!.id, acao: 'auth.logout', resultado: 'sucesso' });
    res.json({ message: 'Sessão encerrada neste navegador.' });
  });
  return router;
}
