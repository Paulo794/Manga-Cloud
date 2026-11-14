// Prova técnica GET da API real. --public-dns é temporário e exclusivo deste processo.
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const backend = createRequire(path.resolve(__dirname, '../../backend/package.json'));
const args = process.argv.slice(2);
if (args.some(argument => argument !== '--public-dns')) throw new Error('Use somente a opção --public-dns, quando desejada.');
const network = args.includes('--public-dns') ? require('../../tests/qa/public-dns.fixture.cjs')() : null;
backend('tsx/cjs');
const { runLiveMangadexIntegrationCheck } = backend('./src/providers/verifyPhase1.ts');
(async () => {
  try {
    console.log(`[QA LIVE] Resolução: ${network ? 'DNS público temporário, somente neste processo' : 'DNS normal do sistema'}.`);
    const result = await runLiveMangadexIntegrationCheck();
    const report = { checkedAt: new Date().toISOString(), mode: network ? 'temporary-public-dns' : 'system-dns', ...result, dnsMappings: network?.mappings() || {} };
    const folder = path.resolve(__dirname, '../../docs/qa/evidencias'); fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, network ? 'mangadex-live-public-dns.json' : 'mangadex-live-system-dns.json'), JSON.stringify(report, null, 2) + '\n');
    if (result.status !== 'APROVADO') process.exitCode = 1;
  } finally { network?.restore(); }
})().catch(error => { console.error('[QA LIVE]', error.message); process.exitCode = 1; });
