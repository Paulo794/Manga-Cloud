const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const frontend = createRequire(path.resolve(__dirname, '../../frontend/package.json'));
const { expect } = frontend('@playwright/test');

module.exports = async function reviewPagination(page, base, prepare) {
  const file = path.resolve(__dirname, '../../docs/qa/evidencias/pagination-review.json');
  const report = { checkedAt: new Date().toISOString(), status: 'EM_EXECUCAO', mode: 'isolated-db-with-101-records', checks: [] };
  const save = () => fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  save();
  const fixture = await prepare();
  async function lastPage(label) {
    const pager = page.getByRole('navigation', { name: label, exact: true });
    await expect(pager.locator('span')).toHaveText('Página 1 de 6');
    for (let next = 2; next <= 6; next++) {
      await pager.getByRole('button', { name: 'Próxima →', exact: true }).click();
      await expect(pager.locator('span')).toHaveText(`Página ${next} de 6`);
    }
    await expect(pager.getByRole('button', { name: 'Próxima →', exact: true })).toBeDisabled();
    return pager;
  }
  try {
    await page.goto(`${base}/estantes`);
    await lastPage('Páginas de estantes');
    await expect(page.locator(`a[href="/estantes/${fixture.shelfId}"]`)).toBeVisible();
    report.checks.push('all-shelves-accessible-beyond-100'); save();
    await page.goto(`${base}/mangas/demo/demo-alquimia-astral`);
    await lastPage('Páginas de estantes de destino');
    await page.getByLabel('Estante de destino', { exact: true }).selectOption(String(fixture.shelfId));
    await page.getByRole('button', { name: 'Adicionar à estante', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Obra adicionada à estante.');
    await page.getByRole('button', { name: '♡ Favoritar', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Adicionado aos favoritos.');
    report.checks.push('destination-shelf-selectable-beyond-100'); save();
    await page.goto(`${base}/estantes/${fixture.shelfId}`);
    await lastPage('Páginas de obras da estante');
    await expect(page.locator('.reference-list article')).toHaveCount(2);
    report.checks.push('all-shelf-items-accessible-beyond-100'); save();
    await page.goto(`${base}/favoritos`);
    await lastPage('Páginas de favoritos');
    assert.ok(await page.locator('.manga-grid article').count() > 0);
    await page.getByRole('link', { name: 'Histórico', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Páginas do histórico' }).locator('span')).toHaveText('Página 1 de 6');
    await lastPage('Páginas do histórico');
    assert.ok(await page.locator('.manga-grid article').count() > 0);
    report.checks.push('favorites-history-paginate-and-reset-on-navigation');
    report.status = 'APROVADO';
  } catch (error) { report.status = 'FALHOU'; report.failure = error.message; throw error; }
  finally { save(); }
};
