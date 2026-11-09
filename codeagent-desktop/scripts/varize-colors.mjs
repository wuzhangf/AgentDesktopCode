import fs from 'node:fs';

const file = 'src/renderer/styles.css';
const s = fs.readFileSync(file, 'utf8');

// exact-value -> var mapping (component rules only; skip '--x: val' definition lines)
const map = {
  '#0f1218': '--bg',
  '#151a22': '--panel',
  '#1a212c': '--panel-raised',
  '#202a38': '--panel-hover',
  '#293342': '--border',
  '#38475b': '--border-strong',
  '#e8edf5': '--text',
  '#8995a8': '--muted',
  '#606d80': '--subtle',
  '#8b7cff': '--accent',
  '#a99eff': '--accent-bright',
  'rgba(139, 124, 255, 0.16)': '--accent-soft',
  '#5bd49a': '--success',
  '#f4bd67': '--warning',
  '#f27d8e': '--danger',
  '#151513': '--bg-app',
  '#1b1b18': '--bg-sidebar',
  '#20201d': '--bg-surface',
  '#292925': '--bg-elevated',
  '#30302b': '--bg-hover',
  '#37372f': '--bg-selected',
  '#f2f0e9': '--text-primary',
  '#b8b5aa': '--text-secondary',
  '#858278': '--text-muted',
  '#34342f': '--border-subtle',
  '#4a4941': '--border-strong',
  '#9bb7ff': '--focus-ring',
  '#d59a63': '--accent',
  '#e3aa72': '--accent-hover',
  '#ecb982': '--accent-bright',
  'rgba(213, 154, 99, 0.16)': '--accent-soft',
  '#79a9d6': '--info',
  '#6f6c62': '--subtle'
};

const escapeRe = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lines = s.split('\n');
let n = 0;
const out = lines.map((l) => {
  if (/^\s*--[\w-]+\s*:/.test(l)) return l;
  let r = l;
  for (const [hex, v] of Object.entries(map)) {
    const re = new RegExp(escapeRe(hex), 'g');
    if (re.test(r)) { r = r.replace(re, `var(${v})`); n++; }
  }
  return r;
});
fs.writeFileSync(file, out.join('\n'));
console.log('replaced', n);
