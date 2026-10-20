import type { components as Api } from './generated/api.js';
import type { components as Events } from './generated/events.js';
import type { components as Rin } from './generated/rin.js';

/** Типы REST-контракта (сгенерированы из contracts/dist/inspector-api.v1.json). */
export type S = Api['schemas'];
/** Типы сообщений api ⇄ ml (сгенерированы из contracts/dist/ml-events.v1.json). */
export type E = Events['schemas'];
/** Типы API внешней ИС (сгенерированы из contracts/dist/rin-external.v1.json). */
export type R = Rin['schemas'];

export type Role = S['UserRole'];
export type DocStage = S['DocStage'];
export type ProcessStatus = S['ProcessStatus'];
export type FindingStatus = S['FindingStatus'];

export interface AuthUser {
  id: string;
  login: string;
  full_name: string;
  role: Role;
}

export interface Envelope<P = unknown> {
  message_id: string;
  type: E['EventType'];
  schema_version: string;
  correlation_id: string;
  reply_to?: string | null;
  attempt?: number;
  created_at: string;
  payload: P;
}
