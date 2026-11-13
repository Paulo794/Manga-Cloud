import { useLoad } from '../hooks/useLoad';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Notice } from '../components/Common';
import { useSession } from '../hooks/useSession';
import { useReadingProgress } from '../hooks/useReadingProgress';
import api from '../services/api';
import { errorMessage } from '../domain';
import type { Manifest } from '../domain';

export default function Reader() {
  const { provider = '', chapterId = '' } = useParams(), { user } = useSession(), [params] = useSearchParams();
  return <ReaderSession key={`${provider}:${chapterId}:${user?.id}:${user?.assinatura.isPro}:${params.get('pagina')}`} provider={provider} chapterId={chapterId} userId={user?.id ?? 0} pro={user?.assinatura.isPro === true} initialPage={params.has('pagina') ? Number(params.get('pagina')) : undefined} />;
}

function ReaderSession({ provider, chapterId, userId, pro, initialPage }: { provider: string; chapterId: string; userId: number; pro: boolean; initialPage?: number }) {
  const navigate = useNavigate();
  const url = `/leitura/${provider}/${chapterId}/manifesto`;
  const { data: original, loading, error, reload } = useLoad<Manifest>(url);
  const [refreshed, setRefreshed] = useState<Manifest | null>(null), [imageError, setImageError] = useState(false);
  const [retryError, setRetryError] = useState(''), [retrying, setRetrying] = useState(false), [attempt, setAttempt] = useState(0);
  const data = refreshed ?? original;
  const progress = useReadingProgress(data, provider, userId, pro, initialPage);
  const { page, ready, message, failed, changePage, flush } = progress;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!data || !ready || (event.target instanceof HTMLElement && (event.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)))) return;
      if (event.key === 'ArrowRight') { event.preventDefault(); changePage(page + 1); setImageError(false); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); changePage(page - 1); setImageError(false); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [data, ready, page, changePage]);
  const goToPage = (value: number) => { changePage(value); setImageError(false); setRetryError(''); };
  const changeChapter = async (id: string) => { await flush(); navigate(`/leitura/${provider}/${id}`); };
  const retry = async () => {
    setRetrying(true); setRetryError('');
    try { const response = await api.get<Manifest>(url); setRefreshed(response.data); setAttempt(value => value + 1); setImageError(false); }
    catch (failure) { setRetryError(errorMessage(failure)); }
    finally { setRetrying(false); }
  };
  if (loading) return <Notice>Preparando seu capítulo…</Notice>;
  if (!data) return <section className="reader-empty"><h1>Não foi possível abrir este capítulo.</h1><Notice error>{error}</Notice>{provider === 'demo' && <Link className="button primary" to="/assinatura">Conhecer o Pro demonstrativo</Link>}<button onClick={reload}>Tentar novamente</button><Link to={`/catalogo?provider=${provider}`}>Voltar ao catálogo</Link></section>;
  const image = data.pages[page - 1];
  return <section className="reader"><div className="reader-toolbar"><Link to={`/mangas/${provider}/${data.mangaId}?idioma=${encodeURIComponent(data.language)}`}>← Obra</Link><strong>{data.title}</strong><span className="badge">{data.isDemo ? 'DEMO' : provider === 'anilist' ? 'ANILIST · PRÉVIA' : 'MANGADEX'}</span></div><div className="reader-controls"><button disabled={!ready || page <= 1} onClick={() => goToPage(page - 1)}>← Página anterior</button><label>Página<select aria-label="Página atual" disabled={!ready} value={page} onChange={event => goToPage(Number(event.target.value))}>{data.pages.map(p => <option key={p.pageNumber} value={p.pageNumber}>{p.pageNumber} de {data.totalPages}</option>)}</select></label><button disabled={!ready || page >= data.totalPages} onClick={() => goToPage(page + 1)}>Próxima página →</button></div>
    {imageError ? <Notice error>A página não carregou. <button disabled={retrying} onClick={retry}>{retrying ? 'Atualizando…' : 'Atualizar páginas'}</button>{retryError && <p>{retryError}</p>}</Notice> : image && <img className="reader-page" key={`${image.imageUrl}:${attempt}`} src={image.imageUrl} alt={`${data.title}, página ${page}`} onError={() => setImageError(true)} />}
    {failed ? <Notice error>{message} <button onClick={progress.reload}>Recarregar progresso</button></Notice> : <p className="muted reader-status">{pro ? message : 'Leitura Free · o progresso automático faz parte da demonstração Pro.'}</p>}
    <div className="reader-controls"><button disabled={!ready || !data.prevChapterId} onClick={() => data.prevChapterId && changeChapter(data.prevChapterId)}>← Capítulo anterior</button><span>{page} / {data.totalPages}</span><button disabled={!ready || !data.nextChapterId} onClick={() => data.nextChapterId && changeChapter(data.nextChapterId)}>Próximo capítulo →</button></div>
  </section>;
}
