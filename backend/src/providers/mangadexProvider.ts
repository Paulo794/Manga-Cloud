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

const MANGADEX_API_BASE = 'https://api.mangadex.org';
const MANGADEX_UPLOADS_BASE = 'https://uploads.mangadex.org';
const REQUEST_TIMEOUT_MS = 8000;
const RETRY_BACKOFF_MS = 400;
const MAX_FEED_ITEMS = 5000;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertValidMangadexUuid(id: string, resourceLabel: string): void {
  if (!UUID_REGEX.test(id.trim())) {
    throw new ProviderError({
      message: `${resourceLabel} inválido para o provedor MangaDex: '${id}'. Esperado UUID.`,
      statusCode: 400,
      code: 'INVALID_EXTERNAL_ID',
      provider: 'mangadex'
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickLocalizedString(
  mapObj: Record<string, string | undefined> | undefined | null,
  preferredLangs: string[] = ['pt-br', 'pt', 'en', 'ja-ro', 'ja']
): string {
  if (!mapObj || typeof mapObj !== 'object') {
    return '';
  }
  for (const lang of preferredLangs) {
    const val = mapObj[lang];
    if (typeof val === 'string' && val.trim().length > 0) {
      return sanitizePlainText(val);
    }
  }
  for (const val of Object.values(mapObj)) {
    if (typeof val === 'string' && val.trim().length > 0) {
      return sanitizePlainText(val);
    }
  }
  return '';
}

export class MangaDexCatalogProvider implements CatalogProvider {
  public readonly providerId = 'mangadex' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly retryBackoffMs: number;
  private readonly maxFeedItems: number;

  constructor(options?: { fetchImpl?: typeof fetch; retryBackoffMs?: number; maxFeedItems?: number }) {
    this.fetchImpl = options?.fetchImpl ?? fetch;
    this.retryBackoffMs = options?.retryBackoffMs ?? RETRY_BACKOFF_MS;
    this.maxFeedItems = options?.maxFeedItems ?? MAX_FEED_ITEMS;
  }

  private async fetchJson<T>(relativePathWithQuery: string): Promise<T> {
    if (!relativePathWithQuery.startsWith('/')) {
      throw new Error('Caminho relativo inválido para MangaDex.');
    }
    const url = `${MANGADEX_API_BASE}${relativePathWithQuery}`;

    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'User-Agent': 'MangaCloud-Academic-SaaS/1.0 (ISW055)'
          },
          signal: controller.signal
        });

        if (response.status === 404) {
          throw new ProviderError({
            message: 'Recurso não encontrado na API do MangaDex.',
            statusCode: 404,
            code: 'EXTERNAL_RESOURCE_NOT_FOUND',
            provider: 'mangadex'
          });
        }

        if (response.status === 429) {
          const retryHeader = response.headers.get('retry-after');
          const retryAfterSeconds = retryHeader ? Math.max(1, Number(retryHeader) || 5) : 5;
          if (attempt === 0 && retryAfterSeconds <= 2) {
            await sleep(retryAfterSeconds * 1000);
            continue;
          }
          throw new ProviderError({
            message: 'Limite de requisições da API externa atingido (429). Tente novamente em instantes.',
            statusCode: 429,
            code: 'EXTERNAL_RATE_LIMIT',
            provider: 'mangadex',
            retryAfterSeconds
          });
        }

        if (response.status >= 500) {
          if (attempt === 0) {
            await sleep(this.retryBackoffMs);
            continue;
          }
          throw new ProviderError({
            message: `Serviço externo MangaDex indisponível (HTTP ${response.status}).`,
            statusCode: 502,
            code: 'EXTERNAL_PROVIDER_ERROR',
            provider: 'mangadex'
          });
        }

        if (!response.ok) {
          throw new ProviderError({
            message: `Resposta inesperada do MangaDex (HTTP ${response.status}).`,
            statusCode: 502,
            code: 'EXTERNAL_PROVIDER_ERROR',
            provider: 'mangadex'
          });
        }

        // F1-03: O timer permanece ativo até concluir a leitura e parse do corpo JSON
        const body = (await response.json()) as T;
        return body;
      } catch (err: any) {
        if (err instanceof ProviderError) {
          throw err;
        }

        const isAbort = err?.name === 'AbortError' || controller.signal.aborted;
        if (attempt === 0) {
          await sleep(this.retryBackoffMs);
          continue;
        }

        const causeCode = err?.cause?.code ? String(err.cause.code) : '';
        const causeAddr = err?.cause?.address ? ` (${String(err.cause.address)})` : '';
        const causeDetail = causeCode ? ` [${causeCode}${causeAddr}]` : '';

        throw new ProviderError({
          message: isAbort
            ? 'Tempo limite excedido ao consultar a API do MangaDex (8s).'
            : `Falha de comunicação com a API do MangaDex: ${String(err?.message ?? 'erro de rede')}${causeDetail}`,
          statusCode: isAbort ? 504 : 503,
          code: isAbort ? 'EXTERNAL_PROVIDER_TIMEOUT' : 'EXTERNAL_PROVIDER_UNAVAILABLE',
          provider: 'mangadex'
        });
      } finally {
        clearTimeout(timer);
      }
    }

    throw new ProviderError({
      message: 'Falha ao consultar o provedor MangaDex.',
      statusCode: 503,
      code: 'EXTERNAL_PROVIDER_UNAVAILABLE',
      provider: 'mangadex'
    });
  }

  private mapMangaEntity(entity: any): MangaDetailDto {
    const id = String(entity?.id ?? '');
    const attrs = entity?.attributes ?? {};
    // F1-04: Exigir classificação explicitamente 'safe' (nunca assumir 'safe' quando ausente)
    const rawRating = typeof attrs?.contentRating === 'string' ? attrs.contentRating.trim().toLowerCase() : '';

    if (rawRating !== 'safe') {
      throw new ProviderError({
        message: 'Esta obra não possui classificação segura explícita (safe) permitida no MVP.',
        statusCode: 403,
        code: 'CONTENT_RATING_RESTRICTED',
        provider: 'mangadex'
      });
    }

    const title = pickLocalizedString(attrs.title) || 'Sem título';
    const synopsis =
      pickLocalizedString(attrs.description, ['pt-br', 'pt', 'en']) ||
      'Sinopse não informada na fonte externa.';

    const relationships: any[] = Array.isArray(entity?.relationships) ? entity.relationships : [];
    const coverRel = relationships.find((r) => r?.type === 'cover_art');
    const coverFileName = coverRel?.attributes?.fileName;
    const coverUrl =
      typeof coverFileName === 'string' && coverFileName.length > 0
        ? `${MANGADEX_UPLOADS_BASE}/covers/${id}/${encodeURIComponent(coverFileName)}.256.jpg`
        : null;

    const authors = relationships
      .filter((r) => (r?.type === 'author' || r?.type === 'artist') && r?.attributes?.name)
      .map((r) => sanitizePlainText(r.attributes.name));

    const tags: MangaTagDto[] = (Array.isArray(attrs.tags) ? attrs.tags : [])
      .map((t: any) => ({
        id: String(t?.id ?? ''),
        name: pickLocalizedString(t?.attributes?.name, ['en', 'pt-br']) || 'Tag',
        group: String(t?.attributes?.group ?? 'genre')
      }))
      .filter((t: MangaTagDto) => t.id.length > 0);

    const availableLanguages: string[] = Array.isArray(attrs.availableTranslatedLanguages)
      ? attrs.availableTranslatedLanguages.filter((l: any) => typeof l === 'string' && l.length > 0)
      : [];

    return {
      provider: 'mangadex',
      id,
      title,
      synopsis,
      coverUrl,
      status: String(attrs.status ?? 'ongoing'),
      year: typeof attrs.year === 'number' ? attrs.year : null,
      contentRating: 'safe',
      tags,
      availableLanguages,
      authors: Array.from(new Set(authors)),
      updatedAt: typeof attrs.updatedAt === 'string' ? attrs.updatedAt : null,
      isDemo: false
    };
  }

  private mapRawChapterEntity(entity: any, fallbackMangaId?: string): RawChapterDto {
    const id = String(entity?.id ?? '');
    const attrs = entity?.attributes ?? {};
    const relationships: any[] = Array.isArray(entity?.relationships) ? entity.relationships : [];
    const mangaRel = relationships.find((r) => r?.type === 'manga');
    const scanRel = relationships.find((r) => r?.type === 'scanlation_group');

    const mangaId = String(mangaRel?.id ?? fallbackMangaId ?? '');
    const scanlationGroup = sanitizePlainText(scanRel?.attributes?.name) || 'Comunidade MangaDex';
    const rawTitle = sanitizePlainText(attrs.title);
    const chapterNum = attrs.chapter != null && String(attrs.chapter).trim() !== '' ? String(attrs.chapter).trim() : null;
    const volumeNum = attrs.volume != null && String(attrs.volume).trim() !== '' ? String(attrs.volume).trim() : null;

    // F1-04: Se contentRating vier explícito no capítulo e não for safe, preserva o valor para bloqueio;
    // a segurança da obra sempre é garantida pela validação de getMangaById(mangaId).
    const explicitChapterRating =
      typeof attrs.contentRating === 'string' && attrs.contentRating.trim() !== ''
        ? attrs.contentRating.trim().toLowerCase()
        : 'safe';

    return {
      provider: 'mangadex',
      id,
      mangaId,
      title: rawTitle || (chapterNum ? `Capítulo ${chapterNum}` : 'Capítulo Especial'),
      volumeNumber: volumeNum,
      chapterNumber: chapterNum,
      language: String(attrs.translatedLanguage ?? 'pt-br').toLowerCase(),
      scanlationGroup,
      pagesCount: Number(attrs.pages ?? 0),
      externalUrl: typeof attrs.externalUrl === 'string' && attrs.externalUrl.trim() !== '' ? attrs.externalUrl : null,
      publishedAt: String(attrs.publishAt ?? attrs.createdAt ?? new Date().toISOString()),
      contentRating: explicitChapterRating
    };
  }

  async searchMangas(params: SearchMangasParams): Promise<PaginatedResult<MangaSummaryDto>> {
    const page = Math.max(1, Number(params.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(params.limit ?? 20)));
    const offset = (page - 1) * limit;

    const search = new URLSearchParams();
    search.set('limit', String(limit));
    search.set('offset', String(offset));
    search.append('contentRating[]', 'safe');
    search.append('includes[]', 'cover_art');
    search.append('includes[]', 'author');
    search.set('hasAvailableChapters', 'true');
    search.set('order[followedCount]', 'desc');

    if (params.query && params.query.trim() !== '') {
      search.set('title', params.query.trim());
    }
    if (params.tag && UUID_REGEX.test(params.tag.trim())) {
      search.append('includedTags[]', params.tag.trim());
    }
    if (params.language && params.language.trim() !== '') {
      search.append('availableTranslatedLanguage[]', params.language.trim().toLowerCase());
    }

    const payload = await this.fetchJson<{ data: any[]; total?: number }>(`/manga?${search.toString()}`);
    const data = Array.isArray(payload?.data) ? payload.data : [];
    const items: MangaSummaryDto[] = [];

    for (const entry of data) {
      try {
        items.push(this.mapMangaEntity(entry));
      } catch {
        // Ignora entrada sem contentRating: 'safe' explícito
      }
    }

    const total = Number(payload?.total ?? items.length);
    return {
      items,
      page,
      limit,
      total,
      hasMore: offset + data.length < total
    };
  }

  async getTags(): Promise<MangaTagDto[]> {
    const payload = await this.fetchJson<{ data: any[] }>('/manga/tag');
    const data = Array.isArray(payload?.data) ? payload.data : [];
    return data
      .map((t) => ({
        id: String(t?.id ?? ''),
        name: pickLocalizedString(t?.attributes?.name, ['en', 'pt-br']) || 'Tag',
        group: String(t?.attributes?.group ?? 'genre')
      }))
      .filter((t) => t.id.length > 0 && (t.group === 'genre' || t.group === 'theme'))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getMangaById(mangaId: string): Promise<MangaDetailDto> {
    assertValidMangadexUuid(mangaId, 'ID da obra');
    const search = new URLSearchParams();
    search.append('includes[]', 'cover_art');
    search.append('includes[]', 'author');
    search.append('includes[]', 'artist');

    const payload = await this.fetchJson<{ data: any }>(`/manga/${encodeURIComponent(mangaId.trim())}?${search.toString()}`);
    if (!payload?.data) {
      throw new ProviderError({
        message: 'Obra não encontrada no MangaDex.',
        statusCode: 404,
        code: 'MANGA_NOT_FOUND',
        provider: 'mangadex'
      });
    }
    return this.mapMangaEntity(payload.data);
  }

  async getManyMangas(mangaIds: string[]): Promise<Map<string, MangaSummaryDto>> {
    const validIds = Array.from(new Set(mangaIds.filter((id) => UUID_REGEX.test(id.trim())))).slice(0, 100);
    const result = new Map<string, MangaSummaryDto>();
    if (validIds.length === 0) {
      return result;
    }

    const search = new URLSearchParams();
    search.set('limit', String(validIds.length));
    search.append('contentRating[]', 'safe');
    search.append('includes[]', 'cover_art');
    for (const id of validIds) {
      search.append('ids[]', id);
    }

    const payload = await this.fetchJson<{ data: any[] }>(`/manga?${search.toString()}`);
    const data = Array.isArray(payload?.data) ? payload.data : [];
    for (const entry of data) {
      try {
        const mapped = this.mapMangaEntity(entry);
        result.set(mapped.id, mapped);
      } catch {
        // Ignora entrada sem contentRating: 'safe'
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
    const manga = await this.getMangaById(mangaId);
    const normalizedLang = (language || 'pt-br').trim().toLowerCase();

    // F1-02: Consumir toda a paginação necessária sem truncar silenciosamente em 500 itens
    const allRawChapters: RawChapterDto[] = [];
    const pageLimit = 100;
    let offset = 0;
    let reportedTotal = 0;

    while (true) {
      if (offset >= this.maxFeedItems) {
        throw new ProviderError({
          message: `A obra excede o limite operacional de ${this.maxFeedItems} entradas de capítulos para canonização completa.`,
          statusCode: 502,
          code: 'EXTERNAL_PAGINATION_INCOMPLETE',
          provider: 'mangadex'
        });
      }

      const search = new URLSearchParams();
      search.set('limit', String(pageLimit));
      search.set('offset', String(offset));
      search.append('translatedLanguage[]', normalizedLang);
      search.append('contentRating[]', 'safe');
      search.append('includes[]', 'scanlation_group');
      search.set('order[volume]', 'asc');
      search.set('order[chapter]', 'asc');

      const payload = await this.fetchJson<{ data: any[]; total?: number }>(
        `/manga/${encodeURIComponent(manga.id)}/feed?${search.toString()}`
      );
      const batch = Array.isArray(payload?.data) ? payload.data : [];
      reportedTotal = Number(payload?.total ?? allRawChapters.length + batch.length);

      for (const item of batch) {
        const mapped = this.mapRawChapterEntity(item, manga.id);
        if (mapped.contentRating === 'safe') {
          allRawChapters.push(mapped);
        }
      }

      offset += batch.length;

      if (offset >= reportedTotal) {
        break;
      }

      if (batch.length === 0) {
        throw new ProviderError({
          message: `Paginação incompleta do MangaDex: recebidos ${offset} de ${reportedTotal} capítulos anunciados.`,
          statusCode: 502,
          code: 'EXTERNAL_PAGINATION_INCOMPLETE',
          provider: 'mangadex'
        });
      }
    }

    return {
      mangaId: manga.id,
      language: normalizedLang,
      availableLanguages: manga.availableLanguages,
      chapters: canonicalizeChapters(allRawChapters)
    };
  }

  async getChapterContext(chapterId: string): Promise<{
    chapter: CanonicalChapterDto;
    manga: MangaDetailDto;
    prevChapterId: string | null;
    nextChapterId: string | null;
  }> {
    assertValidMangadexUuid(chapterId, 'ID do capítulo');
    const search = new URLSearchParams();
    search.append('includes[]', 'manga');
    search.append('includes[]', 'scanlation_group');

    const payload = await this.fetchJson<{ data: any }>(`/chapter/${encodeURIComponent(chapterId.trim())}?${search.toString()}`);
    if (!payload?.data) {
      throw new ProviderError({
        message: 'Capítulo não encontrado no MangaDex.',
        statusCode: 404,
        code: 'CHAPTER_NOT_FOUND',
        provider: 'mangadex'
      });
    }

    const rawChapter = this.mapRawChapterEntity(payload.data);
    if (rawChapter.contentRating !== 'safe') {
      throw new ProviderError({
        message: 'Este capítulo não possui classificação segura permitida no MVP.',
        statusCode: 403,
        code: 'CONTENT_RATING_RESTRICTED',
        provider: 'mangadex'
      });
    }
    if (!rawChapter.mangaId) {
      throw new ProviderError({
        message: 'Capítulo sem vínculo de obra no MangaDex.',
        statusCode: 404,
        code: 'CHAPTER_MANGA_MISSING',
        provider: 'mangadex'
      });
    }

    const manga = await this.getMangaById(rawChapter.mangaId);
    const { chapters } = await this.getChapters(manga.id, rawChapter.language);
    const found = findCanonicalChapterById(chapters, rawChapter.id);

    if (found) {
      return {
        chapter: found.chapter,
        manga,
        prevChapterId: found.prevChapterId,
        nextChapterId: found.nextChapterId
      };
    }

    return {
      chapter: {
        ...rawChapter,
        canonicalPosition: null,
        numericChapter: null,
        isEligibleForFree: false,
        unclassifiedReason: rawChapter.externalUrl ? 'EXTERNAL_CHAPTER_ONLY' : 'UNCLASSIFIED_CHAPTER',
        alternateTranslations: []
      },
      manga,
      prevChapterId: null,
      nextChapterId: null
    };
  }

  async getChapterManifest(chapterId: string): Promise<ChapterManifestDto> {
    const { chapter, manga, prevChapterId, nextChapterId } = await this.getChapterContext(chapterId);

    if (chapter.externalUrl) {
      throw new ProviderError({
        message: 'Este capítulo é hospedado apenas em editora externa e não possui imagens no servidor do provedor.',
        statusCode: 422,
        code: 'EXTERNAL_CHAPTER_ONLY',
        provider: 'mangadex'
      });
    }

    const atHome = await this.fetchJson<{
      baseUrl?: string;
      chapter?: { hash?: string; data?: string[]; dataSaver?: string[] };
    }>(`/at-home/server/${encodeURIComponent(chapter.id)}`);

    const baseUrl = typeof atHome?.baseUrl === 'string' ? atHome.baseUrl.replace(/\/$/, '') : '';
    const hash = typeof atHome?.chapter?.hash === 'string' ? atHome.chapter?.hash : '';
    const files: string[] = Array.isArray(atHome?.chapter?.data) ? atHome.chapter.data : [];

    if (!baseUrl || !hash || files.length === 0) {
      throw new ProviderError({
        message: 'Este capítulo não possui páginas de imagem disponíveis na fonte.',
        statusCode: 404,
        code: 'CHAPTER_PAGES_UNAVAILABLE',
        provider: 'mangadex'
      });
    }

    const pages = files.map((fileName, idx) => ({
      pageNumber: idx + 1,
      imageUrl: `${baseUrl}/data/${encodeURIComponent(hash)}/${encodeURIComponent(fileName)}`
    }));

    return {
      provider: 'mangadex',
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
      isDemo: false
    };
  }

  async getDiagnostics(): Promise<ProviderDiagnosticsDto> {
    const startedAt = Date.now();
    try {
      const sample = await this.searchMangas({ language: 'pt-br', page: 1, limit: 5 });
      const observedLangs = Array.from(
        new Set(sample.items.flatMap((item) => item.availableLanguages))
      );
      return {
        provider: 'mangadex',
        status: 'operational',
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
        coverage: {
          sampleWorksCount: sample.items.length,
          totalReportedBySource: sample.total,
          observedLanguages: observedLangs,
          configuredLanguages: ['pt-br', 'en', 'es', 'ja-ro'],
          contentFilter: 'safe',
          commercialPolicyNote:
            'Integração técnica de leitura real ativa (Acceptable Usage Policy: sem cobrança comercial sobre a API pública do MangaDex).'
        }
      };
    } catch (err: any) {
      return {
        provider: 'mangadex',
        status: 'unavailable',
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
        coverage: {
          sampleWorksCount: 0,
          totalReportedBySource: 0,
          observedLanguages: [],
          configuredLanguages: ['pt-br', 'en'],
          contentFilter: 'safe',
          commercialPolicyNote: 'Provedor externo temporariamente inacessível na rede atual.'
        },
        errorMessage: String(err?.message ?? 'Falha ao consultar MangaDex')
      };
    }
  }
}

export const mangadexCatalogProvider = new MangaDexCatalogProvider();
