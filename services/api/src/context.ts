import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import type {} from '@fastify/jwt';
import type { AppConfig } from './config.js';
import type { Db } from './db/sqlite.js';
import { ApiError, forbidden } from './errors.js';
import type { Integration } from './modules/integration/index.js';
import type { MlflowClient } from './modules/mlops/mlflow.js';
import type { Orchestrator } from './modules/orchestrator.js';
import type { LocalStorage } from './modules/storage.js';
import type { ContractValidator } from './modules/validate.js';
import type { AuthUser, Role } from './types.js';

export interface AppContext {
  db: Db;
  config: AppConfig;
  storage: LocalStorage;
  orchestrator: Orchestrator;
  validator: ContractValidator;
  integration: Integration;
  mlflow: MlflowClient;
  log: FastifyBaseLogger;
}

export type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
export type Handlers = Record<string, Handler>;

declare module 'fastify' {
  interface FastifyRequest {
    /** Доп. сведения для журнала аудита, заполняются обработчиком. */
    audit?: { object_id?: string | null; entity_type?: string; entity_id?: string | null; details?: Record<string, unknown> };
    /** Строка журнала, записанная до действия; после ответа в неё дописывается итог. */
    auditId?: string;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; login: string; full_name: string; role: Role };
    user: { sub: string; login: string; full_name: string; role: Role };
  }
}

export function currentUser(req: FastifyRequest): AuthUser {
  const u = req.user;
  if (!u?.sub) throw new ApiError(401, 'UNAUTHORIZED', 'Требуется вход в систему');
  return { id: u.sub, login: u.login, full_name: u.full_name, role: u.role };
}

export function requireRole(req: FastifyRequest, ...roles: Role[]): AuthUser {
  const user = currentUser(req);
  if (!roles.includes(user.role)) throw forbidden();
  return user;
}

export function paging(query: { page?: number; page_size?: number }): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, Number(query.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Number(query.page_size ?? 50)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}
