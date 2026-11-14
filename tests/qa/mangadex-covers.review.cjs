// Proxy de capas: transporte simulado, sem rede/banco/credenciais.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { createRequire } = require('node:module');
const backend = createRequire(path.resolve(__dirname, '../../backend/package.json'));
backend('tsx/cjs');
const sharp = backend('sharp');
const { MangaDexCovers } = backend('./src/services/mangadexCovers.ts');
const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const url = `https://uploads.mangadex.org/covers/${id}/cover.jpg.256.jpg`;
const manga = { id, provider: 'mangadex', contentRating: 'safe', coverUrl: url };
const image = () => sharp({ create: { width: 20, height: 30, channels: 3, background: '#abc' } }).jpeg().toBuffer();
const jpeg = data => new Response(data, { headers: { 'Content-Type': 'image/jpeg' } });

test('Capas reais usam mesma origem; pedidos concorrentes e posteriores reutilizam bytes', async () => {
  const data = await image();
  let downloads = 0;
  const covers = new MangaDexCovers(async (input, init) => {
    downloads++;
    assert.equal(input, url);
    assert.equal(init.redirect, 'error');
    assert.match(init.headers['User-Agent'], /^MangaCloud/);
    assert.deepEqual(Object.keys(init.headers).sort(), ['Accept', 'User-Agent']);
    return jpeg(data);
  }, () => { throw new Error('A busca de catálogo já forneceu os metadados.'); });
  assert.equal(covers.present(manga).coverUrl, `/api/mangas/mangadex/${id}/capa`);
  assert.equal(manga.coverUrl, url, 'O DTO original do adaptador permanece externo.');
  const demo = { ...manga, provider: 'demo', coverUrl: 'data:image/svg+xml,demo' };
  assert.equal(covers.present(demo), demo);
  const results = await Promise.all([covers.get(id), covers.get(id)]);
  assert.deepEqual(results[0].data, data);
  assert.equal(results[0].mime, 'image/jpeg');
  await covers.get(id);
  assert.equal(downloads, 1);
});

test('Capa acessada sem catálogo consulta a obra safe; mudança da referência invalida cache', async () => {
  const data = await image(), downloads = [];
  let resolutions = 0;
  const covers = new MangaDexCovers(async input => { downloads.push(input); return jpeg(data); }, async () => { resolutions++; return manga; });
  await covers.get(id);
  assert.equal(resolutions, 1);
  const changed = url.replace('cover.jpg', 'new.png');
  covers.present({ ...manga, coverUrl: changed });
  await covers.get(id);
  assert.deepEqual(downloads, [url, changed]);
});

test('IDs, origem, path, credenciais e URLs arbitrárias são recusados antes do download', async () => {
  let downloads = 0;
  const covers = new MangaDexCovers(async () => { downloads++; throw new Error('Sem rede.'); });
  await assert.rejects(covers.get('http://127.0.0.1/secret'), error => error.code === 'INVALID_EXTERNAL_ID');
  for (const forbidden of ['http://127.0.0.1/secret', url.replace('https:', 'http:'), url.replace('uploads.mangadex.org', 'uploads.mangadex.org.evil.test'), url.replace('https://', 'https://user:password@'), url.replace(`/covers/${id}/`, '/covers/other/'), url + '?url=http://localhost', url.replace('cover.jpg', '%2e%2e%2fsecret'), '/relative']) {
    covers.present({ ...manga, coverUrl: forbidden });
    await assert.rejects(covers.get(id), error => error.code === 'EXTERNAL_IMAGE_INVALID');
  }
  assert.equal(downloads, 0);
});

test('Obra restrita, referência de outra obra e ausência de capa não viram proxy aberto', async () => {
  for (const metadata of [{ ...manga, contentRating: 'erotica' }, { ...manga, id: 'wrong' }, { ...manga, provider: 'demo' }, { ...manga, coverUrl: null }]) {
    const covers = new MangaDexCovers(() => { throw new Error('Download proibido'); }, async () => metadata);
    await assert.rejects(covers.get(id), error => [404, 502].includes(error.statusCode));
  }
});

test('HTML, SVG e conteúdo forjado não são enviados como imagem', async () => {
  for (const response of [new Response('<html>challenge</html>', { headers: { 'Content-Type': 'text/html' } }), new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }), jpeg(Buffer.from('<html>not jpeg</html>')), new Response(await image(), { headers: { 'Content-Type': 'image/png' } })]) {
    const covers = new MangaDexCovers(async () => response, async () => manga);
    await assert.rejects(covers.get(id), error => error.code === 'EXTERNAL_IMAGE_INVALID');
  }
});

test('Limite de bytes vale com e sem Content-Length; download excessivo é cancelado', async () => {
  const oversized = new Uint8Array(2 * 1024 * 1024 + 1);
  for (const knownLength of [false, true]) {
    let canceled = false;
    const stream = new ReadableStream({ start(controller) { controller.enqueue(oversized); }, cancel() { canceled = true; } });
    const covers = new MangaDexCovers(async () => new Response(stream, { headers: { 'Content-Type': 'image/jpeg', ...(knownLength ? { 'Content-Length': String(oversized.length) } : {}) } }), async () => manga);
    await assert.rejects(covers.get(id), error => error.code === 'EXTERNAL_IMAGE_INVALID');
    assert.equal(canceled, true);
  }
});

test('404, 429, erro e redirect da fonte falham sem cachear a resposta; retry funciona', async () => {
  for (const [status, code] of [[404, 'EXTERNAL_RESOURCE_NOT_FOUND'], [429, 'EXTERNAL_RATE_LIMIT'], [403, 'EXTERNAL_PROVIDER_ERROR'], [302, 'EXTERNAL_PROVIDER_ERROR']]) {
    let attempts = 0;
    const data = await image();
    const covers = new MangaDexCovers(async () => ++attempts === 1 ? new Response('failed', { status, headers: { 'Retry-After': '3' } }) : jpeg(data), async () => manga);
    await assert.rejects(covers.get(id), error => error.code === code && (status !== 429 || error.retryAfterSeconds === 3));
    assert.deepEqual((await covers.get(id)).data, data);
    assert.equal(attempts, 2);
  }
});
