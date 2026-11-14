#!/usr/bin/env node
'use strict';

// Ambiente local persistente: configuração e volumes próprios.
const { execFile } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, '../..');
const STATE = path.join(ROOT, '.local/preview.env');
const PROJECT = 'mangacloud-local';
const LABEL = 'io.mangacloud.local.instance';
const ACTIONS = new Set(['up', 'build', 'stop', 'status', 'logs', 'check']);
const LOCAL_IMAGES = [
  { field: 'APP', tag: 'mangacloud-local-app:local', context: '.' },
  { field: 'AUTH', tag: 'mangacloud-local-auth:local', context: 'auth-service' },
  { field: 'LOG', tag: 'mangacloud-local-logs:local', context: 'log-service' },
];

async function imageExists(tag) {
  try {
    await run(['docker', 'image', 'inspect', '--format', '{{.Id}}', tag]);
    return true;
  } catch {
    return false;
  }
}

async function ensureLocalImages(forceBuild) {
  for (const item of LOCAL_IMAGES) {
    if (!forceBuild && await imageExists(item.tag)) continue;
    console.log(`[Local] Construindo imagem ${item.tag} (${item.context})…`);
    await run(['docker', 'build', '--tag', item.tag, item.context], 300_000);
  }
}

async function run(args, timeout = 20_000) {
  // Não herda variáveis da aplicação/banco do shell nem de outro projeto.
  const allowed = new Set(['PATH', 'HOME', 'LANG', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'XDG_RUNTIME_DIR']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key)));
  const { stdout } = await execFileAsync(args[0], args.slice(1), {
    cwd: ROOT, env, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const entries = {};
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    entries[key] = value;
  }
  return entries;
}

async function syncIntegrations(settings) {
  const rootEnv = parseEnvFile(path.join(ROOT, '.env'));
  for (const key of [
    'MC_LOCAL_MAILTRAP_HOST', 'MC_LOCAL_MAILTRAP_PORT', 'MC_LOCAL_MAILTRAP_USER', 'MC_LOCAL_MAILTRAP_PASS', 'MC_LOCAL_MAIL_FROM',
    'MC_LOCAL_STRIPE_DEMO_ENABLED', 'MC_LOCAL_STRIPE_SECRET_KEY', 'MC_LOCAL_STRIPE_PRICE_ID', 'MC_LOCAL_STRIPE_WEBHOOK_SECRET',
  ]) {
    delete settings[key];
  }
  if (rootEnv.MAILTRAP_HOST) {
    settings.MC_LOCAL_MAILTRAP_HOST = rootEnv.MAILTRAP_HOST;
    settings.MC_LOCAL_MAILTRAP_PORT = rootEnv.MAILTRAP_PORT || '2525';
    if (rootEnv.MAILTRAP_USER) settings.MC_LOCAL_MAILTRAP_USER = rootEnv.MAILTRAP_USER;
    if (rootEnv.MAILTRAP_PASS) settings.MC_LOCAL_MAILTRAP_PASS = rootEnv.MAILTRAP_PASS;
    if (rootEnv.MAIL_FROM) settings.MC_LOCAL_MAIL_FROM = rootEnv.MAIL_FROM;
  }
  if (rootEnv.STRIPE_SECRET_KEY?.startsWith('sk_test_') && rootEnv.STRIPE_PRICE_ID?.startsWith('price_')) {
    let webhookSecret = rootEnv.STRIPE_WEBHOOK_SECRET || '';
    const stripeBin = path.join(ROOT, 'backend/stripe');
    if (fs.existsSync(stripeBin)) {
      try {
        const { stdout } = await execFileAsync(stripeBin, ['listen', '--print-secret', '--skip-update'], {
          cwd: ROOT,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, STRIPE_API_KEY: rootEnv.STRIPE_SECRET_KEY, STRIPE_NO_AUTO_UPDATE: '1' },
          encoding: 'utf8',
          timeout: 15_000,
        });
        const match = stdout.match(/whsec_[A-Za-z0-9]+/);
        if (match) webhookSecret = match[0];
      } catch { /* Mantém STRIPE_WEBHOOK_SECRET do .env se o CLI não responder. */ }
    }
    settings.MC_LOCAL_STRIPE_DEMO_ENABLED = 'true';
    settings.MC_LOCAL_STRIPE_SECRET_KEY = rootEnv.STRIPE_SECRET_KEY;
    settings.MC_LOCAL_STRIPE_PRICE_ID = rootEnv.STRIPE_PRICE_ID;
    if (webhookSecret) settings.MC_LOCAL_STRIPE_WEBHOOK_SECRET = webhookSecret;
  }
}

async function configuration(create, forceBuild = false) {
  let settings;
  if (fs.existsSync(STATE)) {
    settings = Object.fromEntries(fs.readFileSync(STATE, 'utf8').split(/\r?\n/)
      .filter(line => line && !line.startsWith('#'))
      .map(line => {
        const separator = line.indexOf('=');
        if (separator < 1) throw new Error('Configuração local inválida; preserve o arquivo para revisão.');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }));
  } else if (create) {
    settings = Object.fromEntries(['DB_PASSWORD', 'DB_ROOT_PASSWORD', 'JWT_SECRET', 'INTERNAL_TOKEN', 'MINIO_PASSWORD', 'REDIS_PASSWORD']
      .map(key => [`MC_LOCAL_${key}`, randomBytes(32).toString('hex')]));
    settings.MC_LOCAL_INSTANCE = randomBytes(12).toString('hex');
    settings.MC_LOCAL_PORT = '8224';
  } else {
    throw new Error('Ambiente local ainda não preparado. Execute: npm start');
  }
  if (!/^[0-9a-f]{24}$/.test(settings.MC_LOCAL_INSTANCE || '')) {
    throw new Error('Identidade do ambiente local inválida; preserve o arquivo existente para revisão.');
  }
  const port = Number(settings.MC_LOCAL_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Porta do ambiente local inválida.');
  }
  if (create) {
    await ensureLocalImages(forceBuild);
    for (const item of LOCAL_IMAGES) {
      settings[`MC_LOCAL_${item.field}_IMAGE`] = item.tag;
    }
    await syncIntegrations(settings);
  }
  return settings;
}

async function verifyOwnership(settings) {
  const scope = `label=com.docker.compose.project=${PROJECT}`;
  for (const [kind, listing, labels] of [
    ['container', ['docker', 'ps', '-aq', '--filter', scope], '.Config.Labels'],
    ['volume', ['docker', 'volume', 'ls', '-q', '--filter', scope], '.Labels'],
    ['network', ['docker', 'network', 'ls', '-q', '--filter', scope], '.Labels'],
  ]) {
    const identities = (await run(listing)).split(/\r?\n/).filter(Boolean);
    for (const identity of identities) {
      const actual = await run(['docker', 'inspect', '--type', kind, '--format', `{{ index ${labels} "${LABEL}" }}`, identity]);
      if (actual !== settings.MC_LOCAL_INSTANCE) {
        throw new Error(`Recurso local existente de outro ambiente (${kind}); nenhuma alteração executada.`);
      }
    }
  }
}

function saveConfiguration(settings) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  const fd = fs.openSync(STATE, 'w', 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, Object.keys(settings).sort().map(key => `${key}=${settings[key]}\n`).join(''));
  } finally {
    fs.closeSync(fd);
  }
}

async function requestJson(url, options = {}, timeout = 5000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`A aplicação respondeu HTTP ${response.status}. Consulte: npm run logs`);
  return response.json();
}

async function waitUntilReady(base) {
  const deadline = Date.now() + 45_000;
  while (true) {
    try {
      const response = await fetch(`${base}/ready`, { signal: AbortSignal.timeout(2000) });
      await response.body?.cancel();
      if (response.status === 200) return;
    } catch { /* O container pode estar iniciando. */ }
    if (Date.now() >= deadline) {
      throw new Error('Aplicação ainda não respondeu. Consulte: npm run logs');
    }
    await delay(1000);
  }
}

async function main() {
  const [action, ...extra] = process.argv.slice(2);
  if (action === '--help' || action === '-h') {
    console.log('MangaCloud local: npm start [-- --build] | npm run build:local | npm stop | npm run status | npm run logs | npm run check:local');
    return;
  }
  const forceBuild = action === 'up' && extra.length === 1 && extra[0] === '--build';
  if (!ACTIONS.has(action) || (extra.length > 0 && !forceBuild)) {
    throw new Error('Comando inválido. Use: npm start [-- --build] | npm run build:local | npm stop | npm run status | npm run logs | npm run check:local');
  }
  await run(['docker', 'info', '--format', '{{.ServerVersion}}']);
  if (action === 'build') {
    await ensureLocalImages(true);
    console.log('[Local] Imagens locais construídas. Execute npm start para iniciar ou atualizar os containers.');
    return;
  }
  const settings = await configuration(action === 'up', forceBuild);
  await verifyOwnership(settings);
  if (action === 'up') saveConfiguration(settings);
  const compose = ['docker', 'compose', '--project-name', PROJECT, '--env-file', STATE, '-f', path.join(ROOT, 'compose.local.yml')];
  await run([...compose, 'config', '--quiet']);
  const base = `http://localhost:${settings.MC_LOCAL_PORT}`;
  switch (action) {
    case 'up':
      console.log('[Local] Iniciando MangaCloud com banco e volumes próprios…');
      await run([...compose, 'up', '-d'], 150_000);
      await waitUntilReady(base);
      console.log(`[Local] MangaCloud disponível em ${base}`);
      console.log(`[Local] Catálogo Demo: ${base}/catalogo?provider=demo`);
      console.log('[Local] Dados mantidos nos volumes locais; para parar: npm stop');
      break;
    case 'stop':
      await run([...compose, 'stop'], 60_000);
      console.log('[Local] Ambiente parado; contas, imagens e volumes preservados.');
      break;
    case 'status':
      console.log(await run([...compose, 'ps', '--all']));
      break;
    case 'logs':
      console.log(await run([...compose, 'logs', '--tail', '50', 'app', 'auth-service', 'log-service']));
      break;
    case 'check': {
      const catalog = await requestJson(`${base}/api/mangas?provider=demo&limit=3`);
      if (catalog.items?.length !== 3) throw new Error('Catálogo Demo não retornou as três obras esperadas.');
      const account = await requestJson(`${base}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@mangacloud.local', senha: 'MangaCloudLocal123!' }),
      });
      if (account.user?.role !== 'admin' || !account.token) throw new Error('Conta admin local não foi provisionada corretamente.');
      console.log('[Local] Catálogo Demo e login do admin local verificados; token omitido.');
      try {
        const result = await requestJson(`${base}/api/mangas?provider=mangadex&limit=1`, {}, 25_000);
        console.log(`[Local] MangaDex respondeu; ${result.items?.length || 0} obra(s) retornada(s).`);
      } catch {
        console.log('[Local] MangaDex indisponível neste acesso. O catálogo Demo está pronto para explorar.');
      }
      break;
    }
  }
}

main().catch(error => {
  let message;
  if (error.killed) {
    message = 'O comando excedeu o prazo; consulte status/logs. Dados locais preservados.';
  } else if (typeof error.stderr === 'string') {
    message = `Comando Docker falhou. ${error.stderr.trim().slice(-600)}`;
  } else if (error.code === 'ENOENT') {
    message = error.path === 'docker' ? 'Docker não encontrado. Instale Docker com Compose antes de iniciar.'
      : 'Arquivo necessário não encontrado. Consulte docs/EXECUCAO_LOCAL_MANGACLOUD.md.';
  } else {
    message = error.message;
  }
  console.error(`[Local] ${message}`);
  process.exitCode = 1;
});
