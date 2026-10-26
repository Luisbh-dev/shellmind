// `npm run test:e2e-ui [playwright args]`: the end-to-end UI suite in
// test/e2e-ui (see its README). Opt-in with SHELLMIND_E2E_UI=1: it builds and
// starts Docker containers (shellmind-test-e2eui-*), then drives the app in
// Chromium (`npx playwright install chromium`) against its own backend and
// Vite dev server, with a temp database and token.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import process from 'node:process';

if (process.env.SHELLMIND_E2E_UI !== '1') {
    console.error('The end-to-end UI suite is opt-in: run it with SHELLMIND_E2E_UI=1 (it needs Docker and Playwright Chromium).');
    process.exit(1);
}

const require = createRequire(import.meta.url);
const cli = require.resolve('@playwright/test/cli');
const result = spawnSync(process.execPath, [cli, 'test', '--config', 'playwright.config.ts', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
});
process.exit(result.status ?? 1);
