import { defineConfig } from '@playwright/test';

/**
 * L1 UI E2E — real browser × in-process management BFF × node stub daemon.
 * Every test boots its own console on a random port with an mkdtemp state root
 * (see tests/e2e/fixtures/console.ts), so the suite is safe to run in parallel
 * and never touches the user's .local/personal-console state.
 *
 * Prerequisite: `pnpm build` (the fixture serves dist/, not a dev server).
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.e2e.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  // Capped on purpose: each managed probe shells out to PowerShell/CIM for
  // command-line ownership, so unbounded parallelism starves the box.
  workers: Number(process.env.PW_WORKERS ?? 4),
  timeout: 60_000,
  expect: { timeout: 15_000 },          // covers the detail page's 4s poll cadence
  reporter: [['list'], ['html', { open: 'never', outputFolder: '.local/playwright-report' }]],
  outputDir: '.local/playwright-results',
  use: {
    headless: true,
    // 1440 keeps the sidebar labels rendered (the shell collapses to an
    // icon-only rail at ≤1280px).
    viewport: { width: 1440, height: 900 },
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    locale: 'zh-CN',
  },
});
