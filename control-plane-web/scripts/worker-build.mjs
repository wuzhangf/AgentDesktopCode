import { build } from 'vite';
import { resolve } from 'node:path';

await build();
await build({ configFile: false, publicDir: false, build: {
  ssr: resolve('server/worker-main.ts'), outDir: '.local/worker-server', emptyOutDir: true,
  rollupOptions: { output: { entryFileNames: 'worker-server.mjs' } },
} });
