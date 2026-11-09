/**
 * Applies Electron fuses to the local Electron binary (design §6.2):
 * disables unused Node/CLI capabilities. Run after dependency install and
 * again after any electron upgrade:
 *   corepack pnpm apply:fuses
 * A packaged build re-applies fuses on the packaged binary (EW11).
 */
import { flipFuses, FuseV1Options, FuseVersion, getCurrentFuseWire } from '@electron/fuses';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const electronBinary = process.platform === 'win32'
  ? path.resolve(here, '..', 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.resolve(here, '..', 'node_modules', 'electron', 'dist', 'Electron');

const result = await flipFuses(electronBinary, {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  [FuseV1Options.OnlyLoadAppFromAsar]: false
});

if (!result) {
  console.error('fuse flipping reported failure; the binary may be unsupported');
  process.exit(1);
}

const wire = await getCurrentFuseWire(electronBinary);
console.log('current fuse wire:', JSON.stringify(wire));
const runAsNode = wire[Symbol.for('runAsNode')] ?? wire.runAsNode;
if (runAsNode === true) {
  console.error('RunAsNode fuse is still enabled; refusing to continue');
  process.exit(1);
}
console.log(`fuses applied to ${electronBinary}`);
