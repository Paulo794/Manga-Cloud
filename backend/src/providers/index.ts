import { anilistCatalogProvider } from './anilistProvider';
import { demoCatalogProvider } from './demoProvider';
import { mangadexCatalogProvider } from './mangadexProvider';
import { assertValidProvider, CatalogProvider, ProviderId } from './types';

export function getDefaultCatalogProvider(): ProviderId {
  const configured = process.env.CATALOG_PROVIDER?.trim().toLowerCase();
  if (configured === 'demo') return 'demo';
  if (configured === 'anilist') return 'anilist';
  return 'mangadex';
}

export function getCatalogProvider(rawProvider?: unknown, fallback?: ProviderId): CatalogProvider {
  const providerId = assertValidProvider(rawProvider, fallback ?? getDefaultCatalogProvider());
  if (providerId === 'demo') return demoCatalogProvider;
  if (providerId === 'anilist') return anilistCatalogProvider;
  return mangadexCatalogProvider;
}

export * from './types';
export * from './canonicalize';
export * from './anilistProvider';
export * from './demoProvider';
export * from './mangadexProvider';
