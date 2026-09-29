import { rmSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { Db } from './sqlite.js';
import { seed } from './seed.js';

// Полный сброс локальных данных: БД и файлового хранилища.
const config = loadConfig();
for (const suffix of ['', '-wal', '-shm']) rmSync(config.dbPath + suffix, { force: true });
rmSync(config.storageDir, { recursive: true, force: true });
const db = new Db(config.dbPath);
db.migrate();
await seed(db, config);
db.close();
console.log(`БД пересоздана: ${config.dbPath}; хранилище очищено: ${config.storageDir}`);
