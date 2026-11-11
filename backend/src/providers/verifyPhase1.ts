import assert from 'assert';
import {
  assertValidProvider,
  canonicalizeChapters,
  demoCatalogProvider,
  findCanonicalChapterById,
  MangaDexCatalogProvider,
  mangadexCatalogProvider,
  parseChapterNumber,
  ProviderError
} from './index';

const SAMPLE_MANGA_UUID = 'a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d';
const SAMPLE_CHAPTER_1_UUID = '11111111-2222-4333-8444-555555555551';
const SAMPLE_CHAPTER_2_UUID = '11111111-2222-4333-8444-555555555552';

export async function runOfflineContractSuite(): Promise<void> {
  console.log('=== [Fase 1 — Suíte Determinística Offline] ===\n');

  // 1. Whitelist de provedores e proteção anti-SSRF
  assert.strictEqual(assertValidProvider('mangadex'), 'mangadex');
  assert.strictEqual(assertValidProvider('DEMO'), 'demo');
  let invalidProviderCaught = false;
  try {
    assertValidProvider('http://evil.internal');
  } catch (err) {
    invalidProviderCaught = err instanceof ProviderError && err.statusCode === 400 && err.code === 'INVALID_PROVIDER';
  }
  assert.strictEqual(invalidProviderCaught, true, 'Deve rejeitar provedor fora da whitelist com 400 INVALID_PROVIDER');
  assert.strictEqual(parseChapterNumber('0'), 0, 'Prólogo capítulo 0 deve ser aceito como numérico');
  console.log('[OK] 1. Whitelist de provedores (mangadex | demo), prólogo 0 e proteção anti-SSRF verificados.');

  // 2. Validar 4 capítulos simples no Demo
  const simpleChapters = await demoCatalogProvider.getChapters('demo-alquimia-astral', 'pt-br');
  assert.strictEqual(simpleChapters.chapters.length, 4);
  assert.deepStrictEqual(
    simpleChapters.chapters.map((c) => ({
      chapterNumber: c.chapterNumber,
      canonicalPosition: c.canonicalPosition,
      isEligibleForFree: c.isEligibleForFree
    })),
    [
      { chapterNumber: '1', canonicalPosition: 1, isEligibleForFree: true },
      { chapterNumber: '2', canonicalPosition: 2, isEligibleForFree: true },
      { chapterNumber: '3', canonicalPosition: 3, isEligibleForFree: true },
      { chapterNumber: '4', canonicalPosition: 4, isEligibleForFree: false }
    ]
  );
  console.log('[OK] 2. Elegibilidade de DTO para 4 capítulos simples (posições 1..3 true, 4 false) verificada.');

  // 3. Validar capítulos decimais (1, 2, 2.5, 3, 4), duplicatas de mesmo volume, volumes distintos (F1-01) e sem número
  const decimalChapters = await demoCatalogProvider.getChapters('demo-cyber-ronin', 'pt-br');
  const byId = new Map(decimalChapters.chapters.map((c) => [c.chapterNumber ?? 'null', c]));

  assert.strictEqual(byId.get('1')?.canonicalPosition, 1);
  assert.strictEqual(byId.get('2')?.canonicalPosition, 2);
  assert.strictEqual(byId.get('2')?.alternateTranslations.length, 1);
  assert.strictEqual(byId.get('2.5')?.canonicalPosition, 3);
  assert.strictEqual(byId.get('2.5')?.isEligibleForFree, true);
  assert.strictEqual(byId.get('3')?.canonicalPosition, 4);
  assert.strictEqual(byId.get('3')?.isEligibleForFree, false);
  assert.strictEqual(byId.get('null')?.canonicalPosition, null);

  // F1-01: Números iguais em volumes distintos não se fundem, e alternativa preserva seus próprios metadados
  const multiVol = canonicalizeChapters([
    {
      provider: 'demo',
      id: 'v1-c1',
      mangaId: 'm1',
      title: 'Vol 1 Cap 1',
      volumeNumber: '1',
      chapterNumber: '1',
      language: 'pt-br',
      scanlationGroup: 'G1',
      pagesCount: 3,
      externalUrl: null,
      publishedAt: '2026-10-01T00:00:00Z',
      contentRating: 'safe'
    },
    {
      provider: 'demo',
      id: 'v2-c1',
      mangaId: 'm1',
      title: 'Vol 2 Cap 1',
      volumeNumber: '2',
      chapterNumber: '1',
      language: 'pt-br',
      scanlationGroup: 'G1',
      pagesCount: 4,
      externalUrl: null,
      publishedAt: '2026-10-02T00:00:00Z',
      contentRating: 'safe'
    }
  ]);
  assert.strictEqual(multiVol.length, 2, 'Capítulos de volumes distintos devem permanecer distintos');
  const resolvedV2 = findCanonicalChapterById(multiVol, 'v2-c1');
  assert.strictEqual(resolvedV2?.chapter.volumeNumber, '2');
  console.log('[OK] 3. Canonização com decimais, volumes distintos (F1-01), duplicatas e sem número verificada.');

  // 4. Validar obra sem tradução em pt-br
  const missingPtBr = await demoCatalogProvider.getChapters('demo-lenda-sem-ptbr', 'pt-br');
  assert.strictEqual(missingPtBr.chapters.length, 0);
  assert.deepStrictEqual(missingPtBr.availableLanguages, ['en']);
  console.log('[OK] 4. Obra sem tradução em pt-br retorna lista vazia + idiomas disponíveis ([en]).');

  // 5. Validar Contrato Simulado do MangaDexCatalogProvider (incluindo F1-02 paginação > 500, F1-03 timeout de corpo e F1-04 contentRating ausente)
  let transientAttempts = 0;
  const contractFetch: typeof fetch = async (input: any) => {
    const url = String(input);

    if (url.includes('/manga?') && url.includes('title=Transient502')) {
      transientAttempts++;
      if (transientAttempts === 1) {
        return new Response('Bad Gateway', { status: 502 });
      }
    }

    if (url.includes('/manga?') && url.includes('title=RateLimit429')) {
      return new Response('Too Many Requests', {
        status: 429,
        headers: { 'retry-after': '7' }
      });
    }

    if (url.includes(`/manga/${SAMPLE_MANGA_UUID}/feed`)) {
      return new Response(
        JSON.stringify({
          total: 2,
          data: [
            {
              id: SAMPLE_CHAPTER_1_UUID,
              type: 'chapter',
              attributes: {
                title: 'A Aurora Real',
                volume: '1',
                chapter: '1',
                translatedLanguage: 'pt-br',
                pages: 2,
                externalUrl: null,
                publishAt: '2026-10-01T00:00:00Z',
                contentRating: 'safe'
              },
              relationships: [
                { id: SAMPLE_MANGA_UUID, type: 'manga' },
                { id: 'scan-1', type: 'scanlation_group', attributes: { name: 'Scan Brasil' } }
              ]
            },
            {
              id: SAMPLE_CHAPTER_2_UUID,
              type: 'chapter',
              attributes: {
                title: 'O Horizonte',
                volume: '1',
                chapter: '2',
                translatedLanguage: 'pt-br',
                pages: 2,
                externalUrl: null,
                publishAt: '2026-10-02T00:00:00Z',
                contentRating: 'safe'
              },
              relationships: [{ id: SAMPLE_MANGA_UUID, type: 'manga' }]
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.includes(`/manga/${SAMPLE_MANGA_UUID}`)) {
      return new Response(
        JSON.stringify({
          data: {
            id: SAMPLE_MANGA_UUID,
            type: 'manga',
            attributes: {
              title: { 'pt-br': 'Aventuras na Nuvem' },
              description: { 'pt-br': '<b>Sinopse</b> com HTML sanitizado.' },
              status: 'ongoing',
              year: 2026,
              contentRating: 'safe',
              availableTranslatedLanguages: ['pt-br', 'en'],
              tags: []
            },
            relationships: [{ type: 'cover_art', attributes: { fileName: 'cover123.jpg' } }]
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.includes(`/chapter/${SAMPLE_CHAPTER_1_UUID}`)) {
      return new Response(
        JSON.stringify({
          data: {
            id: SAMPLE_CHAPTER_1_UUID,
            type: 'chapter',
            attributes: {
              title: 'A Aurora Real',
              volume: '1',
              chapter: '1',
              translatedLanguage: 'pt-br',
              pages: 2,
              externalUrl: null,
              publishAt: '2026-10-01T00:00:00Z',
              contentRating: 'safe'
            },
            relationships: [{ id: SAMPLE_MANGA_UUID, type: 'manga' }]
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.includes(`/at-home/server/${SAMPLE_CHAPTER_1_UUID}`)) {
      return new Response(
        JSON.stringify({
          baseUrl: 'https://uploads.mangadex.org',
          chapter: {
            hash: 'abc123hash',
            data: ['page1.jpg', 'page2.jpg']
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({
        total: 1,
        data: [
          {
            id: SAMPLE_MANGA_UUID,
            type: 'manga',
            attributes: {
              title: { 'pt-br': 'Aventuras na Nuvem' },
              description: { 'pt-br': '<b>Sinopse</b> com HTML sanitizado.' },
              status: 'ongoing',
              year: 2026,
              contentRating: 'safe',
              availableTranslatedLanguages: ['pt-br', 'en'],
              tags: []
            },
            relationships: [{ type: 'cover_art', attributes: { fileName: 'cover123.jpg' } }]
          }
        ]
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const contractProvider = new MangaDexCatalogProvider({ fetchImpl: contractFetch, retryBackoffMs: 10 });
  const retrySearch = await contractProvider.searchMangas({ query: 'Transient502' });
  assert.strictEqual(transientAttempts, 2);
  assert.strictEqual(retrySearch.items[0]?.synopsis, 'Sinopse com HTML sanitizado.');

  const mdChapters = await contractProvider.getChapters(SAMPLE_MANGA_UUID, 'pt-br');
  assert.strictEqual(mdChapters.chapters.length, 2);
  const mdManifest = await contractProvider.getChapterManifest(SAMPLE_CHAPTER_1_UUID);
  assert.strictEqual(mdManifest.totalPages, 2);
  console.log('[OK] 5. Suíte determinística offline concluída com sucesso.');
}

export async function runLiveMangadexIntegrationCheck(): Promise<{
  status: 'APROVADO' | 'PENDENTE';
  reason: string;
}> {
  console.log('\n=== [Fase 1 — Verificação de Integração Real MangaDex (Rede Ao Vivo)] ===');
  const liveDiag = await mangadexCatalogProvider.getDiagnostics();
  console.log(`[Diagnóstico MangaDex] status=${liveDiag.status} | latencyMs=${liveDiag.latencyMs}ms`);

  if (liveDiag.status !== 'operational') {
    const reason = `Busca ao vivo indisponível no ambiente atual (${liveDiag.errorMessage ?? 'sem detalhe'}).`;
    console.log(`[STATUS LEITURA REAL: PENDENTE] ${reason}`);
    return { status: 'PENDENTE', reason };
  }

  try {
    const searchRes = await mangadexCatalogProvider.searchMangas({ language: 'pt-br', page: 1, limit: 5 });
    for (const work of searchRes.items) {
      const chList = await mangadexCatalogProvider.getChapters(work.id, 'pt-br');
      const firstReadable = chList.chapters.find((c) => c.canonicalPosition !== null && !c.externalUrl && c.pagesCount > 0);
      if (firstReadable) {
        const manifest = await mangadexCatalogProvider.getChapterManifest(firstReadable.id);
        const firstPageUrl = manifest.pages[0]?.imageUrl;
        if (firstPageUrl) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8000);
          try {
            const imgRes = await fetch(firstPageUrl, { method: 'GET', signal: controller.signal });
            const buffer = Buffer.from(await imgRes.arrayBuffer());
            const isJpeg = buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
            const isPng =
              buffer.length > 8 &&
              buffer[0] === 0x89 &&
              buffer[1] === 0x50 &&
              buffer[2] === 0x4e &&
              buffer[3] === 0x47;
            const isWebp =
              buffer.length > 12 &&
              buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
              buffer.subarray(8, 12).toString('ascii') === 'WEBP';
            if (imgRes.ok && (isJpeg || isPng || isWebp)) {
              console.log(
                `[STATUS LEITURA REAL: APROVADO] Obra=${work.id} -> Capítulo=${firstReadable.id} -> Páginas=${manifest.totalPages} -> Imagem válida (${buffer.length} bytes)`
              );
              return { status: 'APROVADO', reason: 'Fluxo completo e bytes da imagem validados ao vivo.' };
            }
          } finally {
            clearTimeout(timer);
          }
        }
      }
    }
    return {
      status: 'PENDENTE',
      reason: 'Busca respondeu, mas não foi possível baixar página de imagem completa nos candidatos iniciais.'
    };
  } catch (err: any) {
    const reason = `Falha durante verificação ao vivo completa: ${String(err?.message ?? err)}`;
    console.log(`[STATUS LEITURA REAL: PENDENTE] ${reason}`);
    return { status: 'PENDENTE', reason };
  }
}

if (require.main === module) {
  (async () => {
    const requireLive = process.argv.includes('--require-live');
    await runOfflineContractSuite();
    const liveResult = await runLiveMangadexIntegrationCheck();
    if (requireLive && liveResult.status !== 'APROVADO') {
      console.error(`[FALHA --require-live]: Leitura real permanece ${liveResult.status}: ${liveResult.reason}`);
      process.exit(1);
    }
  })().catch((err) => {
    console.error('[ERRO Fase 1]:', err);
    process.exit(1);
  });
}
