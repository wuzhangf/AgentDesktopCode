import { build } from 'vite';
import { resolve } from 'node:path';

await build();
await build({ configFile: false, publicDir: false, build: {
  ssr: resolve('server/management/management-main.ts'), outDir: '.local/management-server', emptyOutDir: true,
  rollupOptions: { output: { entryFileNames: 'management-server.mjs' } },
} });
// ReaderPool resolves worker.mjs beside the bundled management entry.
await build({ configFile: false, publicDir: false, build: {
  ssr: resolve('server/db/worker.mjs'), outDir: '.local/management-server', emptyOutDir: false,
  rollupOptions: { output: { entryFileNames: 'worker.mjs' } },
} });
