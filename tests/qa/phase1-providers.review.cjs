// Regressões independentes da revisão QA da Fase 1.
// Executar da raiz: node tests/qa/phase1-providers.review.cjs
// Não acessa rede/banco. Falhas indicam comportamentos ainda incorretos.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRequire } = require('node:module');
const path = require('node:path');
const backendRequire = createRequire(path.resolve(__dirname, '../../backend/package.json'));
backendRequire('tsx/cjs');
const { canonicalizeChapters, findCanonicalChapterById } = backendRequire('./src/providers/canonicalize.ts');
const { MangaDexCatalogProvider } = backendRequire('./src/providers/mangadexProvider.ts');

const mangaId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const manga = {
  id: mangaId,
  type: 'manga',
  attributes: { title: { en: 'QA' }, contentRating: 'safe', availableTranslatedLanguages: ['pt-br'] },
  relationships: []
};

function chapter(id, number, volume = '1') {
  return {
    provider: 'demo', id, mangaId, title: id,
    volumeNumber: volume, chapterNumber: number, language: 'pt-br',
    scanlationGroup: 'QA', pagesCount: 2, externalUrl: null,
    publishedAt: '2026-11-11T00:00:00Z', contentRating: 'safe'
  };
}

test('F1-01: números iguais em volumes distintos não são traduções alternativas', () => {
  const chapters = canonicalizeChapters([
    chapter('v1-c1', '1'), chapter('v1-c2', '2'),
    chapter('v1-c3', '3'), chapter('v2-c1', '1', '2')
  ]);
  assert.equal(chapters.length, 4, 'Os quatro capítulos distintos devem permanecer distintos');
  const first = findCanonicalChapterById(chapters, 'v1-c1');
  const otherVolume = findCanonicalChapterById(chapters, 'v2-c1');
  assert.ok(first && otherVolume);
  assert.notEqual(first.chapter.canonicalPosition, otherVolume.chapter.canonicalPosition);
  assert.equal(otherVolume.chapter.volumeNumber, '2');
});

test('F1-07: misturar volumes conhecidos e desconhecidos mantém ordem e elegibilidade determinísticas', () => {
  const input = [
    chapter('A', '10', '1'), chapter('B', '1', '2'),
    chapter('C', '5', null), chapter('D', '2', '2')
  ];
  function permutations(items) {
    return items.length === 0 ? [[]] : items.flatMap((item, index) =>
      permutations(items.filter((_, otherIndex) => index !== otherIndex)).map(rest => [item, ...rest])
    );
  }
  const variants = permutations(input).map(items => canonicalizeChapters(items).map(item => ({
    id: item.id, position: item.canonicalPosition, free: item.isEligibleForFree
  })));
  for (const variant of variants) {
    assert.deepEqual(variant, variants[0], 'Mesmos capítulos não podem mudar de ordem ou de plano pela ordem do feed');
  }
});

test('F1-02: paginação completa inclui o registro 501', async () => {
  const provider = new MangaDexCatalogProvider({ fetchImpl: async (input) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/feed')) return new Response(JSON.stringify({ data: manga }));
    const offset = Number(url.searchParams.get('offset'));
    const data = Array.from({ length: Math.max(0, Math.min(100, 501 - offset)) }, (_, index) => ({
      id: `chapter-${offset + index + 1}`,
      attributes: { chapter: String(offset + index + 1), volume: '1', translatedLanguage: 'pt-br', pages: 2 },
      relationships: [{ type: 'manga', id: mangaId }]
    }));
    return new Response(JSON.stringify({ data, total: 501 }));
  } });
  const result = await provider.getChapters(mangaId, 'pt-br');
  assert.equal(result.chapters.length, 501, 'O adaptador não deve devolver lista incompleta como completa');
});

test('F1-04: classificação ausente não pode virar safe', async () => {
  const unknown = { ...manga, attributes: { title: { en: 'Classificação desconhecida' } } };
  const provider = new MangaDexCatalogProvider({
    fetchImpl: async () => new Response(JSON.stringify({ data: unknown }))
  });
  await assert.rejects(() => provider.getMangaById(mangaId), 'Obra sem classificação deve ser recusada');
});

test('F1-03: timeout permanece ativo enquanto o corpo é consumido', async () => {
  // Reduz apenas o timer de 8s para 10ms; corpo leva 40ms.
  // O transporte simulado respeita abort durante a leitura do corpo.
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (fn, delay, ...args) => originalSetTimeout(fn, delay === 8000 ? 10 : delay, ...args);
  try {
    const provider = new MangaDexCatalogProvider({ retryBackoffMs: 1, fetchImpl: async (_input, init) => ({
      status: 200, ok: true, headers: new Headers(),
      json: () => new Promise((resolve, reject) => {
        const timer = originalSetTimeout(() => resolve({ data: manga }), 40);
        init.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      })
    }) });
    await assert.rejects(
      () => provider.getMangaById(mangaId),
      (error) => error.code === 'EXTERNAL_PROVIDER_TIMEOUT'
    );
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});
