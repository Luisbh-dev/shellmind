import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
    delete process.env.SHELLMIND_AUTH_TOKEN;
    delete process.env.SHELLMIND_DATA_KEY;
});

describe('server/config', () => {
    it('reads the secrets handed over by the parent process, then removes them from the environment', async () => {
        vi.resetModules();
        process.env.DOTENV_CONFIG_QUIET = 'true';
        process.env.SHELLMIND_AUTH_TOKEN = ' session-token ';
        process.env.SHELLMIND_DATA_KEY = 'ZGF0YS1rZXk=';

        const config = await import('./config');

        expect(config.AUTH_TOKEN).toBe('session-token');
        expect(config.DATA_KEY).toBe('ZGF0YS1rZXk=');
        expect(process.env).not.toHaveProperty('SHELLMIND_AUTH_TOKEN');
        expect(process.env).not.toHaveProperty('SHELLMIND_DATA_KEY');
    });
});
