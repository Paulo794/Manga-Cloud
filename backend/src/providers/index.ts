import { demoCatalogProvider } from './demoProvider';
import { mangadexCatalogProvider } from './mangadexProvider';
import { assertValidProvider, CatalogProvider, ProviderId } from './types';

export function getCatalogProvider(rawProvider: unknown, fallback?: ProviderId): CatalogProvider {
  const defaultProvider: ProviderId =
    fallback ?? (process.env.CATALOG_PROVIDER === 'demo' ? 'demo' : 'mangadex');
  const providerId = assertValidProvider(rawProvider, defaultProvider);
  return providerId === 'demo' ? demoCatalogProvider : mangadexCatalogProvider;
}

export * from './types';
export * from './canonicalize';
export * from './demoProvider';
export * from './mangadexProvider';
