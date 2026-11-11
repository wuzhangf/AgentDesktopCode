// Motion preference (§7.2): standard / reduced / off, persisted locally,
// never overriding the OS preference when user hasn't chosen.
export type MotionPref = 'standard' | 'reduced' | 'off';

const KEY = 'cpw.motion';
const THEME_KEY = 'cpw.theme';

export function motionPref(): MotionPref {
  const v = localStorage.getItem(KEY) as MotionPref | null;
  if (v === 'standard' || v === 'reduced' || v === 'off') return v;
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'standard';
}

export function setMotionPref(v: MotionPref) {
  localStorage.setItem(KEY, v);
  document.documentElement.dataset.motion = v;
}

export function motionEnabled(): boolean {
  return motionPref() === 'standard';
}

export function themePref(): 'dark' | 'light' {
  return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
}

export function setThemePref(v: 'dark' | 'light') {
  localStorage.setItem(THEME_KEY, v);
  document.documentElement.dataset.theme = v;
}
