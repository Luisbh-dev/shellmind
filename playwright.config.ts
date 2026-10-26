import { defineConfig, devices } from '@playwright/test';

// The end-to-end UI suite (test/e2e-ui, `npm run test:e2e-ui`, opt-in with
// SHELLMIND_E2E_UI=1): Chromium against the app's own backend and Vite dev
// server, started for the run by the global setup together with throwaway
// sshd containers. The specs share that backend and those servers, so they
// run one at a time.
export default defineConfig({
    testDir: 'test/e2e-ui',
    testMatch: '*.spec.ts',
    outputDir: 'test-results/e2e-ui',
    globalSetup: './test/e2e-ui/support/globalSetup.ts',
    fullyParallel: false,
    workers: 1,
    forbidOnly: !!process.env.CI,
    retries: 0,
    timeout: 120_000,
    expect: { timeout: 15_000 },
    reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
    use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        locale: 'en-US',
        actionTimeout: 15_000,
        navigationTimeout: 60_000,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
});
