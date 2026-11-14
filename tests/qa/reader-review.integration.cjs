// Regressões reais de navegação/progresso; conta Pro do navegador em banco QA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const frontend = createRequire(path.resolve(__dirname, '../../frontend/package.json'));
const { expect } = frontend('@playwright/test');

module.exports = async function reviewReader(page, base) {
  assert.equal(new URL(base).hostname, '127.0.0.1');
  const file = path.resolve(__dirname, '../../docs/qa/evidencias/reader-review.json');
  const report = { checkedAt: new Date().toISOString(), status: 'EM_EXECUCAO', mode: 'local-demo-pro', checks: [], step: 'fast-navigation' };
  const save = () => fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  save();
  const token = await page.evaluate(() => localStorage.getItem('token'));
  const progress = async () => {
    const response = await page.request.get(`${base}/api/progresso/demo/demo-alquimia-astral?idioma=pt-br`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status(), 200); return response.json();
  };
  try {
    assert.equal((await progress()).pagina, 2);
    await page.getByLabel('Página atual', { exact: true }).selectOption('1');
    await page.getByRole('link', { name: 'Explorar', exact: true }).click();
    await expect(page).toHaveURL(`${base}/catalogo`);
    await expect.poll(async () => (await progress()).pagina, { timeout: 3000 }).toBe(1);
    report.checks.push('page-saved-on-fast-navigation');
    report.step = 'image-retry'; save();
    const chapter3 = `${base}/leitura/demo/demo-aa-pt-cap-3`;
    const manifestUrl = `${base}/api/leitura/demo/demo-aa-pt-cap-3/manifesto`;
    let manifestCount = 0;
    await page.route(manifestUrl, async route => {
      const response = await route.fetch();
      if (manifestCount++ === 0) {
        const manifest = await response.json();
        manifest.pages[1].imageUrl = `${base}/qa-page-unavailable`;
        await route.fulfill({ response, json: manifest });
      } else await route.fulfill({ response });
    });
    await page.goto(chapter3);
    await expect(page.getByLabel('Página atual', { exact: true })).toBeEnabled();
    await page.getByLabel('Página atual', { exact: true }).selectOption('2');
    await expect(page.getByRole('button', { name: 'Atualizar páginas', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Atualizar páginas', exact: true }).click();
    await expect(page.getByLabel('Página atual', { exact: true })).toHaveValue('2');
    await expect.poll(() => page.locator('.reader-page').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
    await expect.poll(async () => { const stored = await progress(); return `${stored.chapter_id}:${stored.pagina}`; }).toBe('demo-aa-pt-cap-3:2');
    await page.unroute(manifestUrl);
    report.checks.push('image-retry-preserves-current-page');

    report.step = 'chapter-change-with-save-in-flight'; save();
    const progressUrl = `${base}/api/progresso/demo/demo-alquimia-astral`;
    let releaseResponse, reachedServer;
    const held = new Promise(resolve => { releaseResponse = resolve; });
    const received = new Promise(resolve => { reachedServer = resolve; });
    let heldOnce = false;
    await page.route(progressUrl, async route => {
      if (route.request().method() !== 'PUT' || heldOnce) { await route.continue(); return; }
      heldOnce = true;
      const response = await route.fetch(); reachedServer();
      await held; await route.fulfill({ response });
    });
    try {
      await page.getByLabel('Página atual', { exact: true }).selectOption('1');
      await Promise.race([received, new Promise((_, reject) => setTimeout(() => reject(new Error('Save não chegou ao servidor.')), 5000))]);
      await page.getByRole('button', { name: '← Capítulo anterior', exact: true }).click();
      assert.equal(page.url(), chapter3, 'Mudança de capítulo aguarda a confirmação do save pendente.');
      releaseResponse();
      await expect(page).toHaveURL(`${base}/leitura/demo/demo-aa-pt-cap-2`);
      await expect(page.getByLabel('Página atual', { exact: true })).toHaveValue('1');
      await expect.poll(async () => { const stored = await progress(); return `${stored.chapter_id}:${stored.pagina}`; }).toBe('demo-aa-pt-cap-2:1');
    } finally { releaseResponse(); await page.unroute(progressUrl); }
    report.checks.push('chapter-save-isolated-and-serialized');

    report.step = 'concurrent-tabs'; save();
    const second = await page.context().newPage();
    try {
      await second.goto(page.url());
      await expect(second.getByLabel('Página atual', { exact: true })).toBeEnabled();
      await expect(second.getByLabel('Página atual', { exact: true })).toHaveValue('1');
      await page.getByLabel('Página atual', { exact: true }).selectOption('2');
      await expect(page.getByText('Progresso salvo.', { exact: true })).toBeVisible();
      await second.getByLabel('Página atual', { exact: true }).selectOption('2');
      await expect(second.getByRole('alert')).toContainText('O progresso mudou em outra aba');
      const revision = (await progress()).revisao;
      await second.getByLabel('Página atual', { exact: true }).selectOption('1');
      await second.getByRole('link', { name: 'Explorar', exact: true }).click();
      assert.equal((await progress()).revisao, revision, 'Aba em conflito não grava ao sair.');
      await second.goto(`${base}/leitura/demo/demo-aa-pt-cap-2`);
      await expect(second.getByLabel('Página atual', { exact: true })).toHaveValue('2');
      await second.getByLabel('Página atual', { exact: true }).selectOption('1');
      await expect(second.getByText('Progresso salvo.', { exact: true })).toBeVisible();
      assert.equal((await progress()).pagina, 1);
    } finally { await second.close(); }
    report.checks.push('stale-tab-pauses-without-overwriting');

    report.step = 'document-navigation'; save();
    await page.reload();
    await expect(page.getByLabel('Página atual', { exact: true })).toBeEnabled();
    await expect(page.getByLabel('Página atual', { exact: true })).toHaveValue('1');
    await page.getByRole('button', { name: 'Próxima página →', exact: true }).click();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByLabel('Página atual', { exact: true })).toHaveValue('1');
    report.checks.push('keyboard-works-after-control-click');
    await page.getByLabel('Página atual', { exact: true }).selectOption('2');
    await page.goto(`${base}/catalogo`);
    await expect.poll(async () => (await progress()).pagina, { timeout: 5000 }).toBe(2);
    report.checks.push('pagehide-keepalive-saves-final-page');
    report.status = 'APROVADO'; report.step = 'complete';
  } catch (error) {
    report.status = 'FALHOU'; report.failure = error.message;
    report.storedProgress = await progress().catch(() => null);
    throw error;
  } finally { save(); }
};
