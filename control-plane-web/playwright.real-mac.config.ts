import {defineConfig} from '@playwright/test';

// An explicitly launched production management runtime and locked Swift Host are
// prerequisites. This suite never starts the L1 fake-daemon fixture.
export default defineConfig({
  testDir:'./tests/real-mac',testMatch:'**/*.spec.ts',fullyParallel:false,workers:1,retries:0,
  timeout:15*60_000,expect:{timeout:30_000},
  outputDir:process.env.MAC_WEB_OUTPUT_DIR??'.local/mac-real-e2e/results',
  reporter:[['list'],['json',{outputFile:process.env.MAC_WEB_REPORT_FILE??'.local/mac-real-e2e/playwright-report.json'}]],
  use:{headless:true,viewport:{width:1440,height:1000},locale:'zh-CN',acceptDownloads:true,
    actionTimeout:20_000,navigationTimeout:30_000,screenshot:'only-on-failure',
    // Traces capture HTTP headers/cookies; keep temporary auth material out of artifacts.
    trace:'off',video:'off'},
});
