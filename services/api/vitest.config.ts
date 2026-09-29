import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    env: { INSPECTOR_SKIP_DOTENV: '1', NODE_NO_WARNINGS: '1' },
  },
});
