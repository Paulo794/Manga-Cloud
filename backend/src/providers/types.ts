export type ProviderId = 'mangadex' | 'demo';

export const ALLOWED_PROVIDERS: readonly ProviderId[] = ['mangadex', 'demo'] as const;

export class ProviderError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly provider: ProviderId | string;
  public readonly retryAfterSeconds?: number;

  constructor(params: {
    message: string;
    statusCode: number;
    code: string;
    provider: ProviderId | string;
    retryAfterSeconds?: number;
  }) {
    super(params.message);
    this.name = 'ProviderError';
    this.statusCode = params.statusCode;
    this.code = params.code;
    this.provider = params.provider;
    this.retryAfterSeconds = params.retryAfterSeconds;
  }
}

export function assertValidProvider(raw: unknown, fallback?: ProviderId): ProviderId {
  const value = (typeof raw === 'string' && raw.trim() !== '' ? raw.trim().toLowerCase() : fallback) ?? '';
  if (value === 'mangadex' || value === 'demo') {
    return value;
  }
  throw new ProviderError({
    message: `Provedor inválido '${String(raw ?? '')}'. Use 'mangadex' ou 'demo'.`,
    statusCode: 400,
    code: 'INVALID_PROVIDER',
    provider: String(raw ?? 'unknown')
  });
}

export function sanitizePlainText(input: unknown): string {
  if (typeof input !== 'string') {
    return '';
  }
  return input
    .replace(/<[^>]*>/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
}

export interface MangaTagDto {
  id: string;
  name: string;
  group: string;
}

export interface MangaSummaryDto {
  provider: ProviderId;
  id: string;
  title: string;
  synopsis: string;
  coverUrl: string | null;
  status: string;
  year: number | null;
  contentRating: 'safe';
  tags: MangaTagDto[];
  availableLanguages: string[];
  isDemo: boolean;
}

export interface MangaDetailDto extends MangaSummaryDto {
  authors: string[];
  updatedAt: string | null;
}

export interface RawChapterDto {
  provider: ProviderId;
  id: string;
  mangaId: string;
  title: string;
  volumeNumber: string | null;
  chapterNumber: string | null;
  language: string;
  scanlationGroup: string;
  pagesCount: number;
  externalUrl: string | null;
  publishedAt: string;
  contentRating: 'safe' | string;
}

export type UnclassifiedReason = 'UNCLASSIFIED_CHAPTER' | 'EXTERNAL_CHAPTER_ONLY';

export interface AlternateTranslationDto {
  id: string;
  title: string;
  volumeNumber: string | null;
  chapterNumber: string | null;
  language: string;
  scanlationGroup: string;
  pagesCount: number;
  publishedAt: string;
}

export interface CanonicalChapterDto extends RawChapterDto {
  canonicalPosition: number | null;
  numericChapter: number | null;
  isEligibleForFree: boolean;
  unclassifiedReason: UnclassifiedReason | null;
  alternateTranslations: AlternateTranslationDto[];
}

export interface ChapterPageDto {
  pageNumber: number;
  imageUrl: string;
}

export interface ChapterManifestDto {
  provider: ProviderId;
  chapterId: string;
  mangaId: string;
  language: string;
  chapterNumber: string | null;
  volumeNumber: string | null;
  title: string;
  canonicalPosition: number | null;
  totalPages: number;
  pages: ChapterPageDto[];
  prevChapterId: string | null;
  nextChapterId: string | null;
  isDemo: boolean;
}

export interface PaginatedResult<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export interface SearchMangasParams {
  query?: string;
  tag?: string;
  language?: string;
  page?: number;
  limit?: number;
}

export interface ProviderDiagnosticsDto {
  provider: ProviderId;
  status: 'operational' | 'degraded' | 'unavailable';
  latencyMs: number;
  checkedAt: string;
  coverage: {
    sampleWorksCount: number;
    totalReportedBySource?: number;
    observedLanguages: string[];
    configuredLanguages: string[];
    contentFilter: 'safe';
    commercialPolicyNote: string;
  };
  errorMessage?: string;
}

export interface CatalogProvider {
  readonly providerId: ProviderId;
  searchMangas(params: SearchMangasParams): Promise<PaginatedResult<MangaSummaryDto>>;
  getTags(): Promise<MangaTagDto[]>;
  getMangaById(mangaId: string): Promise<MangaDetailDto>;
  getManyMangas(mangaIds: string[]): Promise<Map<string, MangaSummaryDto>>;
  getChapters(mangaId: string, language: string): Promise<{
    mangaId: string;
    language: string;
    availableLanguages: string[];
    chapters: CanonicalChapterDto[];
  }>;
  getChapterContext(chapterId: string): Promise<{
    chapter: CanonicalChapterDto;
    manga: MangaDetailDto;
    prevChapterId: string | null;
    nextChapterId: string | null;
  }>;
  getChapterManifest(chapterId: string): Promise<ChapterManifestDto>;
  getDiagnostics(): Promise<ProviderDiagnosticsDto>;
}
