// Browser -> API MangaCloud -> API MangaDex -> imagem real, conta Free em banco efêmero.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const frontend = createRequire(path.resolve(__dirname, '../../frontend/package.json'));
const { chromium, expect } = frontend('@playwright/test');

module.exports = async function liveBrowser(base, evidence, account, network) {
  assert.equal(new URL(base).hostname, '127.0.0.1');
  const reportFile = path.resolve(__dirname, '../../docs/qa/evidencias/mangadex-browser-live.json');
  const report = { checkedAt: new Date().toISOString(), status: 'EM_EXECUCAO', mode: network ? 'temporary-public-dns' : 'system-dns', provider: 'mangadex', isDemo: false, accountPlan: 'free', mangaId: evidence.mangaId, chapterId: evidence.chapterId, step: 'launch', imageRequests: [], imageResponses: [], imageFailures: [], console: [], errors: [] };
  const writeReport = () => { fs.mkdirSync(path.dirname(reportFile), { recursive: true }); fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n'); };
  writeReport();
  let browser, context, page, catalogCard;
  const imageState = () => catalogCard.locator('img').evaluate(image => {
    const rect = image.getBoundingClientRect();
    return { src: image.src, currentSrc: image.currentSrc, complete: image.complete, loading: image.loading, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, viewport: { width: innerWidth, height: innerHeight, scrollY }, display: getComputedStyle(image).display };
  });
  try {
    if (network) await network.resolve('uploads.mangadex.org');
    const rules = network ? Object.entries(network.mappings()).map(([host, ips]) => `MAP ${host} ${ips[0]}`).join(',') : '';
    report.dnsMappings = network?.mappings() || {};
    browser = await chromium.launch({
      ...(fs.existsSync('/usr/bin/google-chrome') ? { executablePath: '/usr/bin/google-chrome' } : {}),
      headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', ...(rules ? [`--host-resolver-rules=${rules}`] : [])]
    });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    const errors = report.errors, responses = new Map();
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (report.console.length < 20 && ['warning', 'error'].includes(message.type())) report.console.push({ type: message.type(), text: message.text() }); });
    page.on('request', request => { if (request.resourceType() === 'image' && report.imageRequests.length < 60) report.imageRequests.push(request.url()); });
    page.on('requestfailed', request => { if (request.resourceType() === 'image' && report.imageFailures.length < 60) report.imageFailures.push({ url: request.url(), error: request.failure()?.errorText }); });
    page.on('response', response => {
      if (response.request().resourceType() !== 'image') return;
      responses.set(response.url(), response.status());
      const headers = response.headers();
      if (report.imageResponses.length < 60) report.imageResponses.push({ url: response.url(), status: response.status(), headers: Object.fromEntries(['content-type', 'content-length', 'location', 'cross-origin-resource-policy', 'access-control-allow-origin'].filter(key => headers[key]).map(key => [key, headers[key]])) });
    });
    const screenshot = name => page.screenshot({ path: path.join(path.dirname(reportFile), name) });
    report.step = 'login';
    await page.goto(`${base}/login`);
    await page.getByLabel('Email', { exact: true }).fill(account.email);
    await page.getByLabel('Senha', { exact: true }).fill('QaPassword123!');
    await page.getByRole('button', { name: 'Entrar →', exact: true }).click();
    await expect(page).toHaveURL(`${base}/catalogo`);
    await expect(page.getByLabel('Fonte', { exact: true })).toHaveValue('mangadex');
    report.step = 'catalog-cover';
    catalogCard = page.locator(`.manga-card[href="/mangas/mangadex/${evidence.mangaId}"]`);
    await expect(catalogCard).toBeVisible({ timeout: 30000 });
    report.coverBefore = await imageState();
    await expect.poll(() => catalogCard.locator('img').evaluate(image => image.naturalWidth), { timeout: 30000 }).toBeGreaterThan(0);
    report.coverAfter = await imageState();
    assert.equal(new URL(report.coverAfter.currentSrc).origin, base, 'Capa entregue pelo MangaCloud, sem hotlink.');
    assert.equal(responses.get(report.coverAfter.currentSrc), 200);
    report.coverDecoded = true;
    await screenshot('mangadex-catalog-desktop.png');
    writeReport();

    report.step = 'shelf';
    await page.getByRole('link', { name: 'Estantes', exact: true }).click();
    await page.getByLabel('Nome da estante', { exact: true }).fill('MangaDex real — QA');
    await page.getByRole('button', { name: '+ Criar estante', exact: true }).click();
    await expect(page).toHaveURL(/\/estantes\/\d+$/);
    const shelfId = new URL(page.url()).pathname.split('/').pop();
    await page.goto(`${base}/mangas/mangadex/${evidence.mangaId}`);
    await expect(page.getByRole('heading', { level: 1 })).not.toBeEmpty();
    await expect.poll(() => page.locator('.work-cover img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
    report.workCoverDecoded = true;
    await page.getByLabel('Estante de destino', { exact: true }).selectOption(shelfId);
    await page.getByRole('button', { name: 'Adicionar à estante', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Obra adicionada à estante.');
    await page.goto(`${base}/estantes/${shelfId}`);
    await expect(page.locator(`a[href="/mangas/mangadex/${evidence.mangaId}"]`)).toBeVisible();
    await expect.poll(() => page.locator('.reference-list img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
    report.shelfCoverDecoded = true;
    await page.goto(`${base}/mangas/mangadex/${evidence.mangaId}`);
    report.step = 'reader';
    const manifestResponse = page.waitForResponse(response => response.url().endsWith(`/api/leitura/mangadex/${evidence.chapterId}/manifesto`), { timeout: 45000 });
    await page.locator(`a[href="/leitura/mangadex/${evidence.chapterId}"]`).click();
    const response = await manifestResponse;
    assert.equal(response.status(), 200, 'Leitor Free deve receber manifesto MangaDex real.');
    const manifest = await response.json();
    assert.equal(manifest.provider, 'mangadex'); assert.equal(manifest.isDemo, false);
    assert.equal(manifest.chapterId, evidence.chapterId); assert.ok(manifest.totalPages > 0);

    async function decodedPage() {
      const image = page.locator('.reader-page');
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate(element => element.naturalWidth), { timeout: 30000 }).toBeGreaterThan(0);
      const result = await image.evaluate(element => ({ width: element.naturalWidth, height: element.naturalHeight, url: element.currentSrc }));
      assert.equal(responses.get(result.url), 200, 'Imagem efetivamente recebida via HTTPS.');
      return { width: result.width, height: result.height, origin: new URL(result.url).origin, httpStatus: 200 };
    }
    const pages = [await decodedPage()];
    if (manifest.totalPages > 1) {
      await page.getByRole('button', { name: 'Próxima página →', exact: true }).click();
      await expect(page.getByLabel('Página atual', { exact: true })).toHaveValue('2');
      pages.push(await decodedPage());
    }
    report.step = 'mobile-cover';
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/catalogo`);
    await expect(catalogCard).toBeVisible();
    await catalogCard.scrollIntoViewIfNeeded();
    await expect.poll(() => catalogCard.locator('img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
    report.mobileCover = await imageState();
    await screenshot('mangadex-catalog-mobile.png');
    assert.deepEqual(errors, [], 'Fluxo real sem erros JavaScript.');
    Object.assign(report, { status: 'APROVADO', step: 'complete', totalPages: manifest.totalPages, catalogRendered: true, shelfReferenceHydrated: true, decodedPages: pages });
    console.log(`[OK MANGADEX BROWSER] Capas reais em catálogo desktop/mobile, obra e estante; autorização Free e ${pages.length} página(s) reais decodificadas no Chrome.`);
  } catch (error) {
    report.status = 'FALHOU'; report.failure = error.message;
    if (catalogCard) report.coverOnFailure = await imageState().catch(() => null);
    throw error;
  } finally { writeReport(); await context?.close(); await browser?.close(); }
};
