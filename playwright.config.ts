// End-to-end tests: start the built app (npm run build) with its own data
// folder and drive the window. No PS4 is needed.
import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  // One app at a time: each test starts its own Electron.
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
});
