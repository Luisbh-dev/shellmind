// `npm run test:e2e [vitest args]`: the opt-in end-to-end suites in test/e2e
// (SHELLMIND_E2E=1). They start real servers in Docker (OpenSSH, vsftpd,
// MinIO, containers named shellmind-test-*) and drive the built web UI
// (`npm run build` first) in Chromium (`npx playwright install chromium`).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const vitest = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const args = process.argv.slice(2);

const result = spawnSync(process.execPath, [vitest, 'run', ...(args.length ? args : ['test/e2e'])], {
    stdio: 'inherit',
    env: { ...process.env, SHELLMIND_E2E: process.env.SHELLMIND_E2E || '1' },
});
process.exit(result.status ?? 1);
