import { useContext } from 'react';
import { SessionContext } from '../context/SessionContext';

export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession deve ser usado dentro de SessionProvider.');
  return session;
}
