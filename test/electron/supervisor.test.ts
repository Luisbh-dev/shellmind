import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BackendStartError, superviseBackend, type Supervisor } from '../../electron/backend';

// Stand-in backends speaking the IPC protocol. `flaky` crashes on its first
// two runs (counted in a marker file) and then stays up.
const SCRIPTS: Record<string, string> = {
    flaky: `
        const fs = require('fs');
        const runs = Number(fs.existsSync(process.env.RUNS_FILE) ? fs.readFileSync(process.env.RUNS_FILE, 'utf8') : 0) + 1;
        fs.writeFileSync(process.env.RUNS_FILE, String(runs));
        process.send({ type: 'ready', port: 5000 + runs });
        if (runs <= 2) setTimeout(() => process.send({ type: 'fatal', message: 'Uncaught exception: run ' + runs }, () => process.exit(1)), 20);
        process.on('message', (m) => { if (m && m.type === 'shutdown') process.exit(0); });
        setInterval(() => {}, 1000);
    `,
    fatal: `process.send({ type: 'fatal', message: 'Port 127.0.0.1:3001 is already in use.' }, () => process.exit(1));`,
};

let dir: string;
const supervisors: Supervisor[] = [];

beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-supervisor-'));
    for (const [name, source] of Object.entries(SCRIPTS)) fs.writeFileSync(path.join(dir, `${name}.cjs`), source);
});

afterAll(async () => {
    await Promise.all(supervisors.map((supervisor) => supervisor.stop()));
    fs.rmSync(dir, { recursive: true, force: true });
});

function supervise(script: string, events: string[]) {
    const supervisor = superviseBackend({
        entry: path.join(dir, `${script}.cjs`),
        env: { ...process.env, RUNS_FILE: path.join(dir, `${script}.runs`) },
        readyTimeoutMs: 10_000,
        onOutput: () => {},
        onReady: (backend, restarts) => events.push(`ready ${backend.port} after ${restarts} restarts`),
        onCrash: (reason, delayMs) => events.push(`crash (${reason}), retry in ${delayMs} ms`),
        initialDelayMs: 10,
        maxDelayMs: 15,
    });
    supervisors.push(supervisor);
    return supervisor;
}

const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('timed out');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};

describe('superviseBackend', () => {
    it('restarts a crashing backend with growing, capped delays and stops it on request', async () => {
        const events: string[] = [];
        const supervisor = supervise('flaky', events);

        await waitFor(() => events.length === 5);
        expect(events).toEqual([
            'ready 5001 after 0 restarts',
            'crash (Uncaught exception: run 1), retry in 10 ms',
            'ready 5002 after 1 restarts',
            'crash (Uncaught exception: run 2), retry in 15 ms',
            'ready 5003 after 2 restarts',
        ]);

        await supervisor.stop();
        await expect(supervisor.done).resolves.toBeUndefined();
        expect(events).toHaveLength(5);
    });

    it('gives up when the very first start fails', async () => {
        const supervisor = supervise('fatal', []);
        await expect(supervisor.done).rejects.toEqual(new BackendStartError('Port 127.0.0.1:3001 is already in use.'));
    });
});
