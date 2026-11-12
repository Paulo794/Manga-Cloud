import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { User } from '../domain';
import api from '../services/api';
import { SessionContext } from './SessionContext';

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(() => !!localStorage.getItem('token'));
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const token = localStorage.getItem('token'), revision = ++generation.current;
    if (!token) { setUser(null); setLoading(false); return; }
    try {
      const response = await api.get<User>('/profile');
      if (generation.current === revision && localStorage.getItem('token') === token) setUser(response.data);
    } finally {
      if (generation.current === revision) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const token = localStorage.getItem('token'), revision = ++generation.current;
    const expired = () => { ++generation.current; controller.abort(); setUser(null); setLoading(false); };
    window.addEventListener('session-expired', expired);
    if (token) {
      api.get<User>('/profile', { signal: controller.signal }).then(response => {
        if (!controller.signal.aborted && generation.current === revision && localStorage.getItem('token') === token) setUser(response.data);
      }).catch(() => {
        if (!controller.signal.aborted && generation.current === revision) setUser(null);
      }).finally(() => {
        if (!controller.signal.aborted && generation.current === revision) setLoading(false);
      });
    }
    return () => { controller.abort(); window.removeEventListener('session-expired', expired); };
  }, []);

  const logout = () => {
    ++generation.current;
    const token = localStorage.getItem('token');
    if (token) api.post('/auth/logout', {}, { headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    localStorage.removeItem('token'); localStorage.removeItem('usuario'); setUser(null); setLoading(false);
  };

  return <SessionContext.Provider value={{ user, loading, refresh, logout }}>{children}</SessionContext.Provider>;
}
