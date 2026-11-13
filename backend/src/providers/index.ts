import { demoCatalogProvider } from './demoProvider';
import { mangadexCatalogProvider } from './mangadexProvider';
import { assertValidProvider, CatalogProvider, ProviderId } from './types';

export function getDefaultCatalogProvider(): ProviderId {
  return process.env.CATALOG_PROVIDER === 'demo' ? 'demo' : 'mangadex';
}

export function getCatalogProvider(rawProvider: unknown, fallback?: ProviderId): CatalogProvider {
  const defaultProvider: ProviderId = fallback ?? getDefaultCatalogProvider();
  const providerId = assertValidProvider(rawProvider, defaultProvider);
  return providerId === 'demo' ? demoCatalogProvider : mangadexCatalogProvider;
}

export * from './types';
export * from './canonicalize';
export * from './demoProvider';
export * from './mangadexProvider';
