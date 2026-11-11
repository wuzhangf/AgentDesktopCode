import { defineConfig, devices } from '@playwright/test';

/**
 * Personal task E2E — 独立于既有 `playwright.config.ts`（Worker 管理面）。
 *
 * 两个项目：
 * - personal-ui：真实 Chromium + 构建后的页面 + 真实 BFF/SQLite/ServiceClient，
 *   ACS 用 tests/e2e/personal/fixtures/scripted-acs.ts 的本机 HTTP 夹具替代。
 * - personal-real：真实 Chromium + 正式构建的 BFF + 当前源码 ACS/Product
 *   （runtime 由 verification/personal-web/build-runtime.py 预先编译）。
 *
 * 约定：文件名 *.personal.spec.ts，与旧 *.e2e.spec.ts 不重叠；不继承旧套件的
 * 自动重试；结果按 run-id 隔离到 .local/personal-e2e/<run-id>/。
 */
import { RUN_ID } from './tests/e2e/personal/fixtures/run-artifacts';

const OUT_ROOT = `.local/personal-e2e/${RUN_ID}`;

export default defineConfig({
  testDir: './tests/e2e/personal',
  testMatch: '**/*.personal.spec.ts',
  globalSetup: './tests/e2e/personal/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: `${OUT_ROOT}/playwright-report` }],
    ['json', { outputFile: `${OUT_ROOT}/summary.json` }],
  ],
  outputDir: `${OUT_ROOT}/playwright-results`,
  use: {
    ...devices['Desktop Chrome'],
    headless: true,
    viewport: { width: 1440, height: 1000 },
    locale: 'zh-CN',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'personal-ui',
      testMatch: /ui\/.*\.personal\.spec\.ts$/,
      workers: Number(process.env.PW_PERSONAL_UI_WORKERS ?? 2),
      timeout: 60_000,
    },
    {
      name: 'personal-real',
      testMatch: /real\/.*\.personal\.spec\.ts$/,
      workers: 1,
      fullyParallel: false,
      timeout: 240_000,
    },
  ],
});
