import { createContext } from 'react';
import type { User } from '../domain';

export interface Session {
  user: User | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => void;
}

export const SessionContext = createContext<Session | null>(null);
