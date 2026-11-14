// Chamado pelo teste HTTP em instância exclusiva. Não utiliza sistema público.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const frontend = createRequire(path.resolve(__dirname, '../../frontend/package.json'));
const { chromium, expect } = frontend('@playwright/test');
module.exports = async function browserCheck(base, png, enablePro, fixtures) {
  assert.ok(base.startsWith('http://127.0.0.1:'));
  const out = path.resolve(__dirname, '../../docs/qa/evidencias'); fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ ...(fs.existsSync('/usr/bin/google-chrome') ? { executablePath: '/usr/bin/google-chrome' } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const page = await context.newPage(), pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  // O Chrome pode falhar na primeira captura durante uma troca de composição.
  // Repetir somente a captura, mantendo todas as asserções funcionais obrigatórias.
  async function screenshot(name) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await page.screenshot({ path: path.join(out, name), fullPage: true, animations: 'disabled' }); return; }
      catch (error) {
        if (attempt === 2 || !String(error).includes('Unable to capture screenshot')) throw error;
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
    }
  }
  try {
    await page.goto(base);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Mais histórias.');
    await expect(page.getByRole('heading', { name: 'Crônicas da Alquimia Astral' })).toBeVisible();
    await screenshot('mangacloud-landing-desktop.png');
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot('mangacloud-landing-mobile.png');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Landing sem overflow horizontal');
    await page.goto(`${base}/login?cadastro=1`);
    await page.getByLabel('Nome', { exact: true }).fill('Leitor Navegador');
    await page.getByLabel('Email', { exact: true }).fill('browser@qa.invalid');
    await page.getByLabel('Senha', { exact: true }).fill('QaPassword123!');
    await page.getByRole('button', { name: 'Criar conta gratuita', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Entre na sua biblioteca' })).toBeVisible();
    await page.getByRole('button', { name: 'Entrar →', exact: true }).click();
    await expect(page).toHaveURL(/\/catalogo$/);
    await page.getByLabel('Fonte', { exact: true }).selectOption('demo');
    await expect(page.getByRole('heading', { name: 'Crônicas da Alquimia Astral' })).toBeVisible();
    await page.getByRole('link', { name: 'Estantes', exact: true }).click();
    await expect(page.getByText(/Plano Free: \d+ de 3 estantes pessoais utilizadas\./)).toBeVisible();
    await page.getByLabel('Nome da estante', { exact: true }).fill('Minha coleção do navegador');
    await page.getByLabel('Descrição', { exact: true }).fill('Criada pelo fluxo real da interface');
    await page.getByRole('button', { name: '+ Criar estante', exact: true }).click();
    await expect(page).toHaveURL(/\/estantes\/\d+$/);
    const shelfUrl = page.url();
    const shelfId = new URL(shelfUrl).pathname.split('/').pop();
    await page.getByLabel('Nome', { exact: true }).fill('Coleção editada no navegador');
    await page.getByRole('button', { name: 'Salvar estante', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Coleção editada no navegador');
    await page.getByLabel('Enviar capa', { exact: true }).setInputFiles({ name: 'capa.png', mimeType: 'image/png', buffer: png });
    await expect(page.getByAltText('Capa de Coleção editada no navegador')).toBeVisible();
    await expect.poll(() => page.getByAltText('Capa de Coleção editada no navegador').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Estante sem overflow horizontal');
    await screenshot('mangacloud-estante-mobile.png');
    await page.goto(`${base}/catalogo?provider=demo`);
    await page.getByRole('heading', { name: 'Crônicas da Alquimia Astral' }).click();
    await page.getByRole('combobox', { name: 'Estante de destino' }).selectOption(shelfId);
    await page.getByRole('button', { name: 'Adicionar à estante', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Obra adicionada à estante.');
    await page.locator('a[href="/leitura/demo/demo-aa-pt-cap-1"]').click();
    const readingPage = page.getByAltText(/página 1$/);
    await expect(readingPage).toBeVisible();
    await expect.poll(() => readingPage.evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Próxima página →', exact: true }).click();
    await expect(page.getByAltText(/página 2$/)).toBeVisible();
    await screenshot('mangacloud-leitor-mobile.png');
    await page.goto(`${base}/leitura/demo/demo-aa-pt-cap-4`);
    await expect(page.getByRole('link', { name: 'Conhecer o Pro demonstrativo' })).toBeVisible();
    await expect(page.locator('.reader-page')).toHaveCount(0);
    await enablePro(await page.evaluate(() => localStorage.getItem('token')));
    await page.reload();
    await expect(page.getByAltText(/página 1$/)).toBeVisible();
    await page.getByRole('button', { name: 'Próxima página →', exact: true }).click();
    await expect(page.getByText('Progresso salvo.', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByAltText(/página 2$/)).toBeVisible();
    await require('./reader-review.integration.cjs')(page, base);
    await require('./pagination-review.integration.cjs')(page, base, fixtures.preparePagination);
    await page.goto(`${base}/assinatura`);
    await expect(page.getByRole('button', { name: 'Pro ativo', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Gerenciar assinatura', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancelar renovação', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Confirmar cancelamento' })).toContainText('até o fim do período pago');
    await page.getByRole('button', { name: 'Voltar', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Confirmar cancelamento' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Cancelar renovação', exact: true }).click();
    await page.getByRole('button', { name: 'Confirmar cancelamento', exact: true }).click();
    await expect(page.getByText(/Cancelamento agendado\./)).toBeVisible();
    await page.reload();
    await expect(page.getByText(/Cancelamento agendado\./)).toBeVisible();
    await screenshot('mangacloud-assinatura-mobile.png');
    await page.getByRole('button', { name: 'Manter renovação', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Cancelar renovação', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Leitor', exact: true }).click();
    await page.getByLabel('Biografia', { exact: true }).fill('Minha biblioteca foi personalizada no navegador.');
    await page.getByRole('button', { name: 'Salvar biografia', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Perfil salvo.');
    await page.reload();
    await expect(page.getByLabel('Biografia', { exact: true })).toHaveValue('Minha biblioteca foi personalizada no navegador.');
    await page.getByLabel('Trocar avatar', { exact: true }).setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: png });
    await expect(page.getByAltText('Seu avatar', { exact: true })).toBeVisible();
    await expect.poll(() => page.getByAltText('Seu avatar', { exact: true }).evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
    await page.goto(shelfUrl);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Excluir estante', exact: true }).click();
    await expect(page).toHaveURL(/\/estantes$/);
    await expect(page.getByRole('heading', { name: 'Coleção editada no navegador' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Sair', exact: true }).click();
    await expect(page).toHaveURL(`${base}/login`);
    await expect(page.getByRole('link', { name: 'Entrar ↗', exact: true })).toBeVisible();
    async function login(email, password) {
      await page.goto(`${base}/login`);
      await page.getByLabel('Email', { exact: true }).fill(email);
      await page.getByLabel('Senha', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Entrar →', exact: true }).click();
      await expect(page).toHaveURL(/\/catalogo$/);
    }
    await login(fixtures.admin.email, fixtures.admin.password);
    await page.getByRole('link', { name: 'Admin', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pessoas e atividade.');
    const metricsRegion = page.getByLabel('Métricas SaaS', { exact: true });
    await expect(metricsRegion).toContainText('PLANO FREE');
    await expect(metricsRegion).toContainText('PLANO PRO');
    await expect(metricsRegion).toContainText('ASSINATURAS ATIVAS');
    await expect(metricsRegion).toContainText('MRR DE TESTE');
    await expect(metricsRegion).toContainText('R$');
    const userPager = page.getByRole('navigation', { name: 'Páginas de usuários', exact: true });
    await expect(userPager.locator('span')).toHaveText('Página 1 de 6');
    for (let value = 2; value <= 6; value++) {
      await userPager.getByRole('button', { name: 'Próxima →', exact: true }).click();
      await expect(userPager.locator('span')).toHaveText(`Página ${value} de 6`);
    }
    await expect(page.getByLabel('Papel de QA Pessoa 101', { exact: true })).toBeVisible();
    await page.goto(`${base}/admin`);
    await expect(page.getByLabel('Papel de admin', { exact: true })).toBeDisabled();
    await page.getByLabel('Papel de Leitor Navegador', { exact: true }).selectOption('curador');
    await expect(page.getByRole('status')).toContainText('Papel atualizado.');
    await page.getByRole('button', { name: 'Atualizar eventos', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'usuario.papel_alterado', exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Sair', exact: true }).click();
    await login('browser@qa.invalid', 'QaPassword123!');
    await page.getByRole('link', { name: 'Curadoria', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Saúde das fontes.');
    await expect(page.getByRole('heading', { name: 'Disponível', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Sair', exact: true }).click();
    await page.getByRole('link', { name: 'Esqueci minha senha', exact: true }).click();
    await expect(page).toHaveURL(`${base}/forgot-password`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Vamos recuperar seu acesso.');
    await page.getByLabel('Email', { exact: true }).fill('browser@qa.invalid');
    await page.getByRole('button', { name: 'Enviar link', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Se o email existir');
    const resetLink = fixtures.resetLinkFor('browser@qa.invalid');
    assert.equal(new URL(resetLink).origin, base);
    await page.goto(resetLink);
    await page.getByLabel('Nova senha', { exact: true }).fill('BrowserNovaSenha123!');
    await page.getByRole('button', { name: 'Redefinir senha', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Senha atualizada com sucesso');
    await login('browser@qa.invalid', 'BrowserNovaSenha123!');
    assert.deepEqual(pageErrors, [], 'Sem erros de JavaScript no fluxo principal');
    console.log('[OK BROWSER] Desktop/mobile, CRUD, leitor e conflitos, listas com 101 registros, cancelamento/reativação, perfil, papéis/admin/curadoria e recuperação.');
  } catch (error) { await page.screenshot({ path: path.join(out, 'mangacloud-browser-falha.png'), fullPage: true }).catch(() => {}); throw error; } finally { await context.close(); await browser.close(); }
};
