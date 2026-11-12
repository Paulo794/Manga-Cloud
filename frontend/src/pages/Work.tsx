import { useLoad } from '../hooks/useLoad';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useSession } from '../hooks/useSession';
import api from '../services/api';
import { errorMessage } from '../domain';
import type { Manga, Chapter, Shelf, Page } from '../domain';
import { Notice } from '../components/Common';
import { Pagination } from '../components/Pagination';
import { usePagination } from '../hooks/usePagination';
export default function Work() {
  const { provider, mangaId } = useParams(), { user } = useSession();
  const [params, setParams] = useSearchParams();
  const language = params.get('idioma') || 'pt-br';
  const { page: shelfPage, setPage: setShelfPage } = usePagination('estantesPagina');
  const { page: chapterPage, setPage: setChapterPage } = usePagination('capitulosPagina');
  const [shelf, setShelf] = useState(''), [message, setMessage] = useState('');
  const { data: manga, error, loading } = useLoad<Manga>(`/mangas/${provider}/${mangaId}`);
  const { data: chapters, error: chapterError, loading: chapterLoading } = useLoad<{ chapters: Chapter[]; availableLanguages: string[] }>(`/mangas/${provider}/${mangaId}/capitulos?idioma=${language}&plan=${user?.assinatura.isPro ? 'pro' : 'free'}`);
  const { data: shelves, loading: shelvesLoading, error: shelvesError } = useLoad<Page<Shelf>>(user ? `/estantes?page=${shelfPage}&limit=20` : null);
  const action = async (favorite: boolean) => {
    try { await api.post(favorite ? '/favoritos' : `/estantes/${shelf}/itens`, { provider, mangaId }); setMessage(favorite ? 'Adicionado aos favoritos.' : 'Obra adicionada à estante.'); }
    catch (e) { setMessage(errorMessage(e)); }
  };
  if (loading) return <Notice>Carregando obra…</Notice>;
  if (!manga) return <Notice error>{error || 'Obra indisponível.'}</Notice>;
  return <section><Link className="back-link" to={`/catalogo?provider=${provider}`}>← Voltar ao catálogo</Link><div className="work-layout"><div className="work-cover">{manga.coverUrl && <img src={manga.coverUrl} alt={`Capa de ${manga.title}`} />}<span className="badge">{manga.isDemo ? 'Obra demonstrativa' : 'MangaDex'}</span></div><div><span className="eyebrow">SUA PRÓXIMA LEITURA</span><h1>{manga.title}</h1><p className="muted">{manga.authors?.join(' · ')}</p><div className="tags">{manga.tags.map(t => <span key={t.id}>{t.name}</span>)}</div><p className="synopsis">{manga.synopsis}</p>{user ? <div className="actions"><button onClick={() => action(true)}>♡ Favoritar</button><select aria-label="Estante de destino" value={shelf} onChange={e => setShelf(e.target.value)}><option value="">Escolha uma estante</option>{shelves?.items.map(s => <option key={s.id} value={s.id}>{s.nome}</option>)}</select><button disabled={shelvesLoading || !shelves?.items.some(item => String(item.id) === shelf)} onClick={() => action(false)}>Adicionar à estante</button><Link to="/estantes">Criar estante</Link></div> : <Link className="button primary" to="/login">Entre para ler e organizar</Link>}{message && <Notice>{message}</Notice>}</div></div>
    {user && <><Pagination page={shelfPage} total={shelves?.total} count={shelves?.items.length} busy={shelvesLoading} onChange={value => { setShelf(''); setShelfPage(value); }} label="Páginas de estantes de destino" />{shelvesError && <Notice error>{shelvesError}</Notice>}</>}
    <div className="section-heading"><h2>Capítulos</h2><label>Idioma<select aria-label="Idioma da obra" value={language} onChange={e => { const next = new URLSearchParams(params); next.set('idioma', e.target.value); next.delete('capitulosPagina'); setParams(next); }}>{[...new Set(['pt-br', ...manga.availableLanguages])].map(l => <option key={l} value={l}>{l === 'pt-br' ? 'Português (BR)' : l}</option>)}</select></label></div>
    {chapterLoading && <Notice>Buscando capítulos…</Notice>}{chapterError && <Notice error>{chapterError}</Notice>}{chapters?.chapters.length === 0 && <Notice>Não há capítulos neste idioma. Escolha outro idioma disponível.</Notice>}
    <div className="chapter-list">{chapters?.chapters.slice((chapterPage - 1) * 50, chapterPage * 50).map(ch => <Link key={ch.id} to={user ? `/leitura/${provider}/${ch.id}` : '/login'}><div><strong>{ch.volumeNumber ? `Vol. ${ch.volumeNumber} · ` : ''}{ch.chapterNumber === null ? 'Especial' : `Capítulo ${ch.chapterNumber}`}</strong><span>{ch.title}</span><small>{ch.scanlationGroup}</small></div><span className="badge">{ch.externalUrl ? 'Fonte externa' : ch.bloqueadoParaFree && !user?.assinatura.isPro ? '🔒 Pro · Demo' : 'Ler →'}</span></Link>)}</div>
    <Pagination page={chapterPage} limit={50} total={chapters?.chapters.length} busy={chapterLoading} onChange={setChapterPage} label="Páginas de capítulos" />
    {provider === 'mangadex' && <p className="muted">Conteúdo fornecido por MangaDex e pelos grupos de tradução creditados acima. Nenhuma página é armazenada no MangaCloud.</p>}
  </section>;
}
