import type { UserRole } from './types';

/** Название роли для кнопок входа и смены роли. */
export const ROLE_LABEL: Record<UserRole, string> = {
  INSPECTOR: 'Инспектор',
  SUPERVISOR: 'Супервизор',
  ADMIN: 'Администратор',
  ML_ENGINEER: 'ML-инженер',
};
