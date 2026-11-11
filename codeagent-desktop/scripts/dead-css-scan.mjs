import fs from 'node:fs';
import { execSync } from 'node:child_process';

// Strip url(...) payloads first — data-URIs (e.g. the select chevron SVG)
// contain dotted hostnames that would otherwise register as classes.
const css = fs.readFileSync('src/renderer/styles.css', 'utf8')
  .replace(/url\([^)]*\)/g, 'url()');
const classes = new Set();
for (const m of css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]+)/g)) classes.add(m[1]);

const files = execSync('git ls-files src/renderer').toString().trim().split('\n')
  .filter((f) => /\.(tsx?|html)$/.test(f));
let src = '';
for (const f of files) {
  try { src += fs.readFileSync(f, 'utf8') + '\n'; } catch { /* ignore */ }
}

// Prefixes generated via template literals like `tone-${status}` — the full
// class name never appears verbatim, so treat them as dynamic, not dead.
const dynamicPrefixes = new Set();
for (const m of src.matchAll(/([a-zA-Z][a-zA-Z0-9_]*(?:-[a-zA-Z0-9_]+)*)-\$\{/g)) {
  dynamicPrefixes.add(m[1]);
}

const dead = [];
const dynamic = [];
for (const c of classes) {
  const re = new RegExp(`(^|[^a-zA-Z0-9_-])${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-zA-Z0-9_-]|$)`);
  if (re.test(src)) continue;
  const idx = c.lastIndexOf('-');
  if (idx > 0 && dynamicPrefixes.has(c.slice(0, idx))) { dynamic.push(c); continue; }
  dead.push(c);
}
console.log(`DYNAMIC-KEPT (${dynamic.length}):`);
console.log(dynamic.join(' '));
console.log(`\nDEAD (${dead.length}):`);
console.log(dead.join(' '));
