import { defineConfig, devices } from '@playwright/test';

// Small end-to-end suite (Spec §17): runs the built app in demo mode. `npm run e2e` builds first.
// Browser: Microsoft Edge on Windows (no download needed), otherwise Playwright's Chromium
// (`npx playwright install chromium` once). Override with E2E_CHANNEL (e.g. "chrome").
const port = Number(process.env.E2E_PORT ?? 3210);
const channel = process.env.E2E_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined);

export default defineConfig({
  testDir: './tests',
  // The tests share one demo workspace, so they run one after another.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    ...(channel ? { channel } : {}),
  },
  webServer: {
    command: 'node start-demo.mjs',
    cwd: import.meta.dirname,
    url: `http://localhost:${port}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { E2E_PORT: String(port) },
  },
});
