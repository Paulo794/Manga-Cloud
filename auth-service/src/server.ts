import 'dotenv/config';
import express from 'express';
import path from 'path';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
import authRoutes from './routes/authRoutes';
import pool from './db/connection';

export function createAuthApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.get('/health', async (_req, res) => { try { await pool.query('SELECT 1'); res.json({ status: 'ok' }); } catch { res.status(503).json({ status: 'unavailable' }); } });
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(YAML.load(path.join(__dirname, 'docs/openapi.yaml'))));
  app.use('/auth', authRoutes);
  app.use((_req, res) => res.status(404).json({ code: 'NOT_FOUND', error: 'Rota não encontrada.' }));
  return app;
}
if (require.main === module) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET deve ser configurado.');
  const server = createAuthApp().listen(Number(process.env.AUTH_PORT || 3000), () => console.log('Auth-service MangaCloud iniciado.'));
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => server.close(() => { pool.end().finally(() => process.exit(0)); }));
}
