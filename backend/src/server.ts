import 'dotenv/config';
import pool from './db';
import { createApp } from './app';
import { MinioStore, processPendingMinioDeletions } from './services/storage';

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET deve ser configurado.');
const store = new MinioStore();
const app = createApp({ store });
const server = app.listen(Number(process.env.PORT || 3001), () => console.log('MangaCloud iniciado.'));
server.requestTimeout = 30000;
server.headersTimeout = 15000;
let initialized = false;
store.ensure().then(() => { initialized = true; }).catch(() => console.error('[Storage] Inicialização pendente. Verifique configuração e saúde do MinIO.'));
let cleaning = false;
const worker = setInterval(async () => {
  if (cleaning) return;
  cleaning = true;
  try { if (!initialized) { await store.ensure(); initialized = true; } await processPendingMinioDeletions(pool, store); }
  catch { console.error('[Storage] Reconciliação temporariamente indisponível.'); }
  finally { cleaning = false; }
}, 30000);
worker.unref();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
  clearInterval(worker);
  server.close(() => { pool.end().finally(() => process.exit(0)); });
});
