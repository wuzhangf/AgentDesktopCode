// W1-A personal Web relocatable runtime payload (design doc:
// worker-multicore-windows-distribution-detailed-design-2026-10-19 §5.2/§6.1).
//
// Runs the management build, then emits a self-contained directory that the EDC
// assembler later places at releases/<releaseId>/payload/web/:
//
//   <out>/dist/                          vite SPA dist (index/personal/worker.html + assets)
//   <out>/server/management-server.mjs   management console bundle
//   <out>/server/worker.mjs              reader-pool worker (resolved beside the bundle)
//   <out>/server/node_modules/<dep>/     external npm dependency closure (decimal.js today)
//   <out>/server/package.json            module type + version, read by consoleVersion
//   <out>/payload-manifest.json          per-file sha256 + size, personal-web-payload/1
//
// appRoot stays "two levels above the bundle dir" (management-main.ts), so in
// the installed layout it resolves to releases/<releaseId>/payload/ and the
// installer MUST pin absolute PERSONAL_CONSOLE_DIST / PERSONAL_CONSOLE_ROOT /
// PERSONAL_DATA_DIR — the launch contract, not something this payload fakes.
//
// Usage:
//   node scripts/package-personal-runtime.mjs [-OutDir <dir>] [-SkipBuild] [-Force]
// Defaults: -OutDir <app>/.local/personal-runtime. A non-empty output dir is
// refused unless -Force is given (sealed candidates are never overwritten).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_OUT = join(appDir, '.local', 'management-server');
const BUNDLES = ['management-server.mjs', 'worker.mjs'];
const NODE_MIN = '22.13.0'; // node:sqlite DatabaseSync

function fail(msg) { console.error(`package-personal-runtime: ${msg}`); process.exit(1); }

function parseArgs(argv) {
  const opts = { outDir: null, skipBuild: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const m = /^-{1,2}([^=]+?)(?:=(.*))?$/.exec(argv[i]);
    if (!m) fail(`unrecognized argument '${argv[i]}' (use -OutDir <dir> | -SkipBuild | -Force)`);
    const key = m[1].toLowerCase();
    if (key === 'outdir') {
      const value = m[2] ?? argv[++i];
      if (!value) fail('-OutDir requires a directory argument');
      opts.outDir = value;
    } else if (key === 'skipbuild') opts.skipBuild = true;
    else if (key === 'force') opts.force = true;
    else fail(`unknown option '-${m[1]}'`);
  }
  return opts;
}

// --- 1. management build ------------------------------------------------------
const opts = parseArgs(process.argv.slice(2));
if (!opts.skipBuild) {
  const r = spawnSync(process.execPath, [join('scripts', 'management-build.mjs')], { cwd: appDir, stdio: 'inherit' });
  if (r.status !== 0) fail(`management-build exited ${r.status ?? r.error}`);
}
const distDir = join(appDir, 'dist');
if (!existsSync(join(distDir, 'index.html'))) fail(`${distDir} missing — run scripts/management-build.mjs first (or drop -SkipBuild)`);
for (const b of BUNDLES) if (!existsSync(join(BUILD_OUT, b))) fail(`${join(BUILD_OUT, b)} missing — run scripts/management-build.mjs first`);

// --- 2. output dir, refuse to clobber -----------------------------------------
const outDir = opts.outDir ? resolve(process.cwd(), opts.outDir) : join(appDir, '.local', 'personal-runtime');
// Never empty a directory that contains this app (accidental `-OutDir .`).
const relApp = relative(outDir, appDir);
if (relApp === '' || (!relApp.startsWith('..') && !isAbsolute(relApp))) fail(`-OutDir ${outDir} would overwrite the app itself — refused`);
if (existsSync(outDir)) {
  if (!statSync(outDir).isDirectory()) {
    if (!opts.force) fail(`${outDir} exists and is not a directory — pass -Force to replace it`);
    rmSync(outDir, { force: true });
  } else if (readdirSync(outDir).length > 0) {
    if (!opts.force) fail(`${outDir} is not empty — pass -Force to replace it`);
    for (const entry of readdirSync(outDir)) rmSync(join(outDir, entry), { recursive: true, force: true });
  }
}
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

// --- 3. copy payload files ----------------------------------------------------
cpSync(distDir, join(outDir, 'dist'), { recursive: true });
mkdirSync(join(outDir, 'server'), { recursive: true });
for (const b of BUNDLES) cpSync(join(BUILD_OUT, b), join(outDir, 'server', b));
console.log(`copied dist/ + ${BUNDLES.join(', ')}`);

// --- 4. external dependency closure -------------------------------------------
// Vite SSR keeps bare imports external. Scan the bundles for every static /
// dynamic specifier; anything that is not node:-builtin, a node core name, or a
// relative/absolute path is a runtime npm dependency we must ship.
const SPEC = /\b(?:from|import|require)\s*\(?\s*["']([^"'\s]+)["']\s*\)?/g;
const external = new Set();
for (const b of BUNDLES) {
  const text = readFileSync(join(outDir, 'server', b), 'utf8');
  for (const m of text.matchAll(SPEC)) {
    const s = m[1];
    if (s.startsWith('node:') || s.startsWith('.') || isAbsolute(s) || /^[A-Za-z]:[\\/]/.test(s)) continue;
    if (isBuiltin(s)) continue;
    const name = s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0];
    external.add(name);
  }
}

// Resolve each dep from the repo's install (pnpm symlinks → realpath), copy the
// real package dir, then recurse into its own dependencies so the closure is
// complete without dragging the source-tree node_modules layout into the zip.
const nmRoot = join(outDir, 'server', 'node_modules');
const placed = new Map(); // dep name → real source dir already copied
const externalDeps = [];
const queue = [...external].map(name => ({ name, from: join(appDir, 'package.json') }));
while (queue.length) {
  const { name, from } = queue.shift();
  const req = createRequire(from);
  let pkgJsonPath;
  try { pkgJsonPath = req.resolve(`${name}/package.json`); }
  catch {
    try {
      let dir = dirname(req.resolve(name));
      while (!existsSync(join(dir, 'package.json')) || JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name !== name) {
        const up = dirname(dir);
        if (up === dir) throw new Error('package.json not found');
        dir = up;
      }
      pkgJsonPath = join(dir, 'package.json');
    } catch (e) { fail(`bundle imports '${name}' but it cannot be resolved from the repo install: ${e.message}`); }
  }
  const pkgDir = realpathSync(dirname(pkgJsonPath));
  const prev = placed.get(name);
  if (prev) {
    if (prev !== pkgDir) fail(`version conflict: '${name}' resolves to both ${prev} and ${pkgDir} — flat node_modules cannot hold both`);
    continue;
  }
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  cpSync(pkgDir, join(nmRoot, name), { recursive: true, dereference: true });
  placed.set(name, pkgDir);
  if (external.has(name)) externalDeps.push({ name, version: pkg.version ?? null });
  for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push({ name: dep, from: join(pkgDir, 'package.json') });
}
if (externalDeps.length) console.log(`external deps: ${externalDeps.map(d => `${d.name}@${d.version}`).join(', ')} → server/node_modules/`);
else console.log('no external npm deps — server bundles are self-contained');

// Resolution probe: import every external dep through a file inside
// <out>/server so Node's own resolver proves the copied node_modules works.
if (externalDeps.length) {
  const probe = join(outDir, 'server', '.dep-probe.mjs');
  writeFileSync(probe, externalDeps.map(d => `await import(${JSON.stringify(d.name)});`).join('\n') + '\n', 'utf8');
  const r = spawnSync(process.execPath, [probe], { encoding: 'utf8' });
  rmSync(probe, { force: true });
  if (r.status !== 0) fail(`dep resolution probe failed:\n${r.stderr || r.stdout}`);
}

// --- 5. server/package.json ----------------------------------------------------
const appPkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
const serverPkg = {
  name: '@business/personal-web-payload',
  version: appPkg.version ?? '0.0.0',
  private: true,
  type: 'module',
  engines: { node: `>=${NODE_MIN}` },
};
writeFileSync(join(outDir, 'server', 'package.json'), JSON.stringify(serverPkg, null, 2) + '\n', 'utf8');

// --- 6. payload manifest --------------------------------------------------------
function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}
// Producer-manifest contract shared with the ACS assembler (assemble-local.ps1):
// `files` is a relpath -> lowercase sha256 string map; sizes ride in `fileSizes`.
const files = {};
const fileSizes = {};
let totalBytes = 0;
for (const p of walk(outDir)) {
  const rel = relative(outDir, p).split(sep).join('/');
  if (rel === 'payload-manifest.json') continue;
  const buf = readFileSync(p);
  files[rel] = createHash('sha256').update(buf).digest('hex');
  fileSizes[rel] = buf.length;
  totalBytes += buf.length;
}
const git = (args) => {
  const r = spawnSync('git', args, { cwd: appDir, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};
const porcelain = git(['status', '--porcelain']);
const manifest = {
  schemaVersion: 'personal-web-payload/1',
  generatedAt: new Date().toISOString(),
  sourceCommit: git(['rev-parse', 'HEAD']) ?? 'unknown',
  sourceDirty: porcelain == null ? null : porcelain.length > 0,
  package: { name: serverPkg.name, version: serverPkg.version },
  entry: { server: 'server/management-server.mjs', worker: 'server/worker.mjs', staticRoot: 'dist' },
  engines: { node: `>=${NODE_MIN}` },
  externalDeps: externalDeps.sort((a, b) => a.name.localeCompare(b.name)),
  // appRoot = two levels above server/management-server.mjs; in the installed
  // layout (payload/web/) that is releases/<id>/payload/, so launchers must pin
  // these absolute env vars rather than rely on the relative defaults.
  placement: 'releases/<releaseId>/payload/web',
  requiredEnv: ['PERSONAL_CONSOLE_PORT', 'PERSONAL_CONSOLE_ROOT', 'PERSONAL_CONSOLE_DIST', 'PERSONAL_DATA_DIR'],
  fileCount: Object.keys(files).length,
  totalBytes,
  files,
  fileSizes,
};
writeFileSync(join(outDir, 'payload-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`payload → ${outDir}  (${manifest.fileCount} files, ${totalBytes} bytes, node>=${NODE_MIN})`);
