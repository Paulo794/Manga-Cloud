export function Pagination({ page, limit = 20, total, count = 0, busy = false, onChange, label = 'Paginação' }: { page: number; limit?: number; total?: number; count?: number; busy?: boolean; onChange: (page: number) => void; label?: string }) {
  const last = total === undefined ? undefined : Math.max(1, Math.ceil(total / limit));
  return <nav className="pagination" aria-label={label}>
    <button disabled={busy || page <= 1} onClick={() => onChange(page - 1)}>← Anterior</button>
    <span>Página {page}{last !== undefined && ` de ${last}`}</span>
    <button disabled={busy || (last === undefined ? count < limit : page >= last)} onClick={() => onChange(page + 1)}>Próxima →</button>
  </nav>;
}
