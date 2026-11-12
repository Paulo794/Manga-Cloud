import sharp from 'sharp';
import { mangadexCatalogProvider, MangaSummaryDto, ProviderError } from '../providers';

const TTL_MS = 5 * 60 * 1000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Cover = { data: Buffer; mime: string; expiresAt: number };
const invalidImage = () => new ProviderError({ statusCode: 502, code: 'EXTERNAL_IMAGE_INVALID', provider: 'mangadex', message: 'A fonte não retornou uma capa válida.' });

// Somente capas provenientes de metadados safe. Não aceita URLs do navegador,
// não encaminha cookies/JWT e nunca grava catálogo ou imagens no storage.
export class MangaDexCovers {
  private readonly references = new Map<string, { url: string; expiresAt: number }>();
  private readonly images = new Map<string, Cover>();
  private readonly pending = new Map<string, Promise<Cover>>();
  private cacheBytes = 0;

  constructor(
    private readonly fetchImage: typeof fetch = fetch,
    private readonly resolveManga = (id: string) => mangadexCatalogProvider.getMangaById(id)
  ) {}

  present<T extends MangaSummaryDto>(manga: T): T {
    if (manga.provider !== 'mangadex' || !manga.coverUrl) return manga;
    if (manga.contentRating !== 'safe' || !UUID.test(manga.id)) throw invalidImage();
    const previous = this.references.get(manga.id);
    if (previous && previous.url !== manga.coverUrl) this.evict(manga.id);
    this.references.delete(manga.id);
    this.references.set(manga.id, { url: manga.coverUrl, expiresAt: Date.now() + TTL_MS });
    if (this.references.size > 256) this.references.delete(this.references.keys().next().value!);
    return { ...manga, coverUrl: `/api/mangas/mangadex/${manga.id}/capa` };
  }

  private evict(id: string) {
    const entry = this.images.get(id);
    if (entry) { this.cacheBytes -= entry.data.length; this.images.delete(id); }
  }

  async get(id: string): Promise<Cover> {
    if (!UUID.test(id)) throw new ProviderError({ statusCode: 400, code: 'INVALID_EXTERNAL_ID', provider: 'mangadex', message: 'Identificador de obra inválido.' });
    const cached = this.images.get(id);
    if (cached && cached.expiresAt > Date.now()) return cached;
    this.evict(id);
    const existing = this.pending.get(id);
    if (existing) return existing;
    if (this.pending.size >= 16) throw new ProviderError({ statusCode: 503, code: 'EXTERNAL_IMAGE_BUSY', provider: 'mangadex', message: 'Há capas em carregamento. Tente novamente.', retryAfterSeconds: 2 });
    const pending = this.load(id);
    this.pending.set(id, pending);
    try { return await pending; } finally { this.pending.delete(id); }
  }

  private async load(id: string): Promise<Cover> {
    let reference = this.references.get(id);
    if (!reference || reference.expiresAt <= Date.now()) {
      const manga = await this.resolveManga(id);
      if (manga.id !== id || manga.provider !== 'mangadex' || manga.contentRating !== 'safe') throw invalidImage();
      if (!manga.coverUrl) throw new ProviderError({ statusCode: 404, code: 'EXTERNAL_RESOURCE_NOT_FOUND', provider: 'mangadex', message: 'Obra sem capa disponível.' });
      this.present(manga);
      reference = this.references.get(id)!;
    }
    let url: URL;
    try { url = new URL(reference.url); } catch { throw invalidImage(); }
    if (url.origin !== 'https://uploads.mangadex.org' || url.username || url.password || url.search || url.hash ||
        !url.pathname.startsWith(`/covers/${id}/`) || !/^[a-z0-9._-]+\.256\.jpg$/i.test(url.pathname.slice(`/covers/${id}/`.length))) throw invalidImage();
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await this.fetchImage(url.href, { method: 'GET', redirect: 'error', headers: { Accept: 'image/jpeg,image/png,image/webp', 'User-Agent': 'MangaCloud-Academic-SaaS/1.0 (ISW055)' }, signal: controller.signal });
      try {
        if (response.status === 429) throw new ProviderError({ statusCode: 429, code: 'EXTERNAL_RATE_LIMIT', provider: 'mangadex', message: 'Limite da fonte atingido.', retryAfterSeconds: Math.min(300, Math.max(1, Number(response.headers.get('retry-after')) || 5)) });
        if (response.status === 404) throw new ProviderError({ statusCode: 404, code: 'EXTERNAL_RESOURCE_NOT_FOUND', provider: 'mangadex', message: 'Capa não encontrada na fonte.' });
        if (!response.ok) throw new ProviderError({ statusCode: 502, code: 'EXTERNAL_PROVIDER_ERROR', provider: 'mangadex', message: 'A fonte não forneceu a capa.' });
        const mime = response.headers.get('content-type')?.split(';')[0]?.trim();
        if (!mime || !['image/jpeg', 'image/png', 'image/webp'].includes(mime) || Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES || !response.body) throw invalidImage();
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > MAX_IMAGE_BYTES) throw invalidImage();
          chunks.push(Buffer.from(chunk));
        }
        const data = Buffer.concat(chunks);
        let metadata;
        try { metadata = await sharp(data, { limitInputPixels: 4_000_000, failOn: 'warning' }).metadata(); }
        catch { throw invalidImage(); }
        if ({ jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[metadata.format as string] !== mime || !metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) throw invalidImage();
        const result = { data, mime, expiresAt: Date.now() + TTL_MS };
        while ((this.cacheBytes + data.length > MAX_CACHE_BYTES || this.images.size >= 128) && this.images.size) this.evict(this.images.keys().next().value!);
        this.images.set(id, result); this.cacheBytes += data.length;
        return result;
      } finally { await response.body?.cancel().catch(() => {}); }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError({ statusCode: controller.signal.aborted ? 504 : 503, code: controller.signal.aborted ? 'EXTERNAL_PROVIDER_TIMEOUT' : 'EXTERNAL_PROVIDER_UNAVAILABLE', provider: 'mangadex', message: 'Capa temporariamente indisponível.' });
    } finally { clearTimeout(timer); }
  }
}

export const mangadexCovers = new MangaDexCovers();
