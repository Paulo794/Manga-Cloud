// Opt-in: Checkout real em Stripe TESTE + CLI e banco/usuário exclusivos de QA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const backend = createRequire(path.join(root, 'backend/package.json'));
const frontend = createRequire(path.join(root, 'frontend/package.json'));
const { chromium, expect } = frontend('@playwright/test');
const mask = message => String(message).replace(/(?:sk_test_|whsec_|cs_test_|bps_test_)[\w]+/g, '[redigido]').replace(/https:\/\/(?:checkout|billing)\.stripe\.com\/\S+/g, '[sessao stripe de teste]');

module.exports = async function stripeLive({ db, store, emit, mangaEvidence, network, adminToken }) {
  assert.equal(process.env.DB_HOST, '127.0.0.1');
  assert.ok(process.env.QA_EPHEMERAL_INSTANCE);
  assert.equal(process.env.QA_STRIPE_LIVE, '1');
  const out = path.join(root, 'docs/qa/evidencias'); fs.mkdirSync(out, { recursive: true });
  const report = { checkedAt: new Date().toISOString(), status: 'EM_EXECUCAO', mode: 'stripe-test-external', price: { currency: 'brl', unitAmount: 990, interval: 'month' }, step: 'configuration', cleanup: {} };
  const save = step => { if (step) report.step = step; fs.writeFileSync(path.join(out, 'stripe-live.json'), JSON.stringify(report, null, 2) + '\n'); };
  save();
  const previous = Object.fromEntries(['STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_DEMO_ENABLED', 'APP_URL'].map(key => [key, process.env[key]]));
  const runId = crypto.randomUUID(), email = `mangacloud-${runId}@example.invalid`;
  let stripe, listener, server, browser, page, base, token, temp, customer, subscriptionId, clock, failure;
  const authRequest = async (route, authToken, method = 'GET', body, expected = 200) => {
    const response = await fetch(`${base}/api${route}`, { method, headers: { Authorization: `Bearer ${authToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    assert.equal(response.status, expected, `${route}: ${data.code || 'status inesperado'}`);
    return data;
  };
  const request = (route, method = 'GET', body, expected = 200) => authRequest(route, token, method, body, expected);
  try {
    // Lê somente chave/preço; não injeta DB, SMTP ou outras variáveis do .env.
    const config = backend('dotenv').parse(fs.readFileSync(path.join(root, '.env')));
    const key = config.STRIPE_SECRET_KEY, priceId = config.STRIPE_PRICE_ID;
    assert.ok(key?.startsWith('sk_test_') && priceId?.startsWith('price_'), 'Configurar chave/preço Stripe de teste no .env.');
    Object.assign(process.env, { STRIPE_SECRET_KEY: key, STRIPE_PRICE_ID: priceId, STRIPE_DEMO_ENABLED: 'true' });
    stripe = new (backend('stripe'))(key, { timeout: 10000, maxNetworkRetries: 1 });
    const price = await stripe.prices.retrieve(priceId);
    assert.equal(price.livemode, false); assert.equal(price.active, true);
    assert.equal(price.currency, 'brl'); assert.equal(price.unit_amount, 990);
    assert.equal(price.recurring?.interval, 'month'); assert.equal(price.recurring?.interval_count, 1);
    const { createApp } = backend('./src/app.ts');
    server = createApp({ db, store, emit }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
    process.env.APP_URL = base;
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mangacloud-stripe-qa-'));
    save('listener');
    listener = spawn(path.join(root, 'backend/stripe'), ['listen', '--skip-update', '--color', 'off', '--config', path.join(temp, 'config.toml'), '--events', 'checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_succeeded,invoice.payment_failed', '--forward-to', `${base}/api/stripe/webhook`], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, STRIPE_API_KEY: key, STRIPE_NO_AUTO_UPDATE: '1' }, stdio: ['ignore', 'pipe', 'pipe']
    });
    // O secret e a saída bruta do CLI permanecem apenas em memória.
    await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Stripe CLI não ficou pronto em 30 segundos.')), 30000);
      const consume = bytes => {
        output = (output + bytes.toString()).slice(-16000);
        const secret = output.match(/whsec_[A-Za-z0-9]+/);
        if (secret) { process.env.STRIPE_WEBHOOK_SECRET = secret[0]; clearTimeout(timer); resolve(); }
      };
      listener.stdout.on('data', consume); listener.stderr.on('data', consume);
      listener.once('error', error => { clearTimeout(timer); reject(error); });
      listener.once('exit', code => { clearTimeout(timer); reject(new Error(`Stripe CLI encerrou com código ${code}.`)); });
    });
    report.listenerReady = true;
    console.log('[QA STRIPE] Preço de teste validado; listener local pronto. Segredos omitidos.');
    save('account-and-library');
    if (network) await network.resolve('uploads.mangadex.org');
    const rules = network ? Object.entries(network.mappings()).map(([host, ips]) => `MAP ${host} ${ips[0]}`).join(',') : '';
    browser = await chromium.launch({ ...(fs.existsSync('/usr/bin/google-chrome') ? { executablePath: '/usr/bin/google-chrome' } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', ...(rules ? [`--host-resolver-rules=${rules}`] : [])] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'pt-BR' });
    page = await context.newPage(); page.setDefaultTimeout(30000);
    await page.goto(`${base}/login?cadastro=1`);
    await page.getByLabel('Nome', { exact: true }).fill('Leitor Stripe QA');
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Senha', { exact: true }).fill('QaPassword123!');
    await page.getByRole('button', { name: 'Criar conta gratuita', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Entre na sua biblioteca' })).toBeVisible();
    await page.getByRole('button', { name: 'Entrar →', exact: true }).click();
    await expect(page).toHaveURL(`${base}/catalogo`);
    token = await page.evaluate(() => localStorage.getItem('token'));
    const profile = await request('/profile');
    assert.equal(profile.assinatura.isPro, false);
    await page.goto(`${base}/estantes`);
    await page.getByLabel('Nome da estante', { exact: true }).fill('Estante Stripe QA');
    await page.getByRole('button', { name: '+ Criar estante', exact: true }).click();
    await expect(page).toHaveURL(/\/estantes\/\d+$/);
    const shelf = { id: Number(new URL(page.url()).pathname.split('/').pop()) };
    const cover = await backend('sharp')({ create: { width: 40, height: 60, channels: 3, background: '#b23c32' } }).png().toBuffer();
    await page.getByLabel('Enviar capa', { exact: true }).setInputFiles({ name: 'capa-qa.png', mimeType: 'image/png', buffer: cover });
    await expect.poll(() => page.getByAltText('Capa de Estante Stripe QA', { exact: true }).evaluate(i => i.naturalWidth)).toBeGreaterThan(0);
    report.privateShelfCoverDecoded = true;
    await request('/admin/metricas', 'GET', undefined, 403);
    const baselineMetrics = adminToken ? await authRequest('/admin/metricas', adminToken) : null;
    await request('/estantes', 'POST', { nome: 'Estante QA Free 2' }, 201);
    await request('/estantes', 'POST', { nome: 'Estante QA Free 3' }, 201);
    await page.goto(`${base}/estantes`);
    await expect(page.getByText('Plano Free: 3 de 3 estantes pessoais utilizadas.')).toBeVisible();
    await page.getByLabel('Nome da estante', { exact: true }).fill('Estante QA 4 Bloqueada');
    await page.getByRole('button', { name: '+ Criar estante', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Limite do plano Free atingido');
    assert.equal((await request('/estantes')).total, 3);
    report.freeShelfLimitBlocked = true;
    const favoriteProvider = mangaEvidence ? 'mangadex' : 'demo', favoriteId = mangaEvidence?.mangaId ?? 'demo-alquimia-astral';
    await page.goto(`${base}/mangas/${favoriteProvider}/${favoriteId}`);
    await page.getByLabel('Estante de destino', { exact: true }).selectOption(String(shelf.id));
    await page.getByRole('button', { name: 'Adicionar à estante', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Obra adicionada à estante.');
    await page.getByRole('button', { name: '♡ Favoritar', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Adicionado aos favoritos.');
    const decode = async () => {
      await expect.poll(() => page.locator('.reader-page').evaluate(i => i.naturalWidth), { timeout: 30000 }).toBeGreaterThan(0);
      return page.locator('.reader-page').evaluate(i => ({ width: i.naturalWidth, height: i.naturalHeight }));
    };
    if (mangaEvidence) {
      save('mangadex-free');
      await page.locator(`a[href="/leitura/mangadex/${mangaEvidence.chapterId}"]`).click();
      const decodedPages = [await decode()];
      await page.getByRole('button', { name: 'Próxima página →', exact: true }).click();
      decodedPages.push(await decode());
      assert.equal((await request('/assinatura')).isPro, false);
      report.mangadex = { mangaId: favoriteId, chapterId: mangaEvidence.chapterId, freeDecodedPages: decodedPages, dnsMode: network ? 'temporary-public-dns' : 'system-dns' };
    }
    await page.goto(`${base}/assinatura`);
    await page.getByRole('button', { name: 'Abrir checkout de teste →', exact: true }).click();
    await page.waitForURL(url => url.origin === 'https://checkout.stripe.com', { timeout: 45000 });
    const [billing] = await db.query('SELECT stripe_customer_id, billing_identity FROM usuarios WHERE id=?', [profile.id]);
    customer = billing[0].stripe_customer_id;
    const checkout = (await stripe.checkout.sessions.list({ customer, status: 'open', limit: 10 })).data.find(s => s.metadata?.billingIdentity === billing[0].billing_identity);
    assert.ok(checkout); assert.equal(checkout.livemode, false);
    report.checkoutCreated = true;
    save('checkout-payment');
    console.log('[QA STRIPE] Checkout de teste aberto pela aplicação. Validando pagamento com cartão de teste.');
    async function findInFrames(selector) {
      let matched = null;
      await expect.poll(async () => {
        for (const frame of page.frames()) {
          const loc = frame.locator(selector).first();
          if (await loc.count()) { matched = loc; return true; }
        }
        return false;
      }, { timeout: 30000 }).toBe(true);
      return matched;
    }
    async function fill(selector, value) {
      const input = await findInFrames(selector);
      await input.fill(value);
    }
    await fill('input[name="cardNumber"],input[autocomplete="cc-number"]', '4242424242424242');
    await fill('input[name="cardExpiry"],input[autocomplete="cc-exp"]', '12/34');
    await fill('input[name="cardCvc"],input[autocomplete="cc-csc"]', '123');
    await fill('input[name="billingName"],input[autocomplete="cc-name"]', 'Leitor Stripe QA');
    for (const frame of page.frames()) {
      const country = frame.locator('select[name="billingCountry"],select[name="country"]').first();
      if (await country.count() && await country.isVisible()) { await country.selectOption('BR'); break; }
    }
    for (const frame of page.frames()) {
      const postal = frame.locator('input[name="billingPostalCode"],input[name="postalCode"],input[autocomplete="postal-code"]').first();
      if (await postal.count() && await postal.isVisible()) { await postal.fill('01001000'); break; }
    }
    const submitBtn = await findInFrames('button[type="submit"]:visible');
    await submitBtn.click();
    await page.waitForURL(`${base}/sucesso`, { timeout: 60000 });
    await expect.poll(async () => (await request('/assinatura')).isPro, { timeout: 60000, intervals: [1000, 2000] }).toBe(true);
    const paidCheckout = await stripe.checkout.sessions.retrieve(checkout.id);
    assert.equal(paidCheckout.status, 'complete'); assert.equal(paidCheckout.payment_status, 'paid');
    subscriptionId = typeof paidCheckout.subscription === 'string' ? paidCheckout.subscription : paidCheckout.subscription.id;
    const subscription = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['latest_invoice'] });
    assert.equal(subscription.livemode, false); assert.equal(subscription.status, 'active');
    assert.equal(subscription.latest_invoice.status, 'paid');
    report.paymentConfirmed = true; report.proConfirmedByWebhook = true;
    await page.goto(`${base}/estantes`);
    await expect(page.getByText('Plano Pro ativo: estantes pessoais ilimitadas.')).toBeVisible();
    await page.getByLabel('Nome da estante', { exact: true }).fill('Estante QA 4 Pro');
    await page.getByRole('button', { name: '+ Criar estante', exact: true }).click();
    await expect(page).toHaveURL(/\/estantes\/\d+$/);
    assert.equal((await request('/estantes')).total, 4);
    report.proShelfLimitUnlocked = true;
    if (adminToken && baselineMetrics) {
      const proMetrics = await authRequest('/admin/metricas', adminToken);
      assert.equal(proMetrics.usuariosPorPlano.pro, baselineMetrics.usuariosPorPlano.pro + 1);
      assert.equal(proMetrics.assinaturasAtivas, baselineMetrics.assinaturasAtivas + 1);
      assert.equal(proMetrics.mrrCentavos, baselineMetrics.mrrCentavos + 990);
      report.adminMetricsUpdatedOnPro = true;
    }
    if (process.env.QA_STRIPE_CLOCKS === '1') {
      clock = await stripe.testHelpers.testClocks.create({ customer, frozen_time: Math.floor(Date.now() / 1000) + 5, name: `MangaCloud QA ${runId}` });
      report.testClockAttached = true;
    }
    save('reading-and-renewal');
    await page.goto(`${base}/leitura/demo/demo-aa-pt-cap-4`);
    await expect(page.locator('.reader-page')).toBeVisible();
    await page.getByRole('button', { name: 'Próxima página →', exact: true }).click();
    await expect(page.getByText('Progresso salvo.', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Página atual', { exact: true })).toHaveValue('2');
    report.readingResumed = true;
    if (mangaEvidence) {
      await page.goto(`${base}/leitura/mangadex/${mangaEvidence.chapterId}`);
      await decode();
      await page.getByRole('button', { name: 'Próxima página →', exact: true }).click();
      await expect(page.getByText('Progresso salvo.', { exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByLabel('Página atual', { exact: true })).toHaveValue('2');
      await decode(); report.mangadex.proReadingResumed = true;
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${base}/catalogo`);
      const card = page.locator(`.manga-card[href="/mangas/mangadex/${favoriteId}"]`);
      await card.scrollIntoViewIfNeeded();
      await expect.poll(() => card.locator('img').evaluate(i => i.naturalWidth)).toBeGreaterThan(0);
      await page.screenshot({ path: path.join(out, 'mvp-catalog-mobile.png') });
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    const portalConfigs = await stripe.billingPortal.configurations.list({ is_default: true, active: true, limit: 1 });
    const portalCancelMode = portalConfigs.data[0]?.features?.subscription_cancel?.mode || null;
    report.portalPolicy = portalCancelMode;
    await page.goto(`${base}/assinatura`);
    if (portalConfigs.data.length > 0) {
      save('billing-portal');
      await page.getByRole('button', { name: 'Gerenciar assinatura', exact: true }).first().click();
      await page.waitForURL(url => url.origin === 'https://billing.stripe.com', { timeout: 45000 });
      report.billingPortalOpened = true;
      const startCancel = page.getByRole('link', { name: /Cancelar (assinatura|plano)|Cancel (subscription|plan)/i })
        .or(page.getByRole('button', { name: /Cancelar (assinatura|plano)|Cancel (subscription|plan)/i })).first();
      await startCancel.waitFor({ state: 'visible', timeout: 30000 });
      await startCancel.click();
      await page.waitForURL(/\/cancel/, { timeout: 15000 }).catch(() => {});
      const reasonTrigger = page.getByText(/Selecione motivo|Select a reason/i).first();
      const continueCancel = page.getByText(/Continue para cancelamento|Continue to cancel/i).first();
      if (await continueCancel.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)) {
        if (await reasonTrigger.isVisible().catch(() => false)) {
          await reasonTrigger.click();
          const firstOption = page.locator('[role="option"]').first();
          await firstOption.waitFor({ state: 'visible', timeout: 5000 });
          await firstOption.click();
        }
        await continueCancel.click();
        await continueCancel.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
      }
      const skipFeedback = page.getByRole('button', { name: /Não quero responder|Skip/i }).first();
      const confirmCancelBtn = page.getByRole('button', { name: /Cancelar (assinatura|plano)|Cancel (subscription|plan)/i }).last();
      await confirmCancelBtn.waitFor({ state: 'visible', timeout: 30000 });
      await confirmCancelBtn.click();
      await skipFeedback.waitFor({ state: 'visible', timeout: 3000 }).then(() => skipFeedback.click()).catch(() => {});
      await expect.poll(async () => {
        const current = await stripe.subscriptions.retrieve(subscriptionId);
        return Boolean(current.cancel_at_period_end || current.cancel_at || current.status === 'canceled');
      }, { timeout: 60000, intervals: [1000, 2000] }).toBe(true);
      report.billingPortalCancelled = true;
      await page.goto(`${base}/assinatura?portal=1`);
      if (portalCancelMode === 'immediately') {
        await expect.poll(async () => (await request('/assinatura')).isPro, { timeout: 60000, intervals: [1000, 2000] }).toBe(false);
      } else {
        await expect.poll(async () => (await request('/assinatura')).cancelAtPeriodEnd, { timeout: 60000, intervals: [1000, 2000] }).toBe(true);
      }
    }
    const advance = async until => {
      await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: until });
      await expect.poll(async () => (await stripe.testHelpers.testClocks.retrieve(clock.id)).status, { timeout: 90000, intervals: [1000, 2000] }).toBe('ready');
    };
    const activeAfterPortal = await stripe.subscriptions.retrieve(subscriptionId);
    if (activeAfterPortal.status === 'active') {
      if (activeAfterPortal.cancel_at_period_end || activeAfterPortal.cancel_at) {
        await page.getByRole('button', { name: 'Manter renovação', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Cancelar renovação', exact: true })).toBeVisible();
        const maintained = await stripe.subscriptions.retrieve(subscriptionId);
        assert.equal(Boolean(maintained.cancel_at_period_end || maintained.cancel_at), false);
        report.renewalRestored = true;
      }
      await page.getByRole('button', { name: 'Cancelar renovação', exact: true }).click();
      await page.getByRole('button', { name: 'Confirmar cancelamento', exact: true }).click();
      await expect(page.getByText(/Cancelamento agendado\./)).toBeVisible();
      const rescheduled = await stripe.subscriptions.retrieve(subscriptionId);
      assert.equal(Boolean(rescheduled.cancel_at_period_end || rescheduled.cancel_at), true);
      assert.equal((await request('/assinatura')).isPro, true);
      report.cancelScheduled = true; report.accessPreservedUntilPeriodEnd = true;
      if (!report.renewalRestored) {
        await page.getByRole('button', { name: 'Manter renovação', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Cancelar renovação', exact: true })).toBeVisible();
        const maintained = await stripe.subscriptions.retrieve(subscriptionId);
        assert.equal(Boolean(maintained.cancel_at_period_end || maintained.cancel_at), false);
        report.renewalRestored = true;
        await page.getByRole('button', { name: 'Cancelar renovação', exact: true }).click();
        await page.getByRole('button', { name: 'Confirmar cancelamento', exact: true }).click();
        await expect(page.getByText(/Cancelamento agendado\./)).toBeVisible();
      }
      await page.screenshot({ path: path.join(out, 'stripe-assinatura-confirmada.png') });
      save('effective-cancellation');
      if (clock) {
        await advance(subscription.items.data[0].current_period_end + 1);
        await expect.poll(async () => (await stripe.subscriptions.retrieve(subscriptionId)).status, { timeout: 60000, intervals: [1000, 2000] }).toBe('canceled');
      } else await stripe.subscriptions.cancel(subscriptionId, { prorate: false, invoice_now: false });
    }
    await expect.poll(async () => (await request('/assinatura')).isPro, { timeout: 60000, intervals: [1000, 2000] }).toBe(false);
    await request('/estantes', 'POST', { nome: 'Estante QA 5 Bloqueada' }, 403);
    report.freeShelfLimitRestoredAfterCancel = true;
    if (adminToken && baselineMetrics) {
      const revertedMetrics = await authRequest('/admin/metricas', adminToken);
      assert.equal(revertedMetrics.usuariosPorPlano.pro, baselineMetrics.usuariosPorPlano.pro);
      assert.equal(revertedMetrics.mrrCentavos, baselineMetrics.mrrCentavos);
      report.adminMrrRevertedOnCancel = true;
    }
    assert.equal((await request('/progresso/demo/demo-alquimia-astral?idioma=pt-br')).pagina, 2);
    assert.ok((await request('/estantes')).items.some(s => s.id === shelf.id));
    assert.ok((await request('/favoritos')).items.some(f => f.manga_id === favoriteId));
    report.effectiveCancellation = clock ? 'automatic-period-end-test-clock' : 'immediate-test-cleanup'; report.returnedToFree = true; report.userDataPreserved = true;
    if (mangaEvidence) {
      assert.equal((await request(`/progresso/mangadex/${favoriteId}?idioma=pt-br`)).pagina, 2);
      const realManifest = await request(`/leitura/mangadex/${mangaEvidence.chapterId}/manifesto`);
      assert.equal(realManifest.isDemo, false); report.mangadex.stillFreeAfterCancellation = true;
      report.singleAccountMvp = true;
    }
    const denied = await fetch(`${base}/api/leitura/demo/demo-aa-pt-cap-4/manifesto`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(denied.status, 403); assert.equal((await denied.json()).code, 'PLAN_REQUIRED');
    const events = await stripe.events.list({ type: 'customer.subscription.deleted', limit: 30 });
    const terminal = events.data.find(event => event.data.object.id === subscriptionId);
    assert.ok(terminal);
    const [ledger] = await db.query('SELECT status FROM stripe_eventos WHERE event_id=?', [terminal.id]);
    assert.equal(ledger[0]?.status, 'processed');
    report.terminalWebhookProcessed = true;
    if (clock) {
      save('failed-renewal');
      console.log('[QA STRIPE] Vencimento automático confirmado. Verificando renovação recusada no relógio de teste.');
      const metadata = (await stripe.customers.retrieve(customer)).metadata;
      const goodMethod = typeof subscription.default_payment_method === 'string' ? subscription.default_payment_method : subscription.default_payment_method.id;
      const renewal = await stripe.subscriptions.create({ customer, items: [{ price: priceId }], metadata, default_payment_method: goodMethod, payment_behavior: 'error_if_incomplete' });
      await expect.poll(async () => (await request('/assinatura')).isPro, { timeout: 60000, intervals: [1000, 2000] }).toBe(true);
      const failing = await stripe.paymentMethods.attach('pm_card_chargeCustomerFail', { customer });
      await stripe.subscriptions.update(renewal.id, { default_payment_method: failing.id });
      const end = renewal.items.data[0].current_period_end;
      await advance(end + 1); await advance(end + 7200);
      await expect.poll(async () => {
        const latest = await stripe.subscriptions.retrieve(renewal.id, { expand: ['latest_invoice'] });
        return latest.latest_invoice.status === 'open' && latest.latest_invoice.attempt_count > 0 && ['past_due', 'unpaid', 'canceled'].includes(latest.status);
      }, { timeout: 60000, intervals: [1000, 2000] }).toBe(true);
      await expect.poll(async () => (await request('/assinatura')).isPro, { timeout: 60000, intervals: [1000, 2000] }).toBe(false);
      const overdueSub = await request('/assinatura');
      assert.equal(overdueSub.inadimplente, true, `Esperava assinatura inadimplente após falha, recebido: ${overdueSub.status}`);
      report.inadimplenteStatusConfirmed = overdueSub.status;
      if (adminToken) {
        const overdueMetrics = await authRequest('/admin/metricas', adminToken);
        assert.ok(overdueMetrics.assinaturasPorStatus.inadimplentes >= 1);
        report.adminInadimplenteMetricConfirmed = true;
      }
      await expect.poll(async () => {
        const failedList = await stripe.events.list({ type: 'invoice.payment_failed', limit: 30 });
        const failedMatch = failedList.data.find(event => event.data.object.customer === customer);
        if (!failedMatch) return false;
        const [rows] = await db.query('SELECT status FROM stripe_eventos WHERE event_id=?', [failedMatch.id]);
        return rows[0]?.status === 'processed';
      }, { timeout: 60000, intervals: [1000, 2000] }).toBe(true);
      assert.equal((await request('/progresso/demo/demo-alquimia-astral?idioma=pt-br')).pagina, 2);
      report.failedRenewalRevokedPro = true; report.failedPaymentWebhookProcessed = true;
    }
    if (adminToken) {
      let actions = new Set();
      for (let attempt = 0; attempt < 20; attempt++) {
        const logsPayload = await authRequest('/admin/logs', adminToken);
        actions = new Set((logsPayload.eventos || []).map(item => item.acao));
        const hasBase = actions.has('estante.limite_atingido') && actions.has('assinatura.atualizada');
        const hasPortal = portalConfigs.data.length === 0 || actions.has('assinatura.portal_aberto');
        const hasFailure = !clock || actions.has('assinatura.pagamento_falhou');
        if (hasBase && hasPortal && hasFailure) break;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      assert.ok(actions.has('estante.limite_atingido'), 'Esperava estante.limite_atingido em /admin/logs');
      assert.ok(actions.has('assinatura.atualizada'), 'Esperava assinatura.atualizada em /admin/logs');
      if (portalConfigs.data.length > 0) assert.ok(actions.has('assinatura.portal_aberto'), 'Esperava assinatura.portal_aberto em /admin/logs');
      if (clock) assert.ok(actions.has('assinatura.pagamento_falhou'), 'Esperava assinatura.pagamento_falhou em /admin/logs');
      report.adminAuditEventsVerified = true;
    }
    report.status = 'APROVADO'; save('complete');
    console.log('[OK STRIPE LIVE] Checkout/pagamento de teste, webhook real, Pro, retomada, renovação e retorno a Free com dados preservados.');
  } catch (error) {
    failure = error; report.status = 'FALHOU'; report.failure = mask(error.message);
    if (page && page.url().startsWith('https://checkout.stripe.com')) {
      report.checkoutFields = [];
      for (const frame of page.frames()) report.checkoutFields.push(...await frame.locator('input,select,button[type="submit"]').evaluateAll(elements => elements.map(e => ({ tag: e.tagName, name: e.getAttribute('name'), type: e.getAttribute('type'), autocomplete: e.getAttribute('autocomplete'), label: e.getAttribute('aria-label') }))).catch(() => []));
    }
  } finally {
    // A prova de webhook terminou antes da limpeza. Parar o encaminhamento
    // evita processar eventos atrasados de recursos apagados junto ao clock.
    if (listener && listener.exitCode === null) {
      listener.kill('SIGTERM');
      await Promise.race([once(listener, 'exit'), new Promise(resolve => setTimeout(() => { if (listener.exitCode === null) listener.kill('SIGKILL'); resolve(); }, 3000))]);
      report.cleanup.listenerStopped = true;
    }
    // Redescobre apenas objetos desta conta QA, inclusive após rollback SQL.
    if (stripe) {
      try {
        const [rows] = await db.query('SELECT billing_identity FROM usuarios WHERE email=?', [email]);
        const identity = rows[0]?.billing_identity;
        if (identity) {
          const own = (await stripe.customers.list({ email, limit: 10, ...(clock ? { test_clock: clock.id } : {}) })).data.filter(c => !c.livemode && c.metadata?.app === 'mangacloud' && c.metadata?.billingIdentity === identity);
          for (const c of own) {
            for (const s of (await stripe.checkout.sessions.list({ customer: c.id, status: 'open', limit: 100 })).data) await stripe.checkout.sessions.expire(s.id);
            for (const s of (await stripe.subscriptions.list({ customer: c.id, status: 'all', limit: 100 })).data) if (!['canceled', 'incomplete_expired'].includes(s.status)) await stripe.subscriptions.cancel(s.id, { prorate: false, invoice_now: false });
            if (!clock) await stripe.customers.del(c.id);
          }
          if (clock) { await stripe.testHelpers.testClocks.del(clock.id); report.cleanup.testClockDeleted = true; }
          report.cleanup.testCustomersDeleted = own.length;
        }
      } catch (error) { report.cleanup.failure = mask(error.message); report.status = 'FALHOU'; failure ||= error; }
    }
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
    save();
  }
  if (failure) throw new Error(mask(failure.message));
};
