import express from 'express';
import logRoutes from './routes/logRoutes';
import { env } from './config/env';
import { connectRedis, checkRedisHealth, disconnectRedis } from './repositories/auditStreamRepository';

export function createLogApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.get('/health', (_req, res) => res.status(checkRedisHealth() ? 200 : 503).json({ status: checkRedisHealth() ? 'ok' : 'unavailable' }));
  app.use('/events', logRoutes);
  return app;
}
if (require.main === module) {
  connectRedis().then(() => {
    const server = createLogApp().listen(Number(env.PORT), () => console.log('Log-service iniciado.'));
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => server.close(() => { disconnectRedis().finally(() => process.exit(0)); }));
  }).catch(() => { console.error('Não foi possível iniciar auditoria.'); process.exit(1); });
}
