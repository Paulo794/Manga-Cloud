import { useLoad } from '../hooks/useLoad';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import api from '../services/api';
import { errorMessage } from '../domain';
import type { Shelf, Page, Reference } from '../domain';
import { Notice, PrivateImage } from '../components/Common';
import { Pagination } from '../components/Pagination';
import { usePagination } from '../hooks/usePagination';
import { useSession } from '../hooks/useSession';

export function Shelves() {
  const { user } = useSession();
  const { page, setPage } = usePagination();
  const { data, loading, error } = useLoad<Page<Shelf>>(`/estantes?page=${page}&limit=20`);
  const [name, setName] = useState(''), [description, setDescription] = useState(''), [message, setMessage] = useState(''), [planRequired, setPlanRequired] = useState(false), [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const limit = user?.assinatura.limits?.estantesFree ?? 3;
  return <section><span className="eyebrow">UM ESPAÇO SÓ SEU</span><h1>Minhas estantes<span className="accent">.</span></h1><p className="muted">Organize suas leituras. Cada estante e sua capa são privadas.</p>
    <p className="muted">{user?.assinatura.isPro ? 'Plano Pro ativo: estantes pessoais ilimitadas.' : `Plano Free: ${data?.total ?? 0} de ${limit} estantes pessoais utilizadas. `} {!user?.assinatura.isPro && <Link to="/assinatura">Liberar estantes ilimitadas no Pro →</Link>}</p>
    <form className="surface inline-form" onSubmit={async e => { e.preventDefault(); setBusy(true); setMessage(''); setPlanRequired(false); try { const r = await api.post('/estantes', { nome: name, descricao: description }); navigate(`/estantes/${r.data.id}`); } catch (err) { setMessage(errorMessage(err)); setPlanRequired((err as { response?: { data?: { code?: string } } })?.response?.data?.code === 'PLAN_REQUIRED'); } finally { setBusy(false); } }}><label>Nome da estante<input required maxLength={100} value={name} onChange={e => setName(e.target.value)} placeholder="Ex.: Aventuras para o fim de semana" /></label><label>Descrição<input maxLength={1000} value={description} onChange={e => setDescription(e.target.value)} placeholder="O que você vai guardar aqui?" /></label><button className="button primary" disabled={busy}>{busy ? 'Criando…' : '+ Criar estante'}</button></form>
    {message && <Notice error>{message} {planRequired && <Link to="/assinatura">Assinar plano Pro →</Link>}</Notice>}{error && <Notice error>{error}</Notice>}{loading && <Notice>Carregando estantes…</Notice>}
    {!loading && data?.items.length === 0 && <Notice>Sua biblioteca começa com a primeira estante. Crie uma acima.</Notice>}
    <div className="shelf-grid">{data?.items.map(s => <Link className="shelf-card" to={`/estantes/${s.id}`} key={s.id}>{s.possuiCapa ? <PrivateImage url={`/estantes/${s.id}/capa`} alt={`Capa da estante ${s.nome}`} /> : <div className="shelf-art">▥<span>SUA ESTANTE</span></div>}<div><h2>{s.nome}</h2><p>{s.descricao || 'Uma coleção de próximas histórias.'}</p><small>{s.totalItens || 0} obras · Privada ↗</small></div></Link>)}</div>
    <Pagination page={page} total={data?.total} count={data?.items.length} busy={loading} onChange={setPage} label="Páginas de estantes" />
  </section>;
}
export function ShelfDetail() {
  const { id } = useParams(), navigate = useNavigate();
  const { page, setPage } = usePagination();
  const { data, loading, error, reload } = useLoad<Shelf & Page<Reference>>(`/estantes/${id}?page=${page}&limit=20`);
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [version, setVersion] = useState(0);
  const action = async (fn: () => Promise<unknown>) => { setBusy(true); setMessage(''); try { await fn(); reload(); setVersion(v => v + 1); setMessage('Alteração salva.'); } catch (e) { setMessage(errorMessage(e)); } finally { setBusy(false); } };
  if (loading) return <Notice>Carregando sua estante…</Notice>;
  if (!data) return <Notice error>{error || 'Estante não encontrada.'}</Notice>;
  return <section><Link className="back-link" to="/estantes">← Minhas estantes</Link><div className="section-heading"><div><span className="eyebrow">ESTANTE PRIVADA</span><h1>{data.nome}</h1></div><button className="danger" disabled={busy} onClick={async () => { if (!window.confirm('Excluir esta estante e seus itens? Seus favoritos serão mantidos.')) return; try { await api.delete(`/estantes/${id}`); navigate('/estantes'); } catch (e) { setMessage(errorMessage(e)); } }}>Excluir estante</button></div>
    <div className="shelf-editor surface"><div className="shelf-preview">{data.capa ? <PrivateImage url={`/estantes/${id}/capa?v=${version}`} alt={`Capa de ${data.nome}`} /> : <div className="image-placeholder">SUA CAPA</div>}<label className="file-button">Enviar capa<input disabled={busy} type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { const file = e.target.files?.[0]; if (!file) return; const body = new FormData(); body.append('capa', file); action(() => api.post(`/estantes/${id}/capa`, body)); e.target.value = ''; }} /></label><small>JPEG, PNG ou WebP · até 5 MiB</small>{data.capa && <button disabled={busy} onClick={() => action(() => api.delete(`/estantes/${id}/capa`))}>Remover capa</button>}</div><ShelfForm key={`${id}:${data.nome}:${data.descricao}`} shelf={data} busy={busy} onSave={(nome, descricao) => action(() => api.patch(`/estantes/${id}`, { nome, descricao }))} /></div>
    {message && <Notice>{message}</Notice>}<div className="section-heading"><h2>Obras da estante</h2><Link className="button" to="/catalogo">+ Adicionar pelo catálogo</Link></div>
    {data.items.length === 0 && <Notice>Esta estante ainda está vazia. Encontre uma obra no catálogo e adicione aqui.</Notice>}
    <div className="reference-list">{data.items.map(item => <article key={item.id}><div>{item.manga?.coverUrl && <img src={item.manga.coverUrl} alt="" loading="lazy" />}<div><h3>{item.manga ? <Link to={`/mangas/${item.provider}/${item.manga_id}`}>{item.manga.title}</Link> : 'Metadados temporariamente indisponíveis'}</h3><small>{item.provider === 'demo' ? 'Obra demonstrativa' : item.provider === 'anilist' ? 'AniList' : 'MangaDex'}</small></div></div><label>Posição<input type="number" min={0} max={1000000} defaultValue={item.ordem || 0} aria-label={`Posição de ${item.manga?.title || 'obra'}`} onBlur={e => { const value = Number(e.target.value); if (Number.isInteger(value) && value >= 0 && value !== item.ordem) action(() => api.patch(`/estantes/${id}/itens/${item.id}`, { ordem: value })); }} /></label><button disabled={busy} onClick={() => action(() => api.delete(`/estantes/${id}/itens/${item.id}`))}>Remover da estante</button></article>)}</div>
    <Pagination page={page} total={data.total} count={data.items.length} busy={busy} onChange={setPage} label="Páginas de obras da estante" />
  </section>;
}

function ShelfForm({ shelf, busy, onSave }: { shelf: Shelf; busy: boolean; onSave: (nome: string, descricao: string) => void }) {
  const [name, setName] = useState(shelf.nome), [description, setDescription] = useState(shelf.descricao || '');
  return <form onSubmit={event => { event.preventDefault(); onSave(name, description); }}><label>Nome<input required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label><label>Descrição<textarea aria-label="Descrição" maxLength={1000} rows={4} value={description} onChange={event => setDescription(event.target.value)} /></label><button className="button primary" disabled={busy}>Salvar estante</button></form>;
}
