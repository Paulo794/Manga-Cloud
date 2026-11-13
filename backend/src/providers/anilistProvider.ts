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
  SearchMangasParams,
  sanitizePlainText
} from './types';

const ANILIST_GRAPHQL_URL = 'https://graphql.anilist.co';
const REQUEST_TIMEOUT_MS = 8000;
const MEDIA_CACHE_TTL_MS = 5 * 60 * 1000;
const TAGS_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 256;
const MAX_GENERATED_CHAPTERS = 100;
const DEFAULT_ONGOING_CHAPTERS = 5;
const PREVIEW_PAGES_PER_CHAPTER = 3;
const VALID_ID_REGEX = /^[1-9]\d{0,9}$/;
const CHAPTER_ID_REGEX = /^anilist-([1-9]\d{0,9})-(pt-br|en)-cap-(\d{1,4})$/i;
const RESTRICTED_GENRES = new Set(['hentai', 'ecchi']);

const GENRE_LABELS_PT: Record<string, string> = {
  Action: 'Ação',
  Adventure: 'Aventura',
  Comedy: 'Comédia',
  Drama: 'Drama',
  Fantasy: 'Fantasia',
  Horror: 'Terror',
  'Mahou Shoujo': 'Mahou Shoujo',
  Mecha: 'Mecha',
  Music: 'Música',
  Mystery: 'Mistério',
  Psychological: 'Psicológico',
  Romance: 'Romance',
  'Sci-Fi': 'Ficção Científica',
  'Slice of Life': 'Slice of Life',
  Sports: 'Esportes',
  Supernatural: 'Sobrenatural',
  Thriller: 'Suspense'
};

interface AnilistMediaRaw {
  id?: number;
  title?: { romaji?: string | null; english?: string | null; native?: string | null } | null;
  description?: string | null;
  coverImage?: { extraLarge?: string | null; large?: string | null } | null;
  status?: string | null;
  startDate?: { year?: number | null } | null;
  chapters?: number | null;
  genres?: string[] | null;
  isAdult?: boolean | null;
  updatedAt?: number | null;
  staff?: {
    edges?: Array<{
      role?: string | null;
      node?: { name?: { full?: string | null } | null } | null;
    }> | null;
  } | null;
}

interface CachedAnilistWork {
  detail: MangaDetailDto;
  chapterCount: number;
  expiresAt: number;
}

const MEDIA_FIELDS = `
  id
  title { romaji english native }
  description(asHtml: false)
  coverImage { extraLarge large }
  status
  startDate { year }
  chapters
  genres
  isAdult
  updatedAt
  staff(perPage: 10) {
    edges {
      role
      node { name { full } }
    }
  }
`;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatAnilistDescription(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const withBreaks = raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
  return sanitizePlainText(withBreaks);
}

function wrapLines(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word.slice(0, maxChars);
      if (lines.length >= maxLines) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines.length ? lines : ['Prévia ilustrativa do capítulo selecionada via catálogo AniList.'];
}

function buildAnilistPreviewPageUri(params: {
  mangaTitle: string;
  chapterNumber: string;
  language: string;
  synopsis: string;
  genres: string[];
  pageNumber: number;
  totalPages: number;
}): string {
  const { mangaTitle, chapterNumber, language, synopsis, genres, pageNumber, totalPages } = params;
  const titleLines = wrapLines(mangaTitle, 38, 2);
  const summaryLines = wrapLines(synopsis || 'Consulte a ficha da obra para ver sinopse e detalhes completos.', 58, 5);
  const genreLine = genres.length ? genres.slice(0, 4).join(' • ') : 'Mangá';

  const titleSvg = titleLines
    .map((line, i) => `<text x="72" y="${155 + i * 38}" fill="#0f172a" font-family="sans-serif" font-size="30" font-weight="bold">${escapeXml(line)}</text>`)
    .join('');

  const summarySvg = summaryLines
    .map((line, i) => `<text x="72" y="${430 + i * 34}" fill="#1e293b" font-family="sans-serif" font-size="22">${escapeXml(line)}</text>`)
    .join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1280" viewBox="0 0 900 1280">
    <rect width="900" height="1280" fill="#0f172a" />
    <rect x="36" y="36" width="828" height="1208" fill="#f8fafc" stroke="#1e293b" stroke-width="5" rx="12" />
    <rect x="60" y="68" width="780" height="230" fill="#e2e8f0" stroke="#0f172a" stroke-width="3" rx="8" />
    <text x="72" y="106" fill="#c2410c" font-family="sans-serif" font-size="18" font-weight="bold" letter-spacing="2">MANGACLOUD • ANILIST METADATA PREVIEW</text>
    ${titleSvg}
    <text x="72" y="262" fill="#334155" font-family="sans-serif" font-size="22">Capítulo ${escapeXml(chapterNumber)} • Idioma ${escapeXml(language.toUpperCase())} • ${escapeXml(genreLine)}</text>
    <rect x="60" y="330" width="780" height="320" fill="#ffffff" stroke="#334155" stroke-width="3" rx="8" />
    <text x="72" y="376" fill="#0f172a" font-family="sans-serif" font-size="22" font-weight="bold">Sinopse da obra (AniList)</text>
    ${summarySvg}
    <rect x="60" y="685" width="780" height="420" fill="#fef3c7" stroke="#92400e" stroke-width="3" rx="8" />
    <text x="84" y="750" fill="#78350f" font-family="sans-serif" font-size="26" font-weight="bold">Prévia ilustrativa de leitura — Página ${pageNumber} de ${totalPages}</text>
    <text x="84" y="805" fill="#92400e" font-family="sans-serif" font-size="20">A API pública do AniList fornece catálogo, capas e metadados oficiais,</text>
    <text x="84" y="838" fill="#92400e" font-family="sans-serif" font-size="20">mas não hospeda imagens reais das páginas dos capítulos.</text>
    <text x="84" y="905" fill="#78350f" font-family="sans-serif" font-size="20">Esta visualização permite navegar no leitor e salvar histórico/estantes.</text>
    <text x="450" y="1192" text-anchor="middle" fill="#475569" font-family="sans-serif" font-size="22" font-weight="bold">Página ${pageNumber} / ${totalPages} — Catálogo AniList</text>
  </svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function assertValidAnilistId(id: string): string {
  const trimmed = id.trim();
  if (!VALID_ID_REGEX.test(trimmed)) {
    throw new ProviderError({
      message: `Identificador inválido para o provedor AniList: '${id}'. Esperado número inteiro positivo.`,
      statusCode: 400,
      code: 'INVALID_EXTERNAL_ID',
      provider: 'anilist'
    });
  }
  return trimmed;
}

function mapStatus(raw: string | null | undefined): string {
  switch (raw) {
    case 'FINISHED':
      return 'completed';
    case 'RELEASING':
      return 'ongoing';
    case 'NOT_YET_RELEASED':
      return 'upcoming';
    case 'CANCELLED':
      return 'cancelled';
    case 'HIATUS':
      return 'hiatus';
    default:
      return 'unknown';
  }
}

export class AnilistCatalogProvider implements CatalogProvider {
  public readonly providerId = 'anilist' as const;
  private tagsCache: { items: MangaTagDto[]; expiresAt: number } | null = null;
  private readonly mediaCache = new Map<string, CachedAnilistWork>();

  private async postGraphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(ANILIST_GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'MangaCloud-Academic-SaaS/1.0 (ISW055)'
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal
      });

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after')) || 5;
        throw new ProviderError({
          message: 'Limite de requisições da API do AniList atingido. Tente novamente em instantes.',
          statusCode: 429,
          code: 'EXTERNAL_RATE_LIMIT',
          provider: 'anilist',
          retryAfterSeconds: retryAfter
        });
      }

      if (response.status === 404) {
        throw new ProviderError({
          message: 'Obra não encontrada no AniList.',
          statusCode: 404,
          code: 'EXTERNAL_RESOURCE_NOT_FOUND',
          provider: 'anilist'
        });
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new ProviderError({
          message: `Erro ao consultar AniList (HTTP ${response.status})${errorText ? `: ${errorText.slice(0, 140)}` : ''}.`,
          statusCode: response.status >= 500 ? 502 : 400,
          code: 'EXTERNAL_PROVIDER_ERROR',
          provider: 'anilist'
        });
      }

      const payload = (await response.json()) as { data?: T; errors?: Array<{ status?: number; message?: string }> };
      if (Array.isArray(payload.errors) && payload.errors.length > 0) {
        const first = payload.errors[0]!;
        if (first.status === 404) {
          throw new ProviderError({
            message: 'Obra não encontrada no AniList.',
            statusCode: 404,
            code: 'EXTERNAL_RESOURCE_NOT_FOUND',
            provider: 'anilist'
          });
        }
        throw new ProviderError({
          message: `Erro retornado pelo AniList: ${first.message || 'consulta inválida'}.`,
          statusCode: 502,
          code: 'EXTERNAL_PROVIDER_ERROR',
          provider: 'anilist'
        });
      }

      if (!payload.data) {
        throw new ProviderError({
          message: 'Resposta vazia da API do AniList.',
          statusCode: 502,
          code: 'EXTERNAL_PROVIDER_ERROR',
          provider: 'anilist'
        });
      }

      return payload.data;
    } catch (err: any) {
      if (err instanceof ProviderError) {
        throw err;
      }
      if (err?.name === 'AbortError' || controller.signal.aborted) {
        throw new ProviderError({
          message: 'Tempo limite excedido ao aguardar resposta do AniList.',
          statusCode: 504,
          code: 'EXTERNAL_PROVIDER_TIMEOUT',
          provider: 'anilist'
        });
      }
      throw new ProviderError({
        message: 'Não foi possível conectar ao AniList neste momento.',
        statusCode: 503,
        code: 'EXTERNAL_PROVIDER_UNAVAILABLE',
        provider: 'anilist'
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private isRestrictedMedia(raw: AnilistMediaRaw): boolean {
    const hasRestrictedGenre = (raw.genres ?? []).some(
      (g) => typeof g === 'string' && RESTRICTED_GENRES.has(g.trim().toLowerCase())
    );
    return raw.isAdult === true || hasRestrictedGenre;
  }

  private assertSafeMedia(raw: AnilistMediaRaw): void {
    if (this.isRestrictedMedia(raw)) {
      throw new ProviderError({
        message: 'Obra fora da classificação livre/segura permitida no MangaCloud.',
        statusCode: 403,
        code: 'CONTENT_RATING_RESTRICTED',
        provider: 'anilist'
      });
    }
  }

  private mapMedia(raw: AnilistMediaRaw): CachedAnilistWork {
    const id = String(raw.id ?? '');
    const title =
      sanitizePlainText(raw.title?.english) ||
      sanitizePlainText(raw.title?.romaji) ||
      sanitizePlainText(raw.title?.native) ||
      'Obra sem título';
    const genres = (raw.genres ?? []).filter(
      (g): g is string => typeof g === 'string' && !RESTRICTED_GENRES.has(g.trim().toLowerCase())
    );
    const tags: MangaTagDto[] = genres.map((genre) => ({
      id: genre,
      name: GENRE_LABELS_PT[genre] ?? genre,
      group: 'genre'
    }));
    const authors = Array.from(
      new Set(
        (raw.staff?.edges ?? [])
          .map((edge) => sanitizePlainText(edge?.node?.name?.full))
          .filter(Boolean)
      )
    );
    const chapterCount =
      typeof raw.chapters === 'number' && raw.chapters > 0
        ? Math.min(raw.chapters, MAX_GENERATED_CHAPTERS)
        : DEFAULT_ONGOING_CHAPTERS;

    const detail: MangaDetailDto = {
      provider: 'anilist',
      id,
      title,
      synopsis: formatAnilistDescription(raw.description) || 'Sem sinopse disponível no AniList.',
      coverUrl: raw.coverImage?.extraLarge || raw.coverImage?.large || null,
      status: mapStatus(raw.status),
      year: typeof raw.startDate?.year === 'number' ? raw.startDate.year : null,
      contentRating: 'safe',
      tags,
      availableLanguages: ['pt-br', 'en'],
      authors,
      updatedAt: typeof raw.updatedAt === 'number' ? new Date(raw.updatedAt * 1000).toISOString() : null,
      isDemo: false
    };

    return {
      detail,
      chapterCount,
      expiresAt: Date.now() + MEDIA_CACHE_TTL_MS
    };
  }

  private cacheWork(entry: CachedAnilistWork): void {
    if (this.mediaCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = this.mediaCache.keys().next().value;
      if (oldestKey) this.mediaCache.delete(oldestKey);
    }
    this.mediaCache.delete(entry.detail.id);
    this.mediaCache.set(entry.detail.id, entry);
  }

  private async getWorkCached(mangaId: string): Promise<CachedAnilistWork> {
    const cleanId = assertValidAnilistId(mangaId);
    const cached = this.mediaCache.get(cleanId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached;
    }
    this.mediaCache.delete(cleanId);

    const data = await this.postGraphql<{ Media?: AnilistMediaRaw | null }>(
      `query ($id: Int!) {
        Media(id: $id, type: MANGA) {
          ${MEDIA_FIELDS}
        }
      }`,
      { id: Number(cleanId) }
    );

    if (!data.Media || !data.Media.id) {
      throw new ProviderError({
        message: 'Obra não encontrada no AniList.',
        statusCode: 404,
        code: 'EXTERNAL_RESOURCE_NOT_FOUND',
        provider: 'anilist'
      });
    }

    this.assertSafeMedia(data.Media);
    const mapped = this.mapMedia(data.Media);
    this.cacheWork(mapped);
    return mapped;
  }

  async searchMangas(params: SearchMangasParams): Promise<PaginatedResult<MangaSummaryDto>> {
    const page = Math.max(1, Number(params.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(params.limit) || 12));
    const q = (params.query ?? '').trim();
    const tag = (params.tag ?? '').trim();

    if (tag && RESTRICTED_GENRES.has(tag.toLowerCase())) {
      return { items: [], page, limit, total: 0, hasMore: false };
    }

    const variables: Record<string, unknown> = {
      page,
      perPage: limit,
      sort: q ? ['SEARCH_MATCH', 'POPULARITY_DESC'] : ['POPULARITY_DESC']
    };
    if (q) variables.search = q;
    if (tag) variables.genreIn = [tag];

    const data = await this.postGraphql<{
      Page?: {
        pageInfo?: { total?: number; hasNextPage?: boolean } | null;
        media?: AnilistMediaRaw[] | null;
      } | null;
    }>(
      `query ($page: Int, $perPage: Int, $search: String, $genreIn: [String], $sort: [MediaSort]) {
        Page(page: $page, perPage: $perPage) {
          pageInfo { total hasNextPage }
          media(type: MANGA, isAdult: false, genre_not_in: ["Hentai", "Ecchi"], search: $search, genre_in: $genreIn, sort: $sort) {
            ${MEDIA_FIELDS}
          }
        }
      }`,
      variables
    );

    const mediaList = Array.isArray(data.Page?.media) ? data.Page.media : [];
    const items: MangaSummaryDto[] = [];
    for (const raw of mediaList) {
      if (!raw.id || this.isRestrictedMedia(raw)) continue;
      const mapped = this.mapMedia(raw);
      this.cacheWork(mapped);
      items.push(mapped.detail);
    }

    const total = typeof data.Page?.pageInfo?.total === 'number' ? data.Page.pageInfo.total : items.length;
    const hasMore = Boolean(data.Page?.pageInfo?.hasNextPage);
    return { items, page, limit, total, hasMore };
  }

  async getTags(): Promise<MangaTagDto[]> {
    if (this.tagsCache && this.tagsCache.expiresAt > Date.now()) {
      return this.tagsCache.items;
    }

    const data = await this.postGraphql<{ GenreCollection?: string[] | null }>('{ GenreCollection }');
    const genres = Array.isArray(data.GenreCollection) ? data.GenreCollection : [];
    const items: MangaTagDto[] = genres
      .filter((g): g is string => typeof g === 'string' && !RESTRICTED_GENRES.has(g.trim().toLowerCase()))
      .map((genre) => ({
        id: genre,
        name: GENRE_LABELS_PT[genre] ?? genre,
        group: 'genre'
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    this.tagsCache = { items, expiresAt: Date.now() + TAGS_CACHE_TTL_MS };
    return items;
  }

  async getMangaById(mangaId: string): Promise<MangaDetailDto> {
    return (await this.getWorkCached(mangaId)).detail;
  }

  async getManyMangas(mangaIds: string[]): Promise<Map<string, MangaSummaryDto>> {
    const result = new Map<string, MangaSummaryDto>();
    const validIds = Array.from(
      new Set(mangaIds.map((id) => String(id).trim()).filter((id) => VALID_ID_REGEX.test(id)))
    );
    if (!validIds.length) return result;

    const missingIds: number[] = [];
    const now = Date.now();
    for (const id of validIds) {
      const cached = this.mediaCache.get(id);
      if (cached && cached.expiresAt > now) {
        result.set(id, cached.detail);
      } else {
        missingIds.push(Number(id));
      }
    }

    for (let i = 0; i < missingIds.length; i += 50) {
      const chunk = missingIds.slice(i, i + 50);
      const data = await this.postGraphql<{
        Page?: { media?: AnilistMediaRaw[] | null } | null;
      }>(
        `query ($ids: [Int]) {
          Page(perPage: 50) {
            media(id_in: $ids, type: MANGA, isAdult: false, genre_not_in: ["Hentai", "Ecchi"]) {
              ${MEDIA_FIELDS}
            }
          }
        }`,
        { ids: chunk }
      );
      for (const raw of data.Page?.media ?? []) {
        if (!raw.id || this.isRestrictedMedia(raw)) continue;
        const mapped = this.mapMedia(raw);
        this.cacheWork(mapped);
        result.set(mapped.detail.id, mapped.detail);
      }
    }

    return result;
  }

  async getChapters(mangaId: string, language: string): Promise<{
    mangaId: string;
    language: string;
    availableLanguages: string[];
    chapters: CanonicalChapterDto[];
  }> {
    const work = await this.getWorkCached(mangaId);
    const normalizedLang = (language || 'pt-br').trim().toLowerCase() === 'en' ? 'en' : 'pt-br';

    const rawChapters: RawChapterDto[] = Array.from({ length: work.chapterCount }, (_, idx) => {
      const num = idx + 1;
      return {
        provider: 'anilist',
        id: `anilist-${work.detail.id}-${normalizedLang}-cap-${num}`,
        mangaId: work.detail.id,
        title: `Capítulo ${num}`,
        volumeNumber: null,
        chapterNumber: String(num),
        language: normalizedLang,
        scanlationGroup: 'Prévia ilustrativa · Catálogo AniList',
        pagesCount: PREVIEW_PAGES_PER_CHAPTER,
        externalUrl: null,
        publishedAt: work.detail.updatedAt ?? '2026-01-01T00:00:00.000Z',
        contentRating: 'safe'
      };
    });

    return {
      mangaId: work.detail.id,
      language: normalizedLang,
      availableLanguages: work.detail.availableLanguages,
      chapters: canonicalizeChapters(rawChapters)
    };
  }

  async getChapterContext(chapterId: string): Promise<{
    chapter: CanonicalChapterDto;
    manga: MangaDetailDto;
    prevChapterId: string | null;
    nextChapterId: string | null;
  }> {
    const match = CHAPTER_ID_REGEX.exec(chapterId.trim());
    if (!match) {
      throw new ProviderError({
        message: `Capítulo inválido para o provedor AniList: '${chapterId}'.`,
        statusCode: 400,
        code: 'INVALID_EXTERNAL_ID',
        provider: 'anilist'
      });
    }

    const [, mangaId, rawLang] = match;
    const work = await this.getWorkCached(mangaId!);
    const { chapters } = await this.getChapters(work.detail.id, rawLang!.toLowerCase());
    const found = findCanonicalChapterById(chapters, chapterId.trim().toLowerCase());

    if (!found) {
      throw new ProviderError({
        message: `Capítulo '${chapterId}' não encontrado para esta obra no AniList.`,
        statusCode: 404,
        code: 'EXTERNAL_RESOURCE_NOT_FOUND',
        provider: 'anilist'
      });
    }

    return {
      chapter: found.chapter,
      manga: work.detail,
      prevChapterId: found.prevChapterId,
      nextChapterId: found.nextChapterId
    };
  }

  async getChapterManifest(chapterId: string): Promise<ChapterManifestDto> {
    const { chapter, manga, prevChapterId, nextChapterId } = await this.getChapterContext(chapterId);
    const totalPages = chapter.pagesCount;
    const genreNames = manga.tags.map((t) => t.name);
    const pages = Array.from({ length: totalPages }, (_, idx) => ({
      pageNumber: idx + 1,
      imageUrl: buildAnilistPreviewPageUri({
        mangaTitle: manga.title,
        chapterNumber: chapter.chapterNumber ?? '1',
        language: chapter.language,
        synopsis: manga.synopsis,
        genres: genreNames,
        pageNumber: idx + 1,
        totalPages
      })
    }));

    return {
      provider: 'anilist',
      chapterId: chapter.id,
      mangaId: manga.id,
      language: chapter.language,
      chapterNumber: chapter.chapterNumber,
      volumeNumber: chapter.volumeNumber,
      title: `${manga.title} — ${chapter.title}`,
      canonicalPosition: chapter.canonicalPosition,
      totalPages,
      pages,
      prevChapterId,
      nextChapterId,
      isDemo: false
    };
  }

  async getDiagnostics(): Promise<ProviderDiagnosticsDto> {
    const startedAt = Date.now();
    try {
      const sample = await this.searchMangas({ page: 1, limit: 5 });
      return {
        provider: 'anilist',
        status: 'operational',
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
        coverage: {
          sampleWorksCount: sample.items.length,
          totalReportedBySource: sample.total,
          observedLanguages: ['pt-br', 'en'],
          configuredLanguages: ['pt-br', 'en'],
          contentFilter: 'safe',
          commercialPolicyNote:
            'Catálogo e capas reais fornecidos pela API pública GraphQL do AniList (isAdult: false); leitor utiliza prévia ilustrativa.'
        }
      };
    } catch (err: any) {
      return {
        provider: 'anilist',
        status: 'unavailable',
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
        coverage: {
          sampleWorksCount: 0,
          totalReportedBySource: 0,
          observedLanguages: [],
          configuredLanguages: ['pt-br', 'en'],
          contentFilter: 'safe',
          commercialPolicyNote: 'Provedor AniList temporariamente inacessível na rede atual.'
        },
        errorMessage: String(err?.message ?? 'Falha ao consultar AniList')
      };
    }
  }
}

export const anilistCatalogProvider = new AnilistCatalogProvider();
