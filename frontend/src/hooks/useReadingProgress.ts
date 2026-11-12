import { useEffect, useRef, useState } from 'react';
import type { Manifest } from '../domain';
import { errorMessage } from '../domain';

// Trocar de capítulo aguarda o último save da mesma obra/idioma nesta aba.
// Conflitos entre abas continuam decididos pelo servidor via revisão.
const queues = new Map<string, Promise<void>>();
function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
  const operation = (queues.get(key) ?? Promise.resolve()).then(work);
  const settled = operation.then(() => {}, () => {});
  queues.set(key, settled);
  void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
  return operation;
}
interface Progress { chapter_id: string; pagina: number; revisao: number; }
interface Session { page: number; ready: boolean; paused: boolean; lastSaved: number | null; flush: () => Promise<void>; }

export function useReadingProgress(manifest: Manifest | null, provider: string, userId: number, pro: boolean, initialPage?: number) {
  const [page, setPage] = useState(1), [ready, setReady] = useState(false);
  const [message, setMessage] = useState(''), [failed, setFailed] = useState(false), [version, setVersion] = useState(0);
  const current = useRef<Session | null>(null);
  useEffect(() => {
    if (!manifest) return;
    let active = true;
    const token = localStorage.getItem('token');
    const key = `${userId}:${provider}:${manifest.mangaId}:${manifest.language}`;
    const url = `/api/progresso/${provider}/${manifest.mangaId}`;
    const clamp = (n: number) => Number.isInteger(n) && n >= 1 && n <= manifest.totalPages ? n : 1;
    let revision = 0;
    const requested = version === 0 && initialPage !== undefined ? clamp(initialPage) : undefined;
    const state: Session = { page: requested ?? 1, ready: false, paused: false, lastSaved: null, flush: async () => {} };
    current.current = state;
    setReady(false); setFailed(false); setMessage('Carregando progresso…');
    async function request(method: 'GET' | 'PUT', body?: object) {
      const response = await fetch(method === 'GET' ? `${url}?idioma=${encodeURIComponent(manifest!.language)}` : url, {
        method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body), keepalive: true } : {}), signal: AbortSignal.timeout(10000)
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 401 && localStorage.getItem('token') === token) {
          localStorage.removeItem('token'); window.dispatchEvent(new Event('session-expired'));
        }
        throw { response: { status: response.status, data } };
      }
      return data as Progress;
    }
    state.flush = () => {
      if (!pro || !state.ready || state.paused) return Promise.resolve();
      const savingPage = state.page;
      return serialize(key, async () => {
        if (state.paused || state.lastSaved === savingPage) return;
        const saved = await request('PUT', { chapterId: manifest.chapterId, idioma: manifest.language, pagina: savingPage, revisaoEsperada: revision });
        revision = saved.revisao; state.lastSaved = savingPage;
        if (active) setMessage(state.page === savingPage ? 'Progresso salvo.' : 'Salvando…');
      }).catch(error => {
        state.paused = true;
        if (active) { setFailed(true); setMessage(errorMessage(error)); }
      });
    };
    if (!pro) { state.ready = true; setPage(state.page); setReady(true); }
    else void serialize(key, async () => {
      let saved: Progress | null = null;
      try { saved = await request('GET'); }
      catch (error) { if ((error as { response?: { status: number } }).response?.status !== 404) throw error; }
      if (!active) return;
      revision = saved?.revisao ?? 0;
      if (requested === undefined && saved?.chapter_id === manifest.chapterId) state.page = clamp(saved.pagina);
      if (saved?.chapter_id === manifest.chapterId && saved.pagina === state.page) state.lastSaved = state.page;
      state.ready = true; setPage(state.page); setReady(true);
      setMessage(state.lastSaved === state.page ? 'Progresso salvo.' : 'Salvando…');
    }).catch(error => {
      state.paused = true;
      if (active) { setFailed(true); setMessage(`Não foi possível carregar o progresso. ${errorMessage(error)}`); }
    });
    const hidden = () => { if (document.visibilityState === 'hidden') void state.flush(); };
    const leaving = () => { void state.flush(); };
    document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', leaving);
    return () => {
      active = false; document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', leaving);
      void state.flush();
    };
    // Atualizar URLs de imagens do mesmo capítulo não altera página/revisão.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest?.chapterId, provider, userId, pro, initialPage, version]);
  useEffect(() => {
    if (!ready || !pro) return;
    const state = current.current;
    const timer = window.setTimeout(() => { void state?.flush(); }, 800);
    return () => window.clearTimeout(timer);
  }, [page, ready, pro, version]);
  const changePage = (next: number) => {
    const state = current.current;
    if (!manifest || !state?.ready || !Number.isInteger(next)) return;
    const value = Math.max(1, Math.min(manifest.totalPages, next));
    state.page = value; setPage(value);
    if (pro && !state.paused) setMessage(state.lastSaved === value ? 'Progresso salvo.' : 'Salvando…');
  };
  return { page, ready, message, failed, changePage, flush: () => current.current?.flush() ?? Promise.resolve(), reload: () => setVersion(v => v + 1) };
}
