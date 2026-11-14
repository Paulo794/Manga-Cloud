import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLoad } from '../hooks/useLoad';
import api from '../services/api';
import { errorMessage } from '../domain';
import type { Reference, Page } from '../domain';
import { Notice, MangaCard } from '../components/Common';
import { Pagination } from '../components/Pagination';
import { usePagination } from '../hooks/usePagination';

/** Listagens paginadas de favoritos e histórico de leitura da conta. */
export function References({ history = false }: { history?: boolean }) {
  const { page, setPage } = usePagination();
  const { data, loading, error, reload } = useLoad<Page<Reference>>(`/${history ? 'progresso' : 'favoritos'}?page=${page}`);
  const [message, setMessage] = useState('');

  return (
    <section>
      <span className="eyebrow">SUA BIBLIOTECA PESSOAL</span>
      <h1>{history ? 'Continue a aventura.' : 'Seus favoritos.'}</h1>
      {history && <p className="muted">O progresso automático é um recurso Pro. O histórico já salvo permanece na sua conta.</p>}
      {loading && <Notice>Carregando…</Notice>}
      {error && <Notice error>{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      {data?.items.length === 0 && <Notice>Ainda não há leituras aqui. <Link to="/catalogo">Explore o catálogo.</Link></Notice>}
      <div className="manga-grid">
        {data?.items.map(item => (
          <article key={item.id}>
            {item.manga ? <MangaCard manga={item.manga} /> : <div className="surface">Metadados temporariamente indisponíveis</div>}
            {history ? (
              <Link className="button" to={`/leitura/${item.provider}/${item.chapter_id}?pagina=${item.pagina}`}>
                Continuar da página {item.pagina} →
              </Link>
            ) : (
              <button
                onClick={async () => {
                  try {
                    await api.delete(`/favoritos/${item.provider}/${item.manga_id}`);
                    reload();
                  } catch (e) {
                    setMessage(errorMessage(e));
                  }
                }}
              >
                Remover favorito
              </button>
            )}
          </article>
        ))}
      </div>
      <Pagination
        page={page}
        total={data?.total}
        count={data?.items.length}
        busy={loading}
        onChange={setPage}
        label={history ? 'Páginas do histórico' : 'Páginas de favoritos'}
      />
    </section>
  );
}
