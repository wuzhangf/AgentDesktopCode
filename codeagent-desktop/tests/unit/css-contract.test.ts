import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Design 2026-09-30 §3 / WU01: token-era guardrails that jsdom cannot see.
// These read the stylesheets as text from the package working directory.
const CSS_FILES = [
  'src/renderer/styles.css',
  'src/renderer/styles/panels.css',
  'src/renderer/styles/git.css',
  'src/renderer/styles/terminal.css',
  'src/renderer/styles/settings.css',
  'src/renderer/styles/settings-responsive.css',
  'src/renderer/styles/tokens.css'
];

function readCss(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), 'utf8');
}

describe('css token contract (design 2026-09-30)', () => {
  it('keeps every declared font-size at or above 11px', () => {
    for (const file of CSS_FILES) {
      const css = readCss(file);
      const offenders = [...css.matchAll(/font-size:\s*([0-9]+(?:\.[0-9]+)?)px/g)]
        .map((m) => Number(m[1]))
        .filter((size) => size < 11);
      expect(offenders, `${file} declares font-size < 11px`).toEqual([]);
    }
  });

  it('uses var(--focus-ring) for the base focus-visible outline', () => {
    const css = readCss('src/renderer/styles.css');
    const focusRule = css.match(/:where\(button[^\{]+\{[^}]*outline:[^}]*\}/s);
    expect(focusRule?.[0]).toContain('var(--focus-ring)');
  });

  it('no longer overrides the execution palette in the light theme', () => {
    const css = readCss('src/renderer/styles.css');
    const lightBlock = css.match(/\.workbench\[data-theme="light"\]\s*\{([^}]*)\}/);
    expect(lightBlock?.[1]).not.toContain('--execution-surface');
  });

  it('does not uppercase CJK section headings (no-op transform removed)', () => {
    const css = readCss('src/renderer/styles.css') + readCss('src/renderer/styles/settings.css');
    const cjkHeadings = [
      '.rail-section-heading', '.activity-tray-heading',
      '.session-binding-label', '.settings-category-group',
      '.export-preview-heading', '.workspace-conflict-group-label'
    ];
    for (const selector of cjkHeadings) {
      const rule = css.match(new RegExp(`\\${selector}[^{]*\\{([^}]*)\\}`));
      expect(rule?.[1], `${selector} still uses text-transform: uppercase`).not.toMatch(/text-transform:\s*uppercase/);
    }
  });
});
