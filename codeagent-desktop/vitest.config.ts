import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // Resolve from the package working directory so both Vitest's bundled
      // and runner config loaders behave consistently in the CommonJS app.
      '@codeagent/protocol': path.resolve(process.cwd(), 'packages/protocol/src/index.ts')
    }
  },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 20000,
    hookTimeout: 20000
  }
});
