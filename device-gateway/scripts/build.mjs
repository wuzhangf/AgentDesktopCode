// Standalone bundles for the device gateway entries. Output mirrors the
// management-server packaging style: one ESM file, node builtins external.
import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['node:*'],
  banner: { js: '// Built by apps/device-gateway/scripts/build.mjs — do not edit.' },
};
await build({
  ...shared,
  entryPoints: [resolve(root, 'src/gateway-main.ts')],
  outfile: resolve(root, 'dist/device-gateway.mjs'),
});
await build({
  ...shared,
  entryPoints: [resolve(root, 'src/xagt-mcp-main.ts')],
  outfile: resolve(root, 'dist/xagt-mcp.mjs'),
});
