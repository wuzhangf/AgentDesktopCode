// Standalone bundle for the device gateway entry. Output mirrors the
// management-server packaging style: one ESM file, node builtins external.
import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await build({
  entryPoints: [resolve(root, 'src/gateway-main.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile: resolve(root, 'dist/device-gateway.mjs'),
  external: ['node:*'],
  banner: { js: '// Built by apps/device-gateway/scripts/build.mjs — do not edit.' },
});
