import { canonicalizeChapters, findCanonicalChapterById } from './canonicalize';
import {
  CatalogProvider,
  CanonicalChapterDto,
  ChapterManifestDto,
  MangaDetailDto,
  MangaSummaryDto,
  MangaTagDto,
  PaginatedResult,
  ProviderDiagnosticsDto,
  ProviderError,
  RawChapterDto,
  SearchMangasParams
} from './types';

const DEMO_TAGS: MangaTagDto[] = [
  { id: 'tag-shounen', name: 'Shounen', group: 'genre' },
  { id: 'tag-scifi', name: 'Sci-Fi', group: 'genre' },
  { id: 'tag-fantasia', name: 'Fantasia', group: 'genre' },
  { id: 'tag-acao', name: 'Ação', group: 'genre' },
  { id: 'tag-aventura', name: 'Aventura', group: 'genre' },
  { id: 'tag-misterio', name: 'Mistério', group: 'theme' }
];

function buildDemoCoverDataUri(title: string, subtitle: string, bgStart: string, bgEnd: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="680" viewBox="0 0 480 680">
    <defs>
      <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="${bgStart}" />
        <stop offset="100%" stop-color="${bgEnd}" />
      </linearGradient>
    </defs>
    <rect width="480" height="680" fill="url(#g)" rx="16" />
    <rect x="24" y="24" width="432" height="632" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="3" rx="12" />
    <text x="44" y="72" fill="#fde047" font-family="sans-serif" font-size="16" font-weight="bold" letter-spacing="2">MANGACLOUD DEMO EDITION</text>
    <text x="44" y="310" fill="#ffffff" font-family="sans-serif" font-size="36" font-weight="bold">${title}</text>
    <text x="44" y="355" fill="#e2e8f0" font-family="sans-serif" font-size="20">${subtitle}</text>
    <rect x="44" y="560" width="210" height="40" rx="8" fill="rgba(15,23,42,0.75)" />
    <text x="62" y="586" fill="#38bdf8" font-family="sans-serif" font-size="15" font-weight="bold">CONTEÚDO SINTÉTICO</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function buildDemoPageDataUri(params: {
  workTitle: string;
  chapterLabel: string;
  pageNumber: number;
  totalPages: number;
  language: string;
}): string {
  const { workTitle, chapterLabel, pageNumber, totalPages, language } = params;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1280" viewBox="0 0 900 1280">
    <rect width="900" height="1280" fill="#0f172a" />
    <rect x="40" y="40" width="820" height="1200" fill="#f8fafc" stroke="#1e293b" stroke-width="6" rx="8" />
    <rect x="70" y="70" width="760" height="340" fill="#e2e8f0" stroke="#0f172a" stroke-width="4" />
    <text x="100" y="135" fill="#0f172a" font-family="sans-serif" font-size="30" font-weight="bold">${workTitle}</text>
    <text x="100" y="185" fill="#334155" font-family="sans-serif" font-size="24">${chapterLabel} • Idioma: ${language.toUpperCase()}</text>
    <text x="100" y="250" fill="#0f172a" font-family="sans-serif" font-size="20">"O portal da biblioteca dimensional abriu na página ${pageNumber}!"</text>
    <rect x="70" y="440" width="365" height="360" fill="#cbd5e1" stroke="#0f172a" stroke-width="4" />
    <text x="95" y="620" fill="#1e293b" font-family="sans-serif" font-size="22" font-weight="bold">Quadro A — Cena ${pageNumber}.1</text>
    <rect x="465" y="440" width="365" height="360" fill="#dbeafe" stroke="#0f172a" stroke-width="4" />
    <text x="490" y="620" fill="#1e3a8a" font-family="sans-serif" font-size="22" font-weight="bold">Quadro B — Cena ${pageNumber}.2</text>
    <rect x="70" y="830" width="760" height="290" fill="#fef3c7" stroke="#0f172a" stroke-width="4" />
    <text x="100" y="960" fill="#78350f" font-family="sans-serif" font-size="26" font-weight="bold">Clímax da Página ${pageNumber} de ${totalPages}</text>
    <text x="100" y="1010" fill="#92400e" font-family="sans-serif" font-size="18">Fixture autoral sintética para validação de Web Reader, Paywall e Progresso</text>
    <text x="450" y="1195" text-anchor="middle" fill="#475569" font-family="sans-serif" font-size="22" font-weight="bold">Página ${pageNumber} / ${totalPages} — MangaCloud Demo</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const DEMO_WORKS: MangaDetailDto[] = [
  {
    provider: 'demo',
    id: 'demo-alquimia-astral',
    title: 'Crônicas da Alquimia Astral',
    synopsis:
      'Obra sintética de demonstração com 4 capítulos sequenciais simples (1, 2, 3 e 4) em pt-br e en. Ideal para validar a regra básica do Paywall: capítulos 1 a 3 liberados no plano Free e capítulo 4 exclusivo do plano Leitor Pro.',
    coverUrl: buildDemoCoverDataUri('Alquimia Astral', '4 Capítulos Sequenciais (1 a 4)', '#1e3a8a', '#7c3aed'),
    status: 'ongoing',
    year: 2026,
    contentRating: 'safe',
    tags: [DEMO_TAGS[0]!, DEMO_TAGS[2]!, DEMO_TAGS[4]!],
    availableLanguages: ['pt-br', 'en'],
    authors: ['Estúdio Sintético MangaCloud'],
    updatedAt: '2026-11-10T12:00:00.000Z',
    isDemo: true
  },
  {
    provider: 'demo',
    id: 'demo-cyber-ronin',
    title: 'Cyber Ronin: Protocolo Neo-Tokyo',
    synopsis:
      'Obra sintética de demonstração contendo numeração decimal (1, 2, 2.5, 3 e 4), traduções duplicadas no capítulo 2 e capítulo extra sem número. Demonstra que as 3 primeiras posições canônicas são 1, 2 e 2.5 (bloqueando o capítulo 3 por ocupar a 4ª posição canônica).',
    coverUrl: buildDemoCoverDataUri('Cyber Ronin', 'Capítulos Decimais (1, 2, 2.5, 3, 4)', '#0f766e', '#1e293b'),
    status: 'ongoing',
    year: 2026,
    contentRating: 'safe',
    tags: [DEMO_TAGS[0]!, DEMO_TAGS[1]!, DEMO_TAGS[3]!],
    availableLanguages: ['pt-br', 'en'],
    authors: ['Laboratório QA MangaCloud'],
    updatedAt: '2026-11-11T08:00:00.000Z',
    isDemo: true
  },
  {
    provider: 'demo',
    id: 'demo-lenda-sem-ptbr',
    title: 'Whisper of the Silent Star (EN Only)',
    synopsis:
      'Obra sintética publicada exclusivamente em inglês (en), sem capítulos em pt-br, para validar o estado de ausência de tradução no idioma padrão e a troca explícita de idioma pelo leitor.',
    coverUrl: buildDemoCoverDataUri('Silent Star', 'Disponível apenas em Inglês (EN)', '#9d174d', '#31102f'),
    status: 'completed',
    year: 2025,
    contentRating: 'safe',
    tags: [DEMO_TAGS[1]!, DEMO_TAGS[5]!],
    availableLanguages: ['en'],
    authors: [' Equipe Internacional Demo'],
    updatedAt: '2026-10-20T15:00:00.000Z',
    isDemo: true
  }
];

const DEMO_RAW_CHAPTERS: RawChapterDto[] = [
  // 1) demo-alquimia-astral (pt-br): capítulos 1, 2, 3, 4 simples
  {
    provider: 'demo',
    id: 'demo-aa-pt-cap-1',
    mangaId: 'demo-alquimia-astral',
    title: 'O Despertar do Astrolábio',
    volumeNumber: '1',
    chapterNumber: '1',
    language: 'pt-br',
    scanlationGroup: 'MangaCloud Originals BR',
    pagesCount: 4,
    externalUrl: null,
    publishedAt: '2026-10-01T10:00:00.000Z',
    contentRating: 'safe'
  },
  {
    provider: 'demo',
    id: 'demo-aa-pt-cap-2',
    mangaId: 'demo-alquimia-astral',
    title: 'A Biblioteca Submersa',
    volumeNumber: '1',
    chapterNumber: '2',
    language: 'pt-br',
    scanlationGroup: 'MangaCloud Originals BR',
    pagesCount: 4,
    externalUrl: null,
    publishedAt: '2026-10-08T10:00:00.000Z',
    contentRating: 'safe'
  },
  {
    provider: 'demo',
    id: 'demo-aa-pt-cap-3',
    mangaId: 'demo-alquimia-astral',
    title: 'O Pacto das Três Luas',
    volumeNumber: '1',
    chapterNumber: '3',
    language: 'pt-br',
    scanlationGroup: 'MangaCloud Originals BR',
    pagesCount: 4,
    externalUrl: null,
    publishedAt: '2026-10-15T10:00:00.000Z',
    contentRating: 'safe'
  },
  {
    provider: 'demo',
    id: 'demo-aa-pt-cap-4',
    mangaId: 'demo-alquimia-astral',
    title: 'Além do Portão Proibido (Exclusivo Pro)',
    volumeNumber: '1',
    chapterNumber: '4',
    language: 'pt-br',
    scanlationGroup: 'MangaCloud Originals BR',
    pagesCount: 5,
    externalUrl: null,
    publishedAt: '2026-10-22T10:00:00.000Z',
    contentRating: 'safe'
  },
  // demo-alquimia-astral (en)
  {
    provider: 'demo',
    id: 'demo-aa-en-cap-1',
    mangaId: 'demo-alquimia-astral',
    title: 'Awakening of the Astrolabe',
    volumeNumber: '1',
    chapterNumber: '1',
    language: 'en',
    scanlationGroup: 'MangaCloud Originals EN',
    pagesCount: 4,
    externalUrl: null,
    publishedAt: '2026-10-01T10:00:00.000Z',
    contentRating: 'safe'
  },
  {
    provider: 'demo',
    id: 'demo-aa-en-cap-2',
    mangaId: 'demo-alquimia-astral',
    title: 'The Sunken Library',
    volumeNumber: '1',
    chapterNumber: '2',
    language: 'en',
    scanlationGroup: 'MangaCloud Originals EN',
    pagesCount: 4,
    externalUrl: null,
    publishedAt: '2026-10-08T10:00:00.000Z',
    contentRating: 'safe'
  },
  {
    provider: 'demo',
    id: 'demo-aa-en-cap-3',
    mangaId: 'demo-alquimia-astral',
    title: 'Covenant of Three Moons',
    volumeNumber: '1',
    chapterNumber: '3',
    language: 'en',
    scanlationGroup: 'MangaCloud Originals EN',
    pagesCount: 4,
    externalUrl: null,
    publishedAt: '2026-10-15T10:00:00.000Z',
    contentRating: 'safe'
  },
  {
    provider: 'demo',
    id: 'demo-aa-en-cap-4',
    mangaId: 'demo-alquimia-astral',
    title: 'Beyond the Forbidden Gate (Pro)',
    volumeNumber: '1',
    chapterNumber: '4',
    language: 'en',
    scanlationGroup: 'MangaCloud Originals EN',
    pagesCount: 5,
    externalUrl: null,
    publishedAt: '2026-10-22T10:00:00.000Z',
    contentRating: 'safe'
  },

  // 2) demo-cyber-ronin (pt-br): capítulos 1, 2 (duplicado), 2.5, 3 (4ª pos. canônica -> Pro!), 4 + extra sem número
  {
    provider: 'demo',
    id: 'demo-cr-pt-cap-1',
    mangaId: 'demo-cyber-ronin',
    title: 'Lâmina de Silício',
    volumeNumber: '1',
    chapterNumber: '1',
    language: 'pt-br',
    scanlationGroup: 'NeoScan BR',
    pagesCount: 4,
    externalUrl: null,
    publishedAt: '2026-09-10T10:00:00.000Z',
    contentRating: 'safe'
  },
  {
    provider: 'demo',
    id: 'demo-cr-pt-cap-2-a',
    mangaId: 'demo-cyber-ronin',
    title: 'Chuva de Neon (Versão A)',
    volumeNumber: '1',
    chapterNumber: '2',
    language: 'pt-br',
    scanlationGroup: 'NeoScan BR',
    pagesCount: 4,
    externalUrl: null,
    publishedAt: '2026-09-25T10:00:00.000Z',
    contentRating: 'safe'
  },
  {
    provider: 'demo',
    id: 'demo-cr-pt-cap-2-b',
    mangaId: 'demo-cyber-ronin',
    title: 'Chuva de Neon (Versão Alternativa B)',
    volumeNumber: '1',
    chapterNumber: '2',
    language: 'pt-br',
    scanlationGroup: 'Cyber Traduções',
    pagesCount: 4,
    externalUrl: null,
    publishedAt: '2026-09-12T10:00:00.000Z',
    contentRating: 'safe'
  },
  {
    provider: 'demo',
    id: 'demo-cr-pt-cap-2-5',
    mangaId: 'demo-cyber-ronin',
    title: 'Interlúdio 2.5: Memória Fragmentada',
    volumeNumber: '1',
    chapterNumber: '2.5',
    language: 'pt-br',
    scanlationGroup: 'NeoScan BR',
    pagesCount: 3,
    externalUrl: null,
    publishedAt: '2026-09-20T10:00:00.000Z',
    contentRating: 'safe'
  },
  {
    provider: 'demo',
    id: 'demo-cr-pt-cap-3',
    mangaId: 'demo-cyber-ronin',
    title: 'Invasão à Torre Central (4ª Posição Canônica — Pro)',
    volumeNumber: '2',
    chapterNumber: '3',
    language: 'pt-br',
    scanlationGroup: 'NeoScan BR',
    pagesCount: 5,
    externalUrl: null,
    publishedAt: '2026-09-28T10:00:00.000Z',
    contentRating: 'safe'
  },
  {
    provider: 'demo',
    id: 'demo-cr-pt-cap-4',
    mangaId: 'demo-cyber-ronin',
    title: 'Confronto no Núcleo (5ª Posição Canônica — Pro)',
    volumeNumber: '2',
    chapterNumber: '4',
    language: 'pt-br',
    scanlationGroup: 'NeoScan BR',
    pagesCount: 5,
    externalUrl: null,
    publishedAt: '2026-10-05T10:00:00.000Z',
    contentRating: 'safe'
  },
  {
    provider: 'demo',
    id: 'demo-cr-pt-oneshot-sem-numero',
    mangaId: 'demo-cyber-ronin',
    title: 'Especial de Bastidores (Sem Número Canônico)',
    volumeNumber: null,
    chapterNumber: null,
    language: 'pt-br',
    scanlationGroup: 'NeoScan BR',
    pagesCount: 2,
    externalUrl: null,
    publishedAt: '2026-10-06T10:00:00.000Z',
    contentRating: 'safe'
  },

  // 3) demo-lenda-sem-ptbr (apenas 'en')
  {
    provider: 'demo',
    id: 'demo-ss-en-cap-1',
    mangaId: 'demo-lenda-sem-ptbr',
    title: 'Echoes in the Void',
    volumeNumber: '1',
    chapterNumber: '1',
    language: 'en',
    scanlationGroup: 'Starlight Scans',
    pagesCount: 3,
    externalUrl: null,
    publishedAt: '2025-11-01T10:00:00.000Z',
    contentRating: 'safe'
  },
  {
    provider: 'demo',
    id: 'demo-ss-en-cap-2',
    mangaId: 'demo-lenda-sem-ptbr',
    title: 'Orbit of Glass',
    volumeNumber: '1',
    chapterNumber: '2',
    language: 'en',
    scanlationGroup: 'Starlight Scans',
    pagesCount: 3,
    externalUrl: null,
    publishedAt: '2025-11-10T10:00:00.000Z',
    contentRating: 'safe'
  }
];

export class DemoCatalogProvider implements CatalogProvider {
  public readonly providerId = 'demo' as const;

  async searchMangas(params: SearchMangasParams): Promise<PaginatedResult<MangaSummaryDto>> {
    const query = (params.query ?? '').trim().toLowerCase();
    const tag = (params.tag ?? '').trim().toLowerCase();
    const page = Math.max(1, Number(params.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(params.limit ?? 20)));

    const filtered = DEMO_WORKS.filter((work) => {
      const matchesQuery =
        !query ||
        work.title.toLowerCase().includes(query) ||
        work.synopsis.toLowerCase().includes(query);
      const matchesTag =
        !tag ||
        work.tags.some(
          (t) => t.id.toLowerCase() === tag || t.name.toLowerCase() === tag
        );
      return matchesQuery && matchesTag;
    });

    const start = (page - 1) * limit;
    const items = filtered.slice(start, start + limit);

    return {
      items,
      page,
      limit,
      total: filtered.length,
      hasMore: start + items.length < filtered.length
    };
  }

  async getTags(): Promise<MangaTagDto[]> {
    return [...DEMO_TAGS];
  }

  async getMangaById(mangaId: string): Promise<MangaDetailDto> {
    const work = DEMO_WORKS.find((w) => w.id === mangaId);
    if (!work) {
      throw new ProviderError({
        message: `Obra '${mangaId}' não encontrada no catálogo demo.`,
        statusCode: 404,
        code: 'MANGA_NOT_FOUND',
        provider: 'demo'
      });
    }
    return work;
  }

  async getManyMangas(mangaIds: string[]): Promise<Map<string, MangaSummaryDto>> {
    const map = new Map<string, MangaSummaryDto>();
    for (const id of mangaIds) {
      const found = DEMO_WORKS.find((w) => w.id === id);
      if (found) {
        map.set(id, found);
      }
    }
    return map;
  }

  async getChapters(mangaId: string, language: string): Promise<{
    mangaId: string;
    language: string;
    availableLanguages: string[];
    chapters: CanonicalChapterDto[];
  }> {
    const work = await this.getMangaById(mangaId);
    const normalizedLang = (language || 'pt-br').trim().toLowerCase();
    const rawForWorkAndLang = DEMO_RAW_CHAPTERS.filter(
      (c) => c.mangaId === mangaId && c.language.toLowerCase() === normalizedLang
    );

    return {
      mangaId: work.id,
      language: normalizedLang,
      availableLanguages: work.availableLanguages,
      chapters: canonicalizeChapters(rawForWorkAndLang)
    };
  }

  async getChapterContext(chapterId: string): Promise<{
    chapter: CanonicalChapterDto;
    manga: MangaDetailDto;
    prevChapterId: string | null;
    nextChapterId: string | null;
  }> {
    const raw = DEMO_RAW_CHAPTERS.find((c) => c.id === chapterId);
    if (!raw) {
      throw new ProviderError({
        message: `Capítulo '${chapterId}' não encontrado no catálogo demo.`,
        statusCode: 404,
        code: 'CHAPTER_NOT_FOUND',
        provider: 'demo'
      });
    }

    const manga = await this.getMangaById(raw.mangaId);
    const { chapters } = await this.getChapters(raw.mangaId, raw.language);
    const found = findCanonicalChapterById(chapters, chapterId);

    if (!found) {
      throw new ProviderError({
        message: `Capítulo '${chapterId}' não pôde ser resolvido na ordem canônica.`,
        statusCode: 404,
        code: 'CHAPTER_NOT_FOUND',
        provider: 'demo'
      });
    }

    return {
      chapter: found.chapter,
      manga,
      prevChapterId: found.prevChapterId,
      nextChapterId: found.nextChapterId
    };
  }

  async getChapterManifest(chapterId: string): Promise<ChapterManifestDto> {
    const { chapter, manga, prevChapterId, nextChapterId } = await this.getChapterContext(chapterId);

    const pages = Array.from({ length: chapter.pagesCount }, (_, idx) => {
      const pageNumber = idx + 1;
      const chapterLabel = chapter.chapterNumber
        ? `Capítulo ${chapter.chapterNumber} — ${chapter.title}`
        : chapter.title;
      return {
        pageNumber,
        imageUrl: buildDemoPageDataUri({
          workTitle: manga.title,
          chapterLabel,
          pageNumber,
          totalPages: chapter.pagesCount,
          language: chapter.language
        })
      };
    });

    return {
      provider: 'demo',
      chapterId: chapter.id,
      mangaId: manga.id,
      language: chapter.language,
      chapterNumber: chapter.chapterNumber,
      volumeNumber: chapter.volumeNumber,
      title: chapter.title,
      canonicalPosition: chapter.canonicalPosition,
      totalPages: pages.length,
      pages,
      prevChapterId,
      nextChapterId,
      isDemo: true
    };
  }

  async getDiagnostics(): Promise<ProviderDiagnosticsDto> {
    return {
      provider: 'demo',
      status: 'operational',
      latencyMs: 1,
      checkedAt: new Date().toISOString(),
      coverage: {
        sampleWorksCount: DEMO_WORKS.length,
        totalReportedBySource: DEMO_WORKS.length,
        observedLanguages: ['pt-br', 'en'],
        configuredLanguages: ['pt-br', 'en'],
        contentFilter: 'safe',
        commercialPolicyNote:
          'Fixtures autorais sintéticas determinísticas para demonstração do Paywall Free/Pro, Stripe em modo de teste e suíte de QA.'
      }
    };
  }
}

export const demoCatalogProvider = new DemoCatalogProvider();
