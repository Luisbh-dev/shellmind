import { afterEach, describe, expect, it } from 'vitest';
import { backendEnvVars, clearBackendEnv, NO_DOTENV_FILE } from './backendEnv';
import { HOOK_TIMEOUT_MS, NODE_TEST_TIMEOUT_MS } from './timeouts';

// Read before any test below touches the environment: what test/setup/node.ts
// left for this file.
const dotenvPathAtStart = process.env.DOTENV_CONFIG_PATH;

const touched = ['SHELLMIND_RESET_DATA_KEY', 'MINIMAX_API_BASE_URL', 'GEMINI_API_KEY'];
afterEach(() => {
    for (const name of touched) delete process.env[name];
});

describe('test environment isolation', () => {
    it('runs before every node test file and keeps dotenv away from the repository .env', () => {
        expect(dotenvPathAtStart).toBe(NO_DOTENV_FILE);
    });

    it('covers every variable the backend reads, including the ones the hand-kept list missed', () => {
        const names = backendEnvVars();
        expect(names).toEqual(expect.arrayContaining([
            'SHELLMIND_RESET_DATA_KEY',
            'MINIMAX_API_BASE_URL',
            'SHELLMIND_DATA_KEY',
            'SHELLMIND_AUTH_TOKEN',
            'DB_PATH',
            'LOG_LEVEL',
            // Read through AI_PROVIDER_CONFIG[...].envKey.
            'GEMINI_API_KEY',
            'MINIMAX_API_KEY',
        ]));
        // The machine's own variables stay: spawned shells need them.
        for (const system of ['HOME', 'USERPROFILE', 'SHELL', 'USER', 'USERNAME']) expect(names).not.toContain(system);
    });

    it('clears them and nothing else', () => {
        process.env.SHELLMIND_RESET_DATA_KEY = '1';
        process.env.MINIMAX_API_BASE_URL = 'https://example.invalid/anthropic';
        process.env.GEMINI_API_KEY = 'from-the-shell';
        const pathBefore = process.env.PATH;

        clearBackendEnv();

        for (const name of touched) expect(process.env).not.toHaveProperty(name);
        expect(process.env.PATH).toBe(pathBefore);
        expect(process.env.DOTENV_CONFIG_PATH).toBe(NO_DOTENV_FILE);
    });
});

describe('test timeouts', () => {
    it('gives the backend-booting hooks and tests of the node project room on a loaded runner', async () => {
        const { default: config } = await import('../../vitest.config');
        const resolved = await config({ command: 'serve', mode: 'test' });
        const node = resolved.test?.projects?.find((project) => typeof project === 'object' && 'test' in project && project.test?.name === 'node');
        expect(node).toMatchObject({
            test: {
                setupFiles: expect.arrayContaining(['./test/setup/node.ts']),
                hookTimeout: HOOK_TIMEOUT_MS,
                testTimeout: NODE_TEST_TIMEOUT_MS,
            },
        });
        expect(HOOK_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    });
});
