// Общие типы приложения

export type UserRole = 'INSPECTOR' | 'SUPERVISOR' | 'ADMIN' | 'ML_ENGINEER';

export interface User {
  id: string;
  login: string;
  full_name: string;
  role: UserRole;
}

export interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
}
