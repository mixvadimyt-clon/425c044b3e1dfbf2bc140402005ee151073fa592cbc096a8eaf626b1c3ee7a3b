import React from 'react';
import type { User, AuthState } from '@/shared/types';

interface AuthContextType extends AuthState {
  login: (token: string, user: User) => void;
  logout: () => void;
}

export const AuthContext = React.createContext<AuthContextType | null>(null);
