import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
import type Stripe from 'stripe';
import type { Pool } from 'mysql2/promise';
import pool from './db';
import { audit } from './audit/auditClient';
import { requestId, errorHandler, HttpError } from './http';
import { libraryRouter } from './routes/library';
import { readingRouter } from './routes/reading';
import { profileRouter } from './routes/profile';
import { authRouter } from './routes/auth';
import { makeAuthenticate } from './middleware/authMiddleware';
import { requireRole } from './middleware/requireRole';
import { ObjectStore, MinioStore } from './services/storage';
import { billingRouter, stripeWebhook } from './routes/billing';

export function createApp(options: { db?: Pool; store?: ObjectStore; emit?: typeof audit; billingClient?: () => Stripe } = {}) {
  const db = options.db ?? pool, store = options.store ?? new MinioStore(), emit = options.emit ?? audit;
  const app = express();
  app.disable('x-powered-by');
  app.use(requestId);
  app.use(cors({ origin: process.env.APP_URL || false }));
  app.use((_req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'no-referrer'); next(); });
  app.get('/health', (_req, res) => res.json({ status: 'ok', app: 'MangaCloud' }));
  app.get('/ready', async (_req, res) => {
    try { await db.query('SELECT id FROM estantes LIMIT 1'); res.json({ status: 'ready' }); }
    catch { res.status(503).json({ status: 'unavailable' }); }
  });
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), stripeWebhook(db, emit, options.billingClient));
  app.use(express.json({ limit: '100kb' }));
  app.use((req: any, res, next) => {
    res.on('finish', () => {
      if ([401, 403].includes(res.statusCode) || (res.statusCode === 404 && req.user)) {
        emit({ usuario_id: req.user?.id ?? null, acao: 'acesso.negado', resultado: 'negado', recurso: `${req.method} ${req.path}`, detalhe: { status: res.statusCode, requestId: res.locals.requestId } });
      }
    });
    next();
  });
  app.use('/api', authRouter(db, emit));
  app.use('/api/estantes', libraryRouter(db, store, emit));
  app.use('/api/profile', profileRouter(db, store));
  app.use('/api', readingRouter(db, emit));
  app.use('/api/stripe', billingRouter(db, options.billingClient, emit));
  app.get('/api/admin/logs', makeAuthenticate(db), requireRole('admin'), async (_req, res) => {
    try {
      const upstream = await fetch(`${process.env.LOG_SERVICE_URL || 'http://log-service:3002'}/events?limit=100`, { headers: { 'X-Internal-Token': process.env.INTERNAL_SERVICE_TOKEN || '' }, signal: AbortSignal.timeout(3000) });
      if (!upstream.ok) throw new Error('Audit unavailable');
      res.json(await upstream.json());
    } catch { throw new HttpError(503, 'AUDIT_UNAVAILABLE', 'Auditoria temporariamente indisponível.'); }
  });
  const docs = path.join(__dirname, 'docs', 'openapi.yaml');
  if (fs.existsSync(docs)) app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(YAML.load(docs)));
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'ROUTE_NOT_FOUND', 'Rota de API não encontrada.')));
  const frontend = path.resolve(__dirname, '../../frontend/dist');
  app.use(express.static(frontend));
  app.get('/{*path}', (_req, res) => {
    if (fs.existsSync(path.join(frontend, 'index.html'))) res.sendFile(path.join(frontend, 'index.html'));
    else res.status(404).json({ code: 'FRONTEND_NOT_BUILT', message: 'Execute o build do frontend.' });
  });
  app.use(errorHandler);
  return app;
}
