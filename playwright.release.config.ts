// Release checks: a packaged build driven over DevTools (see e2e/release/release.spec.ts).
import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir: 'e2e/release',
  timeout: 120_000,
  expect: {timeout: 15_000},
  workers: 1,
  reporter: 'list',
});
