import type { Server } from 'node:http';

export declare const PACKAGE_META: string;

export interface RinMockOptions {
  packagesDir?: string;
  resultsDir?: string;
  token?: string;
  secret?: string;
  systemName?: string;
}

export type FailureMode = 'error' | 'timeout' | 'reject' | 'corrupt';

export interface ReceivedResult {
  key: string;
  receipt: Record<string, any>;
  result: Record<string, any>;
  signature: string | null;
}

export interface RinMockState {
  failures: FailureMode[];
  receipts: Map<string, Record<string, any>>;
  results: ReceivedResult[];
  requests: { method: string; path: string; at: string }[];
  failNext(mode: FailureMode, count?: number): void;
  reset(): void;
}

export interface RinMock {
  server: Server;
  state: RinMockState;
  listen(port?: number, host?: string): Promise<string>;
  close(): Promise<void>;
}

export declare function scanPackages(packagesDir: string | undefined): Record<string, any>[];
export declare function createRinMock(opts?: RinMockOptions): RinMock;
