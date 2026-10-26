import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BackendStartError, startBackend, type Backend } from '../../electron/backend';

// Stand-in backends: tiny CommonJS scripts that speak the IPC protocol.
const SCRIPTS: Record<string, string> = {
    ready: `
        process.stdout.write('booting\\n');
        process.send({ type: 'ready', port: 4321 });
        process.on('message', (m) => { if (m && m.type === 'shutdown') { console.log('bye'); process.exit(0); } });
        setInterval(() => {}, 1000);
    `,
    deaf: `
        process.send({ type: 'ready', port: 4322 });
        setInterval(() => {}, 1000);
    `,
    fatal: `
        process.send({ type: 'fatal', message: 'Port 127.0.0.1:3001 is already in use.' }, () => process.exit(1));
    `,
    silentExit: `process.exit(0);`,
    hang: `setInterval(() => {}, 1000);`,
    crashLater: `
        process.send({ type: 'ready', port: 4323 });
        setTimeout(() => { process.send({ type: 'fatal', message: 'Uncaught exception: boom' }, () => process.exit(1)); }, 100);
    `,
};

let dir: string;
const started: Backend[] = [];

beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-backend-'));
    for (const [name, source] of Object.entries(SCRIPTS)) fs.writeFileSync(path.join(dir, `${name}.cjs`), source);
});

afterAll(async () => {
    await Promise.all(started.map((backend) => backend.stop(500)));
    fs.rmSync(dir, { recursive: true, force: true });
});

function start(script: string, readyTimeoutMs = 10_000, output: string[] = []) {
    return startBackend({
        entry: path.join(dir, `${script}.cjs`),
        env: { ...process.env },
        readyTimeoutMs,
        onOutput: (text) => output.push(text),
    }).then((backend) => {
        started.push(backend);
        return backend;
    });
}

describe('startBackend', () => {
    it('resolves with the reported port and stops cleanly on request', async () => {
        const output: string[] = [];
        const backend = await start('ready', 10_000, output);
        expect(backend.port).toBe(4321);

        await backend.stop();
        expect(await backend.exited).toEqual({ code: 0, signal: null, reason: undefined, expected: true });
        expect(output.join('')).toContain('booting');
        expect(output.join('')).toContain('bye');
    });

    it('kills a backend that ignores the shutdown request', async () => {
        const backend = await start('deaf');
        await backend.stop(200);
        expect((await backend.exited).expected).toBe(true);
    });

    it('rejects with the fatal reason the backend reported', async () => {
        await expect(start('fatal')).rejects.toEqual(new BackendStartError('Port 127.0.0.1:3001 is already in use.'));
    });

    it('rejects when the backend exits before it is ready, even with code 0', async () => {
        await expect(start('silentExit')).rejects.toThrow('The backend exited during startup (code 0).');
    });

    it('rejects and kills a backend that never reports ready', async () => {
        await expect(start('hang', 300)).rejects.toThrow('The backend did not report ready within 0 s.');
    });

    it('rejects when the entry point does not exist', async () => {
        await expect(start('missing')).rejects.toBeInstanceOf(BackendStartError);
    });

    it('reports a crash after startup with its reason', async () => {
        const backend = await start('crashLater');
        expect(await backend.exited).toEqual({ code: 1, signal: null, reason: 'Uncaught exception: boom', expected: false });
    });
});
