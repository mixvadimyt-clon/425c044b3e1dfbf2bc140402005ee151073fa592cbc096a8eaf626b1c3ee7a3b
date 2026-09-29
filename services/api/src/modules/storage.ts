import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Локальное файловое хранилище (замена S3/MinIO в локальном режиме).
 * Ключи совпадают со схемой S3: raw/{sha256}, parsed/..., protocols/...
 * S3Ref для ml: { bucket: "local", key } → путь {STORAGE_DIR}/{key}.
 */
export class LocalStorage {
  readonly bucket = 'local';

  constructor(readonly root: string) {
    mkdirSync(path.join(root, 'raw'), { recursive: true });
    mkdirSync(path.join(root, 'tmp'), { recursive: true });
  }

  tmpPath(name: string): string {
    return path.join(this.root, 'tmp', name);
  }

  pathOf(key: string): string {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error(`Недопустимый ключ хранилища: ${key}`);
    return p;
  }

  exists(key: string): boolean {
    return existsSync(this.pathOf(key));
  }

  /** Переместить временный файл под ключ; если такой уже есть (тот же sha256) — просто удалить временный. */
  commit(tmpFile: string, key: string): void {
    const target = this.pathOf(key);
    if (existsSync(target)) {
      rmSync(tmpFile, { force: true });
      return;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    renameSync(tmpFile, target);
  }

  stream(key: string) {
    return createReadStream(this.pathOf(key));
  }

  size(key: string): number {
    return statSync(this.pathOf(key)).size;
  }

  ref(key: string): { bucket: string; key: string } {
    return { bucket: this.bucket, key };
  }
}
