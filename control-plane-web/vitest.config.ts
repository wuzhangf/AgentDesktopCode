import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom', '@tanstack/react-query'] },
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx,mts,mjs}', 'src/**/*.test.{ts,tsx}'],
    testTimeout: 20000,
  },
});
