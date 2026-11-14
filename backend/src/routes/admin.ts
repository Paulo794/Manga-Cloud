import { Router } from 'express';
import type { Pool } from 'mysql2/promise';
import { makeAuthenticate } from '../middleware/authMiddleware';
import { requireRole } from '../middleware/requireRole';
import { HttpError } from '../http';
import { getAdminMetrics } from '../services/adminMetrics';

/** Rotas administrativas de métricas SaaS e leitura da trilha de auditoria. */
export function adminRouter(db: Pool) {
  const router = Router();
  router.use(makeAuthenticate(db), requireRole('admin'));

  router.get('/metricas', async (_req, res) => {
    res.json(await getAdminMetrics(db));
  });

  router.get('/logs', async (_req, res) => {
    try {
      const upstream = await fetch(`${process.env.LOG_SERVICE_URL || 'http://log-service:3002'}/events?limit=100`, {
        headers: { 'X-Internal-Token': process.env.INTERNAL_SERVICE_TOKEN || '' },
        signal: AbortSignal.timeout(3000)
      });
      if (!upstream.ok) throw new Error('Audit unavailable');
      res.json(await upstream.json());
    } catch {
      throw new HttpError(503, 'AUDIT_UNAVAILABLE', 'Auditoria temporariamente indisponível.');
    }
  });

  return router;
}
