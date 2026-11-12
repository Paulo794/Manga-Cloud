import { useLoad } from '../hooks/useLoad';
import { useState } from 'react';
import { useSession } from '../hooks/useSession';
import { Notice } from '../components/Common';
import api from '../services/api';
import { errorMessage } from '../domain';
import type { Page, User } from '../domain';
import { Pagination } from '../components/Pagination';
import { usePagination } from '../hooks/usePagination';
export function Curator() {
  const { data, loading, error, reload } = useLoad<{ providers: { provider: string; status: string; latencyMs: number; checkedAt: string }[]; cleanup: { status: string; total: number }[] }>('/curadoria/integracao');
  return <section><span className="eyebrow">CURADORIA</span><h1>Saúde das fontes.</h1><p>Disponibilidade técnica do catálogo e das rotinas de limpeza.</p><button onClick={reload}>Atualizar diagnóstico</button>{loading && <Notice>Verificando fontes…</Notice>}{error && <Notice error>{error}</Notice>}<div className="feature-grid">{data?.providers.map(p => <article key={p.provider}><span className="badge">{p.provider}</span><h2>{p.status === 'operational' ? 'Disponível' : 'Indisponível'}</h2><p>Consulta em {p.latencyMs} ms</p><small>{new Date(p.checkedAt).toLocaleString('pt-BR')}</small></article>)}</div>{data && <div className="surface"><h2>Limpeza de arquivos</h2>{data.cleanup.length ? data.cleanup.map(q => <p key={q.status}>{q.status}: {q.total}</p>) : <p>Nenhuma remoção pendente.</p>}</div>}</section>;
}
export function Admin() {
  const { user } = useSession();
  const { page, setPage } = usePagination();
  const { data, error, loading, reload } = useLoad<Page<User>>(`/admin/usuarios?page=${page}&limit=20`);
  const { data: logs, error: logError, reload: reloadLogs } = useLoad<{ eventos: { id: string; usuario_id: number | null; acao: string; recurso?: string; resultado: string; timestamp?: string }[] }>('/admin/logs');
  const [message, setMessage] = useState('');
  return <section><span className="eyebrow">ADMINISTRAÇÃO</span><h1>Pessoas e atividade.</h1>{error && <Notice error>{error}</Notice>}{message && <Notice>{message}</Notice>}<div className="surface table-wrap"><table><thead><tr><th>Nome</th><th>Email</th><th>Papel</th></tr></thead><tbody>{data?.items.map(u => <tr key={u.id}><td>{u.nome}</td><td>{u.email}</td><td><select aria-label={`Papel de ${u.nome}`} value={u.role} disabled={u.id === user?.id} onChange={async e => { try { await api.patch(`/admin/usuarios/${u.id}/papel`, { papel: e.target.value }); reload(); setMessage('Papel atualizado. A permissão vale nas próximas chamadas.'); } catch (err) { setMessage(errorMessage(err)); } }}><option value="leitor">Leitor</option><option value="curador">Curador</option><option value="admin">Admin</option></select></td></tr>)}</tbody></table></div><Pagination page={page} total={data?.total} count={data?.items.length} busy={loading} onChange={setPage} label="Páginas de usuários" /><div className="section-heading"><h2>Auditoria</h2><button onClick={reloadLogs}>Atualizar eventos</button></div>{logError && <Notice error>{logError}</Notice>}<div className="surface table-wrap"><table><thead><tr><th>Quando</th><th>Ator</th><th>Ação</th><th>Recurso</th><th>Resultado</th></tr></thead><tbody>{logs?.eventos?.map((e, index) => <tr key={e.id || index}><td>{e.timestamp ? new Date(e.timestamp).toLocaleString('pt-BR') : '—'}</td><td>{e.usuario_id ?? 'Anônimo'}</td><td>{e.acao}</td><td>{e.recurso || '—'}</td><td>{e.resultado}</td></tr>)}</tbody></table></div></section>;
}
