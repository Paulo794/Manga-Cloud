import { useLoad } from '../hooks/useLoad';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MangaCard, Notice } from '../components/Common';
import type { Manga, Page } from '../domain';

type CatalogProviderName = 'demo' | 'mangadex';

export default function Catalog() {
  const [params, setParams] = useSearchParams();
  const rawProvider = params.get('provider');
  const explicitProvider: CatalogProviderName | null = rawProvider === 'demo' || rawProvider === 'mangadex' ? rawProvider : null;
  const hasExplicitProvider = explicitProvider !== null;
  const [fallbackToDemo, setFallbackToDemo] = useState(false);
  const { data: config, error: configError, loading: configLoading } = useLoad<{ defaultProvider: CatalogProviderName }>(
    !hasExplicitProvider ? '/mangas/config' : null
  );
  const provider: CatalogProviderName | null = explicitProvider ?? (fallbackToDemo ? 'demo' : (config?.defaultProvider ?? (configError ? 'demo' : null)));
  const page = Number(params.get('page') || 1);
  const [query, setQuery] = useState(params.get('q') || '');
  const language = params.get('idioma') || 'pt-br', tag = params.get('tag') || '';
  const url = provider
    ? `/mangas?provider=${provider}&q=${encodeURIComponent(params.get('q') || '')}&idioma=${language}&tag=${encodeURIComponent(tag)}&page=${page}&limit=12`
    : null;
  const { data, error, loading, reload } = useLoad<Page<Manga> & { hasMore: boolean }>(url, {
    onError: () => {
      if (!hasExplicitProvider && provider === 'mangadex') {
        setFallbackToDemo(true);
      }
    },
  });
  const { data: tags } = useLoad<{ id: string; name: string }[]>(provider ? `/mangas/tags?provider=${provider}` : null);
  const isLoading = (!hasExplicitProvider && configLoading) || loading;
  const update = (key: string, value: string) => { const next = new URLSearchParams(params); next.set(key, value); if (key !== 'page') next.set('page', '1'); setParams(next); };
  const switchToMangadex = () => { setFallbackToDemo(false); const next = new URLSearchParams(params); next.set('provider', 'mangadex'); setParams(next); };
  return <section><span className="eyebrow">ENCONTRE SUA PRÓXIMA HISTÓRIA</span><h1>Explore o catálogo<span className="accent">.</span></h1>
    <form className="filters" onSubmit={e => { e.preventDefault(); update('q', query); }}><label className="search-field">Buscar obra<input value={query} onChange={e => setQuery(e.target.value)} placeholder="Qual história você procura?" maxLength={150} /></label><label>Fonte<select aria-label="Fonte" value={provider ?? 'mangadex'} onChange={e => { setFallbackToDemo(false); const next = new URLSearchParams(); next.set('provider', e.target.value); setParams(next); setQuery(''); }}><option value="mangadex">MangaDex real</option><option value="demo">Catálogo Demo</option></select></label><label>Idioma<select aria-label="Idioma" value={language} onChange={e => update('idioma', e.target.value)}><option value="pt-br">Português (BR)</option><option value="en">Inglês</option></select></label><label>Gênero<select aria-label="Gênero" value={tag} onChange={e => update('tag', e.target.value)}><option value="">Todos</option>{tags?.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label><button className="button primary">Buscar</button></form>
    <p className="muted">{provider === 'demo' ? 'Demonstração identificada: obras sintéticas, com limite Free para testar o paywall.' : 'Obras e páginas fornecidas pelo MangaDex. A disponibilidade varia por obra e idioma.'}</p>
    {fallbackToDemo && !hasExplicitProvider && <Notice>MangaDex indisponível nesta rede; exibindo o catálogo Demo automaticamente. <button type="button" onClick={switchToMangadex}>Tentar MangaDex</button></Notice>}
    {isLoading && <Notice>Buscando histórias…</Notice>}{error && <Notice error>{error} <button type="button" onClick={reload}>Tentar novamente</button>{provider === 'mangadex' && <button type="button" onClick={() => setParams({ provider: 'demo' })}>Abrir demonstração</button>}</Notice>}
    {!isLoading && !error && data?.items.length === 0 && <Notice>Nenhuma obra encontrada neste filtro.</Notice>}
    <div className="manga-grid">{data?.items.map(m => <MangaCard key={`${m.provider}:${m.id}`} manga={m} />)}</div>
    <div className="pagination"><button disabled={page <= 1} onClick={() => update('page', String(page - 1))}>← Anterior</button><span>Página {page}</span><button disabled={!data?.hasMore} onClick={() => update('page', String(page + 1))}>Próxima →</button></div>
  </section>;
}
