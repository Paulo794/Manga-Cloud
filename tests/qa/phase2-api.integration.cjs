// HTTP + MariaDB/MinIO reais, somente via run-phase2-mariadb.review.py --api.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const { once } = require('node:events');
const backend = createRequire(path.resolve(__dirname, '../../backend/package.json'));
const auth = createRequire(path.resolve(__dirname, '../../auth-service/package.json'));
const logs = createRequire(path.resolve(__dirname, '../../log-service/package.json'));
backend('tsx/cjs');
const mysql = backend('mysql2/promise');
const express = backend('express');
const sharp = backend('sharp');
const Stripe = backend('stripe');
const { runMigrations } = backend('./src/migrations/migrate.ts');
const { createApp } = backend('./src/app.ts');
const { MinioStore, COVERS_BUCKET, AVATARS_BUCKET, processPendingMinioDeletions } = backend('./src/services/storage.ts');
const { createAuthRouter } = auth('./src/routes/authRoutes.ts');
const { mangadexCatalogProvider } = backend('./src/providers/index.ts');

async function main() {
  assert.equal(process.env.DB_HOST, '127.0.0.1');
  assert.equal(process.env.MINIO_ENDPOINT, '127.0.0.1');
  assert.ok(process.env.QA_EPHEMERAL_INSTANCE, 'Executar somente pelo executor de instâncias exclusivas.');
  const dbName = 'mangacloud_qa_api';
  const options = { host: '127.0.0.1', port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, timezone: 'Z' };
  const admin = await mysql.createConnection(options);
  const servers = [], events = [];
  let db, created = false, closeRedis, smtp, liveNetwork;
  const originalMangaDex = { getDiagnostics: mangadexCatalogProvider.getDiagnostics, searchMangas: mangadexCatalogProvider.searchMangas, getTags: mangadexCatalogProvider.getTags };
  try {
    if (process.env.QA_MANGADEX_PUBLIC_DNS === '1') {
      assert.equal(process.env.QA_MANGADEX_LIVE, '1');
      liveNetwork = require('./public-dns.fixture.cjs')();
    }
    await admin.query(`CREATE DATABASE ${dbName} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    process.env.DB_NAME = dbName;
    await runMigrations();
    db = mysql.createPool({ ...options, database: dbName, connectionLimit: 8 });
    smtp = await require('./smtp.fixture.cjs')();
    Object.assign(process.env, { MAILTRAP_HOST: '127.0.0.1', MAILTRAP_PORT: String(smtp.port), MAILTRAP_USER: 'qa-mail', MAILTRAP_PASS: 'qa-mail-fixture', MAIL_FROM: 'MangaCloud QA <noreply@qa.invalid>' });
    const repository = logs('./src/repositories/auditStreamRepository.ts');
    await repository.connectRedis(); closeRedis = repository.disconnectRedis;
    const logApp = logs('./src/server.ts').createLogApp();
    const logServer = logApp.listen(0, '127.0.0.1'); servers.push(logServer); await once(logServer, 'listening');
    process.env.LOG_SERVICE_URL = `http://127.0.0.1:${logServer.address().port}`;
    // Clientes de auditoria existentes capturam URL ao importar; usar transporte explícito para os testes.
    const emitService = (event, service) => {
      events.push(event);
      fetch(`${process.env.LOG_SERVICE_URL}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Token': process.env.INTERNAL_SERVICE_TOKEN }, body: JSON.stringify({ ...event, servico: service }), signal: AbortSignal.timeout(1500) }).catch(() => {});
    };
    const emit = event => emitService(event, 'catalogo');
    const authApp = express();
    authApp.use(express.json());
    authApp.use('/auth', createAuthRouter(db, event => emitService(event, 'auth-service')));
    const authServer = authApp.listen(0, '127.0.0.1'); servers.push(authServer); await once(authServer, 'listening');
    process.env.AUTH_SERVICE_URL = `http://127.0.0.1:${authServer.address().port}`;
    const realStore = new MinioStore();
    await realStore.ensure();
    let failDeletes = false;
    const store = {
      ensure: () => realStore.ensure(), put: (...args) => realStore.put(...args), get: (...args) => realStore.get(...args),
      remove: (...args) => { if (failDeletes) throw new Error('QA storage failure'); return realStore.remove(...args); }
    };
    // Nenhuma consulta externa é usada como evidência neste teste de integração local.
    mangadexCatalogProvider.getDiagnostics = async () => ({ provider: 'mangadex', status: 'unavailable', latencyMs: 0, checkedAt: new Date().toISOString(), coverage: { sampleWorksCount: 0, supportedLanguages: [], contentFilter: 'safe', commercialPolicyNote: 'Diagnóstico simulado no teste HTTP local.' } });
    if (process.env.QA_BROWSER_TESTS === '1') {
      const { ProviderError } = backend('./src/providers/types.ts');
      mangadexCatalogProvider.searchMangas = async () => { throw new ProviderError({ statusCode: 503, code: 'EXTERNAL_PROVIDER_UNAVAILABLE', provider: 'mangadex', message: 'Fonte indisponível simulada para teste de UI local.' }); };
      mangadexCatalogProvider.getTags = async () => { throw new ProviderError({ statusCode: 503, code: 'EXTERNAL_PROVIDER_UNAVAILABLE', provider: 'mangadex', message: 'Fonte indisponível simulada para teste de UI local.' }); };
    }
    let nextSession = 0, sessions = [], subscriptionState = null, failStripe = false, validPrice = true, renewalUpdates = 0, failCheckoutList = false;
    const customers = new Map(), customerKeys = [], checkoutKeys = [], renewalKeys = [];
    const sdk = new Stripe('sk_test_local_fixture');
    process.env.STRIPE_PRICE_ID = 'price_qa'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_local_fixture';
    const fakeStripe = {
      webhooks: sdk.webhooks,
      prices: { retrieve: async () => ({ livemode: false, active: true, currency: 'brl', unit_amount: validPrice ? 990 : 1990, recurring: { interval: 'month', interval_count: 1 } }) },
      customers: {
        create: async (options, requestOptions) => {
          customerKeys.push(requestOptions.idempotencyKey);
          let c = [...customers.values()].find(c => c.key === requestOptions.idempotencyKey);
          if (!c) { c = { id: `cus_qa_${customers.size + 1}`, livemode: false, metadata: options.metadata, key: requestOptions.idempotencyKey }; customers.set(c.id, c); }
          return structuredClone(c);
        },
        retrieve: async id => structuredClone(customers.get(id))
      },
      subscriptions: {
        list: async ({ customer }) => ({ data: subscriptionState?.customer === customer ? [subscriptionState] : [] }),
        retrieve: async id => { if (failStripe || subscriptionState?.id !== id) throw new Error('QA Stripe failure'); return structuredClone(subscriptionState); },
        update: async (id, options, requestOptions) => {
          if (failStripe || subscriptionState?.id !== id) throw new Error('QA Stripe failure');
          renewalUpdates++; renewalKeys.push(requestOptions.idempotencyKey);
          Object.assign(subscriptionState, options); return structuredClone(subscriptionState);
        }
      },
      checkout: { sessions: {
        list: async ({ customer }) => { if (failCheckoutList) { failCheckoutList = false; throw new Error('QA network failure after customer creation'); } return { data: sessions.filter(s => s.customer === customer).toReversed() }; },
        expire: async id => { const session = sessions.find(s => s.id === id); session.status = 'expired'; return structuredClone(session); },
        create: async (options, requestOptions) => { checkoutKeys.push(requestOptions.idempotencyKey); const s = { id: `cs_${++nextSession}`, url: 'https://checkout.stripe.com/qa', livemode: false, status: 'open', ...options }; sessions.push(s); return structuredClone(s); }
      } },
      billingPortal: { sessions: {
        create: async ({ customer, return_url }) => ({ id: 'bps_qa', customer, return_url, url: 'https://billing.stripe.com/p/session/qa' })
      } }
    };
    const app = createApp({ db, store, emit, billingClient: () => fakeStripe });
    const server = app.listen(0, '127.0.0.1'); servers.push(server); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    process.env.APP_URL = base;
    async function request(route, token, method = 'GET', body, expected = 200, raw = false) {
      const multipart = body instanceof FormData;
      const response = await fetch(`${base}/api${route}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}) });
      if (raw) { assert.equal(response.status, expected, route); return response; }
      const data = response.status === 204 ? null : await response.json();
      assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(data)}`);
      return data;
    }
    async function account(label) {
      const email = `${label}@qa.invalid`, senha = 'QaPassword123!';
      const registered = await request('/auth/register', null, 'POST', { nome: label, email, senha, role: 'admin', is_premium: true }, 201);
      assert.equal(registered.user.role, 'leitor');
      const signed = await request('/auth/login', null, 'POST', { email, senha });
      return { ...signed.user, token: signed.token };
    }
    const a = await account('leitor-a'), b = await account('leitor-b'), curator = await account('curador'), adminUser = await account('admin');
    await db.query("UPDATE usuarios SET role='curador' WHERE id=?", [curator.id]);
    await db.query("UPDATE usuarios SET role='admin' WHERE id=?", [adminUser.id]);
    await request('/estantes', null, 'GET', undefined, 401);
    await request('/curadoria/integracao', a.token, 'GET', undefined, 403);
    await request('/curadoria/integracao', curator.token);
    await request('/admin/usuarios', a.token, 'GET', undefined, 403);
    const users = await request('/admin/usuarios', adminUser.token);
    assert.ok(users.items.every(user => !('senha_hash' in user)));
    await request(`/admin/usuarios/${curator.id}/papel`, adminUser.token, 'PATCH', { papel: 'leitor' });
    await request('/curadoria/integracao', curator.token, 'GET', undefined, 403);
    const directDenied = await fetch(`${process.env.AUTH_SERVICE_URL}/auth/admin/usuarios`, { headers: { Authorization: `Bearer ${a.token}` } });
    assert.equal(directDenied.status, 403);
    console.log('[OK HTTP-1] Cadastro sem mass assignment, papéis atuais, JWT antigo rebaixado e auth-service direto.');

    const shelf = await request('/estantes', a.token, 'POST', { nome: 'Minha estante', descricao: 'Privada', usuario_id: b.id, seed_key: 'injetado' }, 201);
    const [owner] = await db.query('SELECT usuario_id, seed_key FROM estantes WHERE id=?', [shelf.id]);
    assert.equal(owner[0].usuario_id, a.id); assert.equal(owner[0].seed_key, null);
    await request(`/estantes/${shelf.id}`, b.token, 'GET', undefined, 404);
    await request(`/estantes/${shelf.id}`, b.token, 'PATCH', { nome: 'Ataque' }, 404);
    await request(`/estantes/${shelf.id}`, adminUser.token, 'GET', undefined, 404);
    await request(`/estantes/${shelf.id}`, a.token, 'PATCH', { nome: 'Editada' });
    const item = await request(`/estantes/${shelf.id}/itens`, a.token, 'POST', { provider: 'demo', mangaId: 'demo-alquimia-astral' }, 201);
    await request(`/estantes/${shelf.id}/itens`, a.token, 'POST', { provider: 'demo', mangaId: 'demo-alquimia-astral' }, 409);
    await request(`/estantes/${shelf.id}/itens/${item.id}`, b.token, 'PATCH', { ordem: 1 }, 404);
    await request(`/estantes/${shelf.id}/itens/${item.id}`, a.token, 'PATCH', { ordem: 4 });
    const detail = await request(`/estantes/${shelf.id}`, a.token);
    assert.equal(detail.items[0].metadataAvailable, true);
    assert.equal(detail.items[0].manga.title, 'Crônicas da Alquimia Astral');
    await request('/favoritos', a.token, 'POST', { provider: 'demo', mangaId: 'demo-alquimia-astral', usuario_id: b.id }, 201);
    assert.equal((await request('/favoritos', b.token)).total, 0);
    console.log('[OK HTTP-2] CRUD, filhos e favoritos isolados, IDs e seed_key protegidos, metadados por referência.');

    const png = await sharp({ create: { width: 30, height: 40, channels: 3, background: '#f00' } }).png().toBuffer();
    const form = (bytes = png, mime = 'image/png') => { const f = new FormData(); f.append('capa', new Blob([bytes], { type: mime }), 'capa.png'); return f; };
    await request(`/estantes/${shelf.id}/capa`, b.token, 'POST', form(), 404);
    await request(`/estantes/${shelf.id}/capa`, a.token, 'POST', form(), 201);
    const image = await request(`/estantes/${shelf.id}/capa`, a.token, 'GET', undefined, 200, true);
    assert.equal(image.headers.get('cache-control'), 'private, no-store');
    assert.ok((await image.arrayBuffer()).byteLength > 0);
    await request(`/estantes/${shelf.id}/capa`, b.token, 'GET', undefined, 404);
    const [covers] = await db.query('SELECT object_key FROM estante_capas WHERE estante_id=?', [shelf.id]);
    const unsigned = await fetch(`http://127.0.0.1:${process.env.MINIO_PORT}/${COVERS_BUCKET}/${covers[0].object_key}`);
    assert.equal(unsigned.status, 403);
    await unsigned.arrayBuffer();
    // Exercita também bucket já existente com política incorreta, só no MinIO efêmero.
    const { S3Client, PutBucketPolicyCommand } = backend('@aws-sdk/client-s3');
    const policyClient = new S3Client({ endpoint: `http://127.0.0.1:${process.env.MINIO_PORT}`, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: process.env.MINIO_ROOT_USER, secretAccessKey: process.env.MINIO_ROOT_PASSWORD } });
    try {
      await policyClient.send(new PutBucketPolicyCommand({ Bucket: COVERS_BUCKET, Policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${COVERS_BUCKET}/*`] }] }) }));
      const temporaryPublic = await fetch(`http://127.0.0.1:${process.env.MINIO_PORT}/${COVERS_BUCKET}/${covers[0].object_key}`);
      assert.equal(temporaryPublic.status, 200); await temporaryPublic.arrayBuffer();
      await realStore.ensure();
      const privateAgain = await fetch(`http://127.0.0.1:${process.env.MINIO_PORT}/${COVERS_BUCKET}/${covers[0].object_key}`);
      assert.equal(privateAgain.status, 403); await privateAgain.text();
    } finally { policyClient.destroy(); }
    await request(`/estantes/${shelf.id}/capa`, a.token, 'POST', form(Buffer.from('<svg/>'), 'image/svg+xml'), 415);
    await request(`/estantes/${shelf.id}/capa`, a.token, 'POST', form(Buffer.from('\x89PNGfake'), 'image/png'), 415);
    const wide = await sharp({ create: { width: 4097, height: 1, channels: 3, background: '#fff' } }).png().toBuffer();
    await request(`/estantes/${shelf.id}/capa`, a.token, 'POST', form(wide), 415);
    await request(`/estantes/${shelf.id}/capa`, a.token, 'POST', form(Buffer.alloc(5 * 1024 * 1024 + 1)), 413);
    await request(`/estantes/${shelf.id}/capa`, a.token, 'POST', form(), 201);
    failDeletes = true;
    await processPendingMinioDeletions(db, store);
    const [pending] = await db.query('SELECT * FROM minio_objetos_pendentes_remocao'); assert.ok(pending.length);
    assert.equal(pending[0].status, 'pending');
    failDeletes = false;
    await db.query('UPDATE minio_objetos_pendentes_remocao SET proxima_tentativa_em=UTC_TIMESTAMP()');
    await processPendingMinioDeletions(db, store);
    const originalCount = async () => {
      const { S3Client, paginateListObjectsV2 } = backend('@aws-sdk/client-s3');
      const client = new S3Client({ endpoint: `http://127.0.0.1:${process.env.MINIO_PORT}`, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: process.env.MINIO_ROOT_USER, secretAccessKey: process.env.MINIO_ROOT_PASSWORD } });
      const keys = [];
      try { for await (const page of paginateListObjectsV2({ client }, { Bucket: COVERS_BUCKET })) for (const object of page.Contents || []) keys.push(object.Key); }
      finally { client.destroy(); }
      return keys.sort();
    };
    const beforeFailure = await originalCount();
    const brokenDb = new Proxy(db, { get(target, property) {
      if (property === 'getConnection') return async () => { throw Object.assign(new Error('QA SQL failure'), { code: 'ECONNREFUSED' }); };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const brokenServer = createApp({ db: brokenDb, store, emit, billingClient: () => fakeStripe }).listen(0, '127.0.0.1');
    servers.push(brokenServer); await once(brokenServer, 'listening');
    const brokenBase = `http://127.0.0.1:${brokenServer.address().port}`;
    const failedUpload = await fetch(`${brokenBase}/api/estantes/${shelf.id}/capa`, { method: 'POST', headers: { Authorization: `Bearer ${a.token}` }, body: form() });
    assert.equal(failedUpload.status, 503); await failedUpload.json();
    assert.deepEqual(await originalCount(), beforeFailure, 'Objeto novo deve ser compensado se SQL falhar após upload.');
    await request(`/estantes/${shelf.id}/capa`, a.token, 'DELETE', undefined, 204);
    await processPendingMinioDeletions(db, store);
    console.log('[OK HTTP-3] MinIO privado real, imagem decodificada, conteúdo forjado/dimensões/tamanho recusados e compensação após falha.');

    await request('/leitura/demo/demo-aa-pt-cap-1/manifesto', a.token);
    await request('/leitura/demo/demo-aa-pt-cap-3/manifesto', a.token);
    await db.query('UPDATE usuarios SET is_premium=1 WHERE id=?', [a.id]);
    const denied = await request('/leitura/demo/demo-aa-pt-cap-4/manifesto', a.token, 'GET', undefined, 403);
    assert.equal(denied.code, 'PLAN_REQUIRED');
    assert.ok(!JSON.stringify(denied).match(/imageUrl|data:image|baseUrl|hash|pages/));
    await db.query("INSERT INTO assinaturas (usuario_id, stripe_customer_id, stripe_subscription_id, price_id, status, acesso_ate) VALUES (?, 'cus_progress', 'sub_progress', 'price_qa', 'active', DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 HOUR))", [a.id]);
    await request('/leitura/demo/demo-aa-pt-cap-4/manifesto', a.token);
    const saved = await request('/progresso/demo/demo-alquimia-astral', a.token, 'PUT', { chapterId: 'demo-aa-pt-cap-4', idioma: 'pt-br', pagina: 1, revisaoEsperada: 0 });
    assert.equal(saved.revisao, 1);
    const writes = await Promise.all([2, 3].map(pagina => fetch(`${base}/api/progresso/demo/demo-alquimia-astral`, { method: 'PUT', headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ chapterId: 'demo-aa-pt-cap-4', idioma: 'pt-br', pagina, revisaoEsperada: 1 }) }).then(async r => { await r.json(); return r.status; })));
    assert.deepEqual(writes.sort(), [200, 409]);
    await request('/progresso/demo/demo-alquimia-astral', a.token, 'PUT', { chapterId: 'demo-aa-pt-cap-4', idioma: 'pt-br', pagina: 999, revisaoEsperada: 2 }, 400);
    assert.equal((await request('/progresso', b.token)).items.length, 0);
    assert.equal((await request('/progresso/demo/demo-alquimia-astral?idioma=pt-br', a.token)).revisao, 2);
    await request('/progresso/demo/demo-alquimia-astral?idioma=pt-br', b.token, 'GET', undefined, 404);
    await db.query("UPDATE assinaturas SET acesso_ate=DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 SECOND) WHERE usuario_id=?", [a.id]);
    await request('/leitura/demo/demo-aa-pt-cap-4/manifesto', a.token, 'GET', undefined, 403);
    console.log('[OK HTTP-4] Paywall server-side sem URLs, booleano legado ignorado, progresso Pro e concorrência real 200/409.');

    await request('/stripe/cancelar', null, 'POST', {}, 401);
    await request('/stripe/cancelar', curator.token, 'POST', { usuario_id: b.id }, 404);
    await request('/stripe/portal', null, 'POST', {}, 401);
    await request('/stripe/portal', b.token, 'POST', {}, 404);
    const limitShelves = [];
    for (let i = 1; i <= 3; i++) limitShelves.push(await request('/estantes', b.token, 'POST', { nome: `Free ${i}` }, 201));
    const shelfLimitBlocked = await request('/estantes', b.token, 'POST', { nome: 'Free 4 bloqueada' }, 403);
    assert.equal(shelfLimitBlocked.code, 'PLAN_REQUIRED');
    assert.match(shelfLimitBlocked.message, /3 estantes/);
    assert.match(shelfLimitBlocked.message, /Pro/);
    validPrice = false;
    assert.equal((await request('/stripe/checkout', b.token, 'POST', {}, 503)).code, 'BILLING_PRICE_INVALID');
    validPrice = true;
    const checkouts = await Promise.all([1, 2].map(() => request('/stripe/checkout', b.token, 'POST', {})));
    assert.equal(checkouts[0].url, checkouts[1].url); assert.equal(nextSession, 1);
    sessions[0].status = 'expired';
    await request('/stripe/checkout', b.token, 'POST', {});
    assert.equal(nextSession, 2); assert.notEqual(checkoutKeys[0], checkoutKeys[1], 'Checkout expirado recebe uma nova tentativa, mesmo na mesma hora.');
    const [billingUsers] = await db.query('SELECT billing_identity, stripe_customer_id FROM usuarios WHERE id=?', [b.id]);
    const billingUser = billingUsers[0];
    assert.match(billingUser.billing_identity, /^[0-9a-f-]{36}$/);
    subscriptionState = { id: 'sub_qa', livemode: false, customer: billingUser.stripe_customer_id, metadata: { app: 'mangacloud', userId: String(b.id), billingIdentity: billingUser.billing_identity }, status: 'active', cancel_at_period_end: false, items: { data: [{ price: { id: 'price_qa' }, current_period_end: Math.floor(Date.now() / 1000) + 3600 }] }, latest_invoice: { status: 'paid' } };
    async function webhook(eventId, type, createdAt = 10) {
      const eventObject = type.startsWith('customer.subscription.') ? { id: subscriptionState.id } : { subscription: subscriptionState.id };
      const payload = JSON.stringify({ id: eventId, object: 'event', type, created: createdAt, livemode: false, data: { object: eventObject } });
      const signature = sdk.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
      const response = await fetch(`${base}/api/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': signature }, body: payload });
      await response.json(); return response.status;
    }
    assert.deepEqual(await Promise.all([webhook('evt_one', 'checkout.session.completed'), webhook('evt_one', 'checkout.session.completed')]), [200, 200]);
    assert.equal((await request('/assinatura', b.token)).isPro, true);
    const proExtraShelf = await request('/estantes', b.token, 'POST', { nome: 'Pro 4 liberada' }, 201);
    limitShelves.push(proExtraShelf);
    const portalSession = await request('/stripe/portal', b.token, 'POST', {});
    assert.equal(portalSession.url, 'https://billing.stripe.com/p/session/qa');
    await request('/stripe/checkout', b.token, 'POST', {}, 409);
    const bProgress = { chapterId: 'demo-aa-pt-cap-4', idioma: 'pt-br', pagina: 2, revisaoEsperada: 0 };
    await request('/progresso/demo/demo-alquimia-astral', b.token, 'PUT', bProgress);
    const canceled = await request('/stripe/cancelar', b.token, 'POST', { usuario_id: a.id, subscriptionId: 'sub_alheia' });
    assert.equal(canceled.cancelAtPeriodEnd, true); assert.equal(canceled.isPro, true);
    await request('/stripe/cancelar', b.token, 'POST', {});
    assert.equal(renewalUpdates, 1, 'Repetição do cancelamento não atualiza novamente o Stripe.');
    assert.equal((await request('/stripe/reativar', b.token, 'POST', {})).cancelAtPeriodEnd, false);
    assert.equal((await request('/stripe/cancelar', b.token, 'POST', {})).cancelAtPeriodEnd, true);
    assert.equal(new Set(renewalKeys).size, 3, 'Cancelar, reativar e cancelar não reutilizam uma resposta antiga.');
    failStripe = true;
    await request('/stripe/reativar', b.token, 'POST', {}, 503);
    assert.equal((await request('/assinatura', b.token)).cancelAtPeriodEnd, true, 'Falha externa não altera o estado local.');
    failStripe = false;
    subscriptionState.metadata.billingIdentity = 'outra-instancia';
    await request('/stripe/reativar', b.token, 'POST', {}, 409);
    assert.equal(await webhook('evt_wrong_identity', 'customer.subscription.updated'), 200);
    assert.equal((await request('/assinatura', b.token)).cancelAtPeriodEnd, true);
    customers.get(billingUser.stripe_customer_id).metadata.billingIdentity = 'outra-instancia';
    await request('/stripe/portal', b.token, 'POST', {}, 409);
    customers.get(billingUser.stripe_customer_id).metadata.billingIdentity = billingUser.billing_identity;
    subscriptionState.metadata.billingIdentity = billingUser.billing_identity;
    subscriptionState.items.data[0].current_period_end = Math.floor(Date.now() / 1000) - 60;
    assert.equal(await webhook('evt_expired', 'customer.subscription.updated'), 200);
    assert.equal((await request('/assinatura', b.token)).isPro, false);
    assert.equal((await request('/progresso/demo/demo-alquimia-astral?idioma=pt-br', b.token)).pagina, 2);
    subscriptionState.items.data[0].current_period_end = Math.floor(Date.now() / 1000) + 3600;
    subscriptionState.status = 'past_due'; subscriptionState.latest_invoice.status = 'open';
    assert.equal(await webhook('evt_unpaid', 'invoice.payment_failed'), 200);
    const pastDueSub = await request('/assinatura', b.token);
    assert.equal(pastDueSub.isPro, false); assert.equal(pastDueSub.inadimplente, true);
    const adminMetricsActive = await request('/admin/metricas', adminUser.token);
    assert.equal(adminMetricsActive.assinaturasPorStatus.inadimplentes, 1);
    assert.equal(adminMetricsActive.mrrCentavos, adminMetricsActive.assinaturasAtivas * 990);
    await request('/admin/metricas', a.token, 'GET', undefined, 403);
    await request('/stripe/reativar', b.token, 'POST', {}, 409);
    subscriptionState.status = 'active'; subscriptionState.latest_invoice.status = 'paid';
    const failedPayload = JSON.stringify({ id: 'evt_retry', object: 'event', type: 'customer.subscription.updated', created: 11, livemode: false, data: { object: { id: 'sub_qa' } } });
    const failedSignature = sdk.webhooks.generateTestHeaderString({ payload: failedPayload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    const transientWebhook = await fetch(`${brokenBase}/api/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': failedSignature }, body: failedPayload });
    assert.equal(transientWebhook.status, 503); await transientWebhook.json();
    assert.equal(await webhook('evt_retry', 'customer.subscription.updated', 11), 200);
    const metricsWithPro = await request('/admin/metricas', adminUser.token);
    assert.equal(metricsWithPro.assinaturasAtivas, 1);
    assert.equal(metricsWithPro.usuariosPorPlano.pro, 1);
    assert.equal(metricsWithPro.mrrCentavos, 990);
    subscriptionState.status = 'canceled';
    assert.equal(await webhook('evt_cancel', 'customer.subscription.deleted', 12), 200);
    assert.equal(await webhook('evt_old', 'customer.subscription.updated', 8), 200);
    assert.equal((await request('/assinatura', b.token)).isPro, false);
    assert.equal((await request('/estantes', b.token)).total, 4, 'Estantes criadas no Pro permanecem apos cancelamento.');
    await request('/estantes', b.token, 'POST', { nome: 'Bloqueada apos cancelamento' }, 403);
    for (const s of limitShelves) await request(`/estantes/${s.id}`, b.token, 'DELETE', undefined, 204);
    assert.equal((await request('/admin/metricas', adminUser.token)).mrrCentavos, 0);
    await request('/stripe/reativar', b.token, 'POST', {}, 409);
    const invalidWebhook = await fetch(`${base}/api/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 'invalid' }, body: '{}' });
    assert.equal(invalidWebhook.status, 400); await invalidWebhook.json();
    const retryUser = await account('billing-retry');
    const customerAttempts = customerKeys.length;
    failCheckoutList = true;
    await request('/stripe/checkout', retryUser.token, 'POST', {}, 503);
    await request('/stripe/checkout', retryUser.token, 'POST', {});
    assert.equal(customerKeys[customerAttempts], customerKeys[customerAttempts + 1], 'Identidade é persistida antes da chamada externa e sobrevive ao rollback.');
    const [reuseRows] = await db.query('SELECT * FROM usuarios WHERE id=?', [retryUser.id]);
    const previousIdentity = reuseRows[0].billing_identity;
    await db.query('DELETE FROM usuarios WHERE id=?', [retryUser.id]);
    await db.query('INSERT INTO usuarios (id, nome, email, senha_hash, role) VALUES (?, ?, ?, ?, ?)', [retryUser.id, reuseRows[0].nome, reuseRows[0].email, reuseRows[0].senha_hash, 'leitor']);
    await request('/stripe/checkout', retryUser.token, 'POST', {});
    const [newIdentity] = await db.query('SELECT billing_identity FROM usuarios WHERE id=?', [retryUser.id]);
    assert.notEqual(newIdentity[0].billing_identity, previousIdentity, 'Mesmo ID e email em uma nova conta não reutilizam cliente de teste.');
    console.log('[OK HTTP-5] Stripe simulado: identidade persistente/isolada, preço, checkout concorrente/expirado, cancelamento/reativação, expiração, inadimplência, webhook idempotente e histórico preservado.');

    await request(`/estantes/${shelf.id}/itens/${item.id}`, a.token, 'DELETE', undefined, 204);
    await request(`/estantes/${shelf.id}`, b.token, 'DELETE', undefined, 404);
    await request(`/estantes/${shelf.id}`, a.token, 'DELETE', undefined, 204);
    await request(`/estantes/${shelf.id}`, a.token, 'GET', undefined, 404);
    await request('/rota-inexistente', null, 'GET', undefined, 404);
    assert.ok(events.some(e => e.acao === 'estante.criada'));
    assert.ok(events.some(e => e.acao === 'estante.excluida'));
    assert.ok(events.some(e => e.acao === 'leitura.bloqueada'));
    assert.ok(events.some(e => e.acao === 'usuario.papel_alterado'));
    assert.ok(events.every(e => !JSON.stringify(e).match(/senha_hash|Bearer |data:image/)));
    let ledger;
    for (let attempt = 0; attempt < 20; attempt++) {
      ledger = await request('/admin/logs', adminUser.token);
      if (ledger.eventos.some(event => event.acao === 'estante.excluida')) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ledger.eventos.some(event => event.acao === 'estante.excluida' && event.usuario_id === a.id && event.timestamp));
    const unauthenticatedLog = await fetch(`${process.env.LOG_SERVICE_URL}/events`);
    assert.ok([401, 403].includes(unauthenticatedLog.status)); await unauthenticatedLog.text();
    console.log('[OK HTTP-6] Exclusão, logs reais no Redis, painel admin protegido e API inexistente em JSON.');
    const resetToken = 'a'.repeat(64);
    await db.query('INSERT INTO reset_tokens (token, usuario_id, expira_em) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 30 MINUTE))', [resetToken, curator.id]);
    const resets = await Promise.all([1, 2].map(async () => {
      const r = await fetch(`${base}/api/auth/reset-password`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: resetToken, novaSenha: 'NewQaPassword123!' }) });
      await r.json(); return r.status;
    }));
    assert.deepEqual(resets.sort(), [200, 400]);
    await request('/auth/login', null, 'POST', { email: curator.email, senha: 'NewQaPassword123!' });
    const noAccount = await request('/auth/forgot-password', null, 'POST', { email: 'inexistente@qa.invalid' });
    assert.equal(smtp.messages.length, 0);
    const forgot = await fetch(`${base}/api/auth/forgot-password`, { method: 'POST', headers: { 'Content-Type': 'application/json', Host: 'host-injetado.invalid' }, body: JSON.stringify({ email: curator.email }) });
    assert.equal(forgot.status, 200);
    assert.deepEqual(await forgot.json(), noAccount, 'Resposta não revela token nem distingue conta existente.');
    assert.equal(smtp.messages.length, 1);
    assert.equal(smtp.authentications[0], '\u0000qa-mail\u0000qa-mail-fixture');
    const resetLink = new URL(smtp.linkFor(curator.email));
    assert.equal(resetLink.origin, base, 'Recuperação usa APP_URL, não o Host recebido.');
    assert.ok(smtp.messages[0].data.includes('noreply@qa.invalid'));
    await request('/auth/reset-password', null, 'POST', { token: resetLink.searchParams.get('token'), novaSenha: 'EmailQaPassword123!' });
    await request('/auth/login', null, 'POST', { email: curator.email, senha: 'EmailQaPassword123!' });
    await request('/auth/forgot-password', null, 'POST', { email: 'invalido' }, 400);
    process.env.APP_URL = 'javascript:origem-invalida';
    await request('/auth/forgot-password', null, 'POST', { email: curator.email }, 503);
    process.env.APP_URL = base;
    assert.equal(smtp.messages.length, 1, 'Origem inválida não deve gerar email.');
    console.log('[OK HTTP-7] SMTP local autenticado, link de APP_URL, reset funcional e consumo concorrente único do token.');

    await request('/profile', a.token, 'PUT', { bio: 'Minha biblioteca pessoal', role: 'admin', is_premium: true });
    const profile = await request('/profile', a.token);
    assert.equal(profile.bio, 'Minha biblioteca pessoal'); assert.equal(profile.role, 'leitor');
    await request('/profile', a.token, 'PUT', { id: b.id, bio: 'invasao' }, 403);
    await request('/profile/avatar', b.token, 'GET', undefined, 404);
    const avatarForm = () => { const data = new FormData(); data.append('file', new Blob([png], { type: 'image/png' }), 'avatar.png'); return data; };
    await request('/profile/avatar', a.token, 'POST', avatarForm(), 201);
    const avatar = await request('/profile/avatar', a.token, 'GET', undefined, 200, true);
    assert.equal(avatar.headers.get('content-type'), 'image/webp');
    assert.ok((await avatar.arrayBuffer()).byteLength > 0);
    const [oldAvatar] = await db.query('SELECT avatar_url FROM usuarios WHERE id=?', [a.id]);
    const unsignedAvatar = await fetch(`http://127.0.0.1:${process.env.MINIO_PORT}/${AVATARS_BUCKET}/${oldAvatar[0].avatar_url}`);
    assert.equal(unsignedAvatar.status, 403); await unsignedAvatar.text();
    await request('/profile/avatar', a.token, 'POST', avatarForm(), 201);
    const [avatarQueue] = await db.query('SELECT bucket, object_key FROM minio_objetos_pendentes_remocao WHERE object_key=?', [oldAvatar[0].avatar_url]);
    assert.equal(avatarQueue[0].bucket, AVATARS_BUCKET);
    await processPendingMinioDeletions(db, store);
    const [avatarPending] = await db.query('SELECT id FROM minio_objetos_pendentes_remocao WHERE object_key=?', [oldAvatar[0].avatar_url]);
    assert.equal(avatarPending.length, 0);
    await assert.rejects(realStore.get(AVATARS_BUCKET, oldAvatar[0].avatar_url));
    console.log('[OK HTTP-8] Perfil próprio, campos privilegiados ignorados, avatar privado e remoção compensatória após substituição.');
    if (process.env.QA_BROWSER_TESTS === '1') await require('./browser.integration.cjs')(base, png, async token => {
      const [rows] = await db.query("SELECT id FROM usuarios WHERE email='browser@qa.invalid'");
      await request('/stripe/checkout', token, 'POST', {});
      const [billing] = await db.query('SELECT stripe_customer_id, billing_identity FROM usuarios WHERE id=?', [rows[0].id]);
      subscriptionState = { id: 'sub_browser', livemode: false, customer: billing[0].stripe_customer_id, metadata: { app: 'mangacloud', userId: String(rows[0].id), billingIdentity: billing[0].billing_identity }, status: 'active', cancel_at_period_end: false, items: { data: [{ price: { id: 'price_qa' }, current_period_end: Math.floor(Date.now() / 1000) + 3600 }] }, latest_invoice: { status: 'paid' } };
      assert.equal(await webhook('evt_browser_paid', 'customer.subscription.updated'), 200);
    }, {
      admin: { email: adminUser.email, password: 'QaPassword123!' }, resetLinkFor: email => smtp.linkFor(email),
      preparePagination: async () => {
        const [readers] = await db.query("SELECT id FROM usuarios WHERE email='browser@qa.invalid'");
        const ownerId = readers[0].id;
        const numbers = Array.from({ length: 101 }, (_, index) => String(index + 1).padStart(3, '0'));
        await db.query('INSERT INTO estantes (usuario_id, nome) VALUES ?', [numbers.map(n => [ownerId, `QA Estante ${n}`])]);
        const [shelves] = await db.query("SELECT id FROM estantes WHERE usuario_id=? AND nome='QA Estante 001'", [ownerId]);
        const shelfId = shelves[0].id;
        // Referências cuja fonte deixou de retornar metadados: cenário suportado
        // pelo domínio, sem introduzir catálogo fictício na aplicação.
        await db.query('INSERT INTO estante_itens (estante_id, provider, manga_id) VALUES ?', [numbers.map(n => [shelfId, 'demo', `qa-removed-${n}`])]);
        await db.query('INSERT INTO favoritos_manga (usuario_id, provider, manga_id) VALUES ?', [numbers.map(n => [ownerId, 'demo', `qa-removed-${n}`])]);
        await db.query('INSERT INTO progresso_leitura (usuario_id, provider, manga_id, chapter_id, idioma, pagina, total_paginas, revisao) VALUES ?', [numbers.map(n => [ownerId, 'demo', `qa-removed-${n}`, `qa-removed-chapter-${n}`, 'pt-br', 1, 2, 1])]);
        await db.query('INSERT INTO usuarios (nome, email, senha_hash, role) VALUES ?', [numbers.map(n => [`QA Pessoa ${n}`, `qa-pagination-${n}@qa.invalid`, 'fixture-without-login', 'leitor'])]);
        return { shelfId };
      }
    });
    let mangaEvidence;
    if (process.env.QA_MANGADEX_LIVE === '1') {
      Object.assign(mangadexCatalogProvider, originalMangaDex);
      const result = await backend('./src/providers/verifyPhase1.ts').runLiveMangadexIntegrationCheck();
      assert.equal(result.status, 'APROVADO', result.reason);
      assert.ok(result.evidence);
      mangaEvidence = result.evidence;
      if (process.env.QA_STRIPE_LIVE !== '1') {
        const reader = await account('leitura-real');
        await require('./mangadex-browser.integration.cjs')(base, result.evidence, reader, liveNetwork);
      }
    }
    if (process.env.QA_STRIPE_LIVE === '1') await require('./stripe-live.integration.cjs')({ db, store, emit, mangaEvidence, network: liveNetwork, adminToken: adminUser.token });
    console.log('=== MANGACLOUD HTTP: INTEGRAÇÃO APROVADA (serviços externos somente nas opções explícitas ao vivo) ===');
  } finally {
    for (const server of servers.reverse()) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (smtp) await smtp.close();
    liveNetwork?.restore();
    if (closeRedis) await closeRedis();
    if (db) await db.end();
    if (created) await admin.query(`DROP DATABASE ${dbName}`);
    await admin.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
