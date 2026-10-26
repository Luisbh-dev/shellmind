import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localProcessEnv } from './env';
import { startScopedCli } from './scopedCli';

const SECRETS = {
    SHELLMIND_DATA_KEY: 'data-key-secret',
    SHELLMIND_AUTH_TOKEN: 'auth-token-secret',
    shellmind_other: 'x',
    GEMINI_API_KEY: 'gemini-secret',
    MINIMAX_PROXY_BEARER_TOKEN: 'proxy-secret',
    OPENAI_API_KEY: 'openai-secret',
    ELECTRON_RUN_AS_NODE: '1',
};

let tmpDir: string | undefined;

afterEach(() => {
    for (const name of Object.keys(SECRETS)) delete process.env[name];
    // Windows may hold the finished child's working directory a moment longer.
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    tmpDir = undefined;
});

describe('localProcessEnv', () => {
    it('drops the backend settings, AI credentials and API keys, whatever their case, and keeps the rest', () => {
        Object.assign(process.env, SECRETS, { GITHUB_TOKEN: 'users-own' });
        try {
            const env = localProcessEnv();
            for (const name of Object.keys(SECRETS)) expect(env).not.toHaveProperty(name);
            expect(env.PATH ?? env.Path).toBe(process.env.PATH);
            // The user's own tokens are theirs to use in their shells.
            expect(env.GITHUB_TOKEN).toBe('users-own');
        } finally {
            delete process.env.GITHUB_TOKEN;
        }
    });

    it('does not tell where the backend keeps its database', () => {
        const previous = process.env.DB_PATH;
        process.env.DB_PATH = 'C:\\data\\shellmind.db';
        try {
            expect(localProcessEnv()).not.toHaveProperty('DB_PATH');
        } finally {
            if (previous === undefined) delete process.env.DB_PATH;
            else process.env.DB_PATH = previous;
        }
    });
});

// Runs `node <script>` in a CLI console and resolves with what the user saw
// once the command finished (the console shows its prompt again).
function runInScopedCli(script: string): Promise<string> {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-env-'));
    fs.writeFileSync(path.join(tmpDir, 'script.cjs'), script);
    return new Promise((resolve) => {
        let output = '';
        const cli = startScopedCli(
            { bin: 'node', cwd: tmpDir, initialCommand: 'script.cjs' },
            {
                onData: (chunk) => {
                    output += chunk;
                    if (output.includes('node>')) {
                        cli.kill();
                        resolve(output);
                    }
                },
                onExit: () => resolve(output),
            }
        );
    });
}

describe('local processes', () => {
    it('never see the session token or the credentials key', async () => {
        Object.assign(process.env, SECRETS);
        const output = await runInScopedCli(
            "console.log('[' + Object.keys(process.env).filter((name) => /^shellmind_/i.test(name)).join(',') + ']<done>');"
        );
        expect(output).toContain('[]<done>');
    }, 20_000);
});
