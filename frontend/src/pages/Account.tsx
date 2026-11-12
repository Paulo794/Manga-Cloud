import { useLoad } from '../hooks/useLoad';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../services/api';
import { useSession } from '../hooks/useSession';
import { errorMessage } from '../domain';
import type { Reference, Page, Subscription } from '../domain';
import { Notice, MangaCard, PrivateImage } from '../components/Common';
import { Pagination } from '../components/Pagination';
import { usePagination } from '../hooks/usePagination';

export function References({ history = false }: { history?: boolean }) {
  const { page, setPage } = usePagination();
  const { data, loading, error, reload } = useLoad<Page<Reference>>(`/${history ? 'progresso' : 'favoritos'}?page=${page}`);
  const [message, setMessage] = useState('');
  return <section><span className="eyebrow">SUA BIBLIOTECA PESSOAL</span><h1>{history ? 'Continue a aventura.' : 'Seus favoritos.'}</h1>{history && <p className="muted">O progresso automático é um recurso Pro. O histórico já salvo permanece na sua conta.</p>}{loading && <Notice>Carregando…</Notice>}{error && <Notice error>{error}</Notice>}{message && <Notice>{message}</Notice>}{data?.items.length === 0 && <Notice>Ainda não há leituras aqui. <Link to="/catalogo">Explore o catálogo.</Link></Notice>}<div className="manga-grid">{data?.items.map(item => <article key={item.id}>{item.manga ? <MangaCard manga={item.manga} /> : <div className="surface">Metadados temporariamente indisponíveis</div>}{history ? <Link className="button" to={`/leitura/${item.provider}/${item.chapter_id}?pagina=${item.pagina}`}>Continuar da página {item.pagina} →</Link> : <button onClick={async () => { try { await api.delete(`/favoritos/${item.provider}/${item.manga_id}`); reload(); } catch (e) { setMessage(errorMessage(e)); } }}>Remover favorito</button>}</article>)}</div><Pagination page={page} total={data?.total} count={data?.items.length} busy={loading} onChange={setPage} label={history ? "Páginas do histórico" : "Páginas de favoritos"} /></section>;
}
export function Profile() {
  const { user, refresh } = useSession();
  const [bio, setBio] = useState(user?.bio || ''), [message, setMessage] = useState(''), [version, setVersion] = useState(0), [busy, setBusy] = useState(false);
  return <section><span className="eyebrow">SUAS INFORMAÇÕES</span><h1>Meu perfil<span className="accent">.</span></h1><div className="profile-grid"><div className="surface"><div className="avatar">{user?.avatar_url ? <PrivateImage url={`${user.avatar_url}?v=${version}`} alt="Seu avatar" /> : <span>{user?.nome.slice(0, 1).toUpperCase()}</span>}</div><h2>{user?.nome}</h2><p>{user?.email}</p><p className="badge">{user?.role} · {user?.assinatura.plano}</p><label className="file-button">Trocar avatar<input disabled={busy} type="file" accept="image/jpeg,image/png,image/webp" onChange={async e => { const file = e.target.files?.[0]; if (!file) return; const body = new FormData(); body.append('file', file); setBusy(true); try { await api.post('/profile/avatar', body); await refresh(); setVersion(v => v + 1); setMessage('Avatar atualizado.'); } catch (err) { setMessage(errorMessage(err)); } finally { setBusy(false); } }} /></label></div><form className="surface" onSubmit={async e => { e.preventDefault(); setBusy(true); try { await api.put('/profile', { bio }); await refresh(); setMessage('Perfil salvo.'); } catch (err) { setMessage(errorMessage(err)); } finally { setBusy(false); } }}><h2>Sobre você</h2><label>Biografia<textarea aria-label="Biografia" maxLength={1000} rows={6} value={bio} onChange={e => setBio(e.target.value)} placeholder="Conte um pouco sobre suas leituras favoritas." /></label><button className="button primary" disabled={busy}>Salvar biografia</button></form></div>{message && <Notice>{message}</Notice>}</section>;
}
export function Plans({ success = false }: { success?: boolean }) {
  const { user, refresh } = useSession(), { data, error: subscriptionError, reload } = useLoad<Subscription>(user ? '/assinatura' : null);
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const renewal = async (cancel: boolean) => {
    setBusy(true); setMessage('');
    try {
      const result = await api.post<Subscription>(cancel ? '/stripe/cancelar' : '/stripe/reativar');
      setConfirmCancel(false); reload(); await refresh();
      setMessage(cancel ? result.data.isPro ? 'Renovação cancelada. Seu Pro continua até o fim do período pago.' : 'Renovação cancelada.' : 'Renovação mantida. Sua assinatura continuará no próximo período.');
    } catch (error) { setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (!success || !user) return;
    let count = 0, stopped = false;
    const timer = window.setInterval(async () => {
      count++;
      try { const r = await api.get<Subscription>('/assinatura'); if (!stopped && r.data.isPro) { await refresh(); reload(); setMessage('Assinatura confirmada pelo servidor.'); window.clearInterval(timer); } }
      catch { if (!stopped) setMessage('Confirmação pendente. Tente atualizar em instantes.'); }
      if (count >= 15) window.clearInterval(timer);
    }, 2000);
    return () => { stopped = true; window.clearInterval(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [success, user?.id]);
  return <section><span className="eyebrow">CONHEÇA OS RECURSOS</span><h1>Um plano para explorar.</h1><Notice>Projeto acadêmico. O comparativo Free/Pro se aplica ao catálogo Demo. A leitura MangaDex disponível na fonte permanece gratuita.</Notice>{success && !data?.isPro && <Notice>Confirmando pagamento… O acesso depende da confirmação do servidor.</Notice>}{subscriptionError && <Notice error>{subscriptionError} <button onClick={reload}>Atualizar assinatura</button></Notice>}<div className="plans"><article className="surface"><span className="badge">FREE</span><h2>Sua biblioteca começa aqui.</h2><p>Crie estantes privadas, personalize capas e favorite suas obras.</p><ul><li>Catálogo e leitura MangaDex disponíveis</li><li>Estantes e favoritos</li><li>Três primeiras posições de capítulos no Demo</li></ul><Link className="button" to={user ? '/catalogo' : '/login?cadastro=1'}>Começar gratuitamente</Link></article><article className="surface pro-card"><span className="badge">PRO · DEMONSTRAÇÃO</span><h2>Continue de onde parou.</h2><p className="plan-price">R$ 9,90 <small>/mês</small></p><p>Experimente assinatura recorrente em ambiente de teste.</p><ul><li>Todos os capítulos do catálogo Demo</li><li>Progresso automático e retomada</li><li>Recursos de organização do Free</li></ul>{user ? <button className="button primary" disabled={busy || !data || data.canManageRenewal} onClick={async () => { setBusy(true); try { const r = await api.post('/stripe/checkout'); window.location.assign(r.data.url); } catch (e) { setMessage(errorMessage(e)); } finally { setBusy(false); } }}>{data?.isPro ? 'Pro ativo' : busy ? 'Preparando…' : 'Abrir checkout de teste →'}</button> : <Link className="button primary" to="/login">Entre para experimentar</Link>}</article></div>{data && <div className="surface"><h2>Sua assinatura</h2><p>Plano atual: {data.plano} · Status: {data.status}{data.acessoAte && ` · Vigência: ${new Date(data.acessoAte).toLocaleDateString('pt-BR')}`}</p>{data.canManageRenewal && <>{data.cancelAtPeriodEnd ? <><p>Cancelamento agendado. Não haverá renovação ao fim do período atual. Sua biblioteca e seu histórico serão preservados.</p>{data.status === 'active' && <button disabled={busy} onClick={() => renewal(false)}>Manter renovação</button>}</> : confirmCancel ? <div role="group" aria-label="Confirmar cancelamento"><p>Cancelar a renovação? {data.isPro && 'Você mantém o Pro até o fim do período pago. '}Suas estantes, favoritos e histórico serão preservados.</p><div className="actions"><button disabled={busy} onClick={() => renewal(true)}>Confirmar cancelamento</button><button disabled={busy} onClick={() => setConfirmCancel(false)}>Voltar</button></div></div> : <button disabled={busy} onClick={() => setConfirmCancel(true)}>Cancelar renovação</button>}</>}<button disabled={busy} onClick={async () => { reload(); try { await refresh(); } catch (error) { setMessage(errorMessage(error)); } }}>Atualizar assinatura</button></div>}{message && <Notice>{message}</Notice>}</section>;
}
