import { afterEach, describe, expect, it, vi } from 'vitest';
import { redact, REDACTED } from './logger';

async function loadLogger(env: { LOG_LEVEL?: string; SHELLMIND_DEBUG?: string }) {
    vi.resetModules();
    process.env.DOTENV_CONFIG_QUIET = 'true';
    for (const name of ['LOG_LEVEL', 'SHELLMIND_DEBUG'] as const) {
        if (env[name] === undefined) delete process.env[name];
        else process.env[name] = env[name];
    }
    return import('./logger');
}

afterEach(() => {
    delete process.env.LOG_LEVEL;
    delete process.env.SHELLMIND_DEBUG;
    vi.restoreAllMocks();
});

function captureConsole() {
    const lines: string[] = [];
    for (const method of ['log', 'warn', 'error'] as const) {
        vi.spyOn(console, method).mockImplementation((line: string) => { lines.push(`${method}:${line}`); });
    }
    return lines;
}

describe('createLogger', () => {
    it('logs info and above by default, with level and scope', async () => {
        const { createLogger } = await loadLogger({});
        const lines = captureConsole();
        const log = createLogger('test');
        log.debug('hidden');
        log.info('shown');
        log.warn('careful');
        log.error('broken');
        expect(lines).toHaveLength(3);
        expect(lines[0]).toMatch(/^log:\d{4}-\d\d-\d\dT[\d:.]+Z INFO \[test\] shown$/);
        expect(lines[1]).toMatch(/^warn:.* WARN \[test\] careful$/);
        expect(lines[2]).toMatch(/^error:.* ERROR \[test\] broken$/);
    });

    it('honours LOG_LEVEL', async () => {
        const { createLogger, isLogLevelEnabled } = await loadLogger({ LOG_LEVEL: 'warn' });
        const lines = captureConsole();
        createLogger('test').info('quiet');
        createLogger('test').warn('loud');
        expect(lines).toEqual([expect.stringMatching(/WARN \[test\] loud$/)]);
        expect(isLogLevelEnabled('debug')).toBe(false);
    });

    it('turns on debug with SHELLMIND_DEBUG=1, whatever LOG_LEVEL says', async () => {
        const { createLogger, isLogLevelEnabled } = await loadLogger({ LOG_LEVEL: 'error', SHELLMIND_DEBUG: '1' });
        const lines = captureConsole();
        createLogger('ssh').debug('packet');
        expect(lines).toEqual([expect.stringMatching(/DEBUG \[ssh\] packet$/)]);
        expect(isLogLevelEnabled('debug')).toBe(true);
    });

    it('falls back to info for an unknown LOG_LEVEL', async () => {
        const { isLogLevelEnabled } = await loadLogger({ LOG_LEVEL: 'verbose' });
        expect(isLogLevelEnabled('info')).toBe(true);
        expect(isLogLevelEnabled('debug')).toBe(false);
    });
});

describe('redact', () => {
    it('masks secret fields at any depth and leaves the rest alone', () => {
        const body = {
            name: 'web01',
            port: 22,
            password: 'pw',
            privateKey: '-----BEGIN KEY-----',
            passphrase: 'pp',
            s3_secret_key: 'sk',
            nested: { GEMINI_API_KEY: 'g', token: 'tk', list: [{ authorization: 'Bearer x', cookie: 'c' }] },
            max_tokens: 1024,
            emptyPassword: '',
        };
        expect(redact(body)).toEqual({
            name: 'web01',
            port: 22,
            password: REDACTED,
            privateKey: REDACTED,
            passphrase: REDACTED,
            s3_secret_key: REDACTED,
            nested: { GEMINI_API_KEY: REDACTED, token: REDACTED, list: [{ authorization: REDACTED, cookie: REDACTED }] },
            max_tokens: 1024,
            emptyPassword: '',
        });
        expect(body.password).toBe('pw');
    });

    it('masks binary secrets and bearer tokens inside strings', () => {
        expect(redact({ privateKey: Buffer.from('key') })).toEqual({ privateKey: REDACTED });
        expect(redact('Authorization: Bearer abc.def')).toBe(`Authorization: Bearer ${REDACTED}`);
    });

    it('handles cycles and leaves non-plain objects untouched', () => {
        const error = new Error('boom');
        const cyclic: Record<string, unknown> = { error };
        cyclic.self = cyclic;
        const shared = { a: 1 };
        const result = redact({ cyclic, left: shared, right: shared }) as Record<string, Record<string, unknown>>;
        expect(result.cyclic.self).toBe('[circular]');
        expect(result.cyclic.error).toBe(error);
        expect(result.left).toEqual({ a: 1 });
        expect(result.right).toEqual({ a: 1 });
        expect(redact(null)).toBeNull();
        expect(redact(7)).toBe(7);
    });
});
