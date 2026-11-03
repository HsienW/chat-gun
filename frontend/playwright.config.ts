import { defineConfig, devices } from '@playwright/test';

/**
 * Deterministic E2E: every test starts its own fixture server that serves the
 * `vite build --mode e2e` bundle and scripted LangGraph responses on one origin.
 * Retries stay at 0 everywhere so a flaky test fails instead of passing on retry.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  tsconfig: './tsconfig.e2e.json',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    trace: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
