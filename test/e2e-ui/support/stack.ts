import { fork, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

// The app under test, started for this run only: the backend from its sources
// (tsx, as `npm start` runs it) with a temp database and its own session
// token, and the Vite dev server pointed at it. Nothing here reads or touches
// the developer's database, ports or running app.

export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

export type Stack = {
    apiUrl: string;
    webUrl: string;
    token: string;
    dataDir: string;
    pids: number[];
    stop: () => Promise<void>;
};

type Options = {
    dataDir: string;
    // Extra backend environment (the AI provider mock).
    env: Record<string, string>;
    log: (line: string) => void;
};

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address() as net.AddressInfo;
            probe.close(() => resolve(port));
        });
    });
}

// The developer's environment without ShellMind's own settings (the backend
// entry, support/backend.ts, also clears every variable the backend reads).
function cleanEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of Object.keys(env)) {
        if (/^(SHELLMIND_|VITE_)/i.test(name)) delete env[name];
    }
    return env;
}

function pipeOutput(child: ChildProcess, name: string, logFile: string) {
    const out = fs.createWriteStream(logFile, { flags: 'a' });
    child.stdout?.pipe(out);
    child.stderr?.pipe(out);
    child.once('exit', (code, signal) => out.write(`\n[${name} exited: code ${code} signal ${signal}]\n`));
}

async function waitForHttp(url: string, timeoutMs: number, child: ChildProcess, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (child.exitCode !== null) throw new Error(`${what} exited with code ${child.exitCode}`);
        try {
            const res = await fetch(url);
            if (res.status < 500) return;
        } catch {
            // Not listening yet.
        }
        if (Date.now() > deadline) throw new Error(`${what} did not answer at ${url}`);
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
}

function kill(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        child.once('exit', () => {
            clearTimeout(timer);
            resolve();
        });
        child.kill();
    });
}

export async function startStack({ dataDir, env, log }: Options): Promise<Stack> {
    const token = randomBytes(32).toString('base64url');
    const children: ChildProcess[] = [];
    const stop = async () => {
        await Promise.all(children.map(kill));
    };

    try {
        // Port 0: the backend picks a free port and reports it ({type:'ready'}).
        const backend = fork(path.join(__dirname, 'backend.ts'), [], {
            cwd: REPO_ROOT,
            execArgv: ['--import', 'tsx'],
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            env: {
                ...cleanEnv(),
                TSX_TSCONFIG_PATH: path.join(REPO_ROOT, 'tsconfig.server.json'),
                SHELLMIND_E2E_UI_BACKEND_ENV: JSON.stringify({
                    HOST: '127.0.0.1',
                    PORT: '0',
                    DB_PATH: path.join(dataDir, 'shellmind.db'),
                    SHELLMIND_AUTH_TOKEN: token,
                    // Never the developer's ssh-agent or Pageant.
                    SHELLMIND_SSH_AGENT: 'off',
                    ...env,
                }),
            },
        });
        children.push(backend);
        pipeOutput(backend, 'backend', path.join(dataDir, 'backend.log'));
        const apiPort = await new Promise<number>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('The backend did not start in 90 s (see backend.log)')), 90_000);
            backend.on('message', (message: { type?: string; port?: number; message?: string }) => {
                if (message?.type === 'ready' && message.port) {
                    clearTimeout(timer);
                    resolve(message.port);
                } else if (message?.type === 'fatal') {
                    clearTimeout(timer);
                    reject(new Error(`The backend could not start: ${message.message}`));
                }
            });
            backend.once('exit', (code) => {
                clearTimeout(timer);
                reject(new Error(`The backend exited with code ${code} (see ${path.join(dataDir, 'backend.log')})`));
            });
        });
        const apiUrl = `http://127.0.0.1:${apiPort}`;
        log(`backend ${apiUrl} (pid ${backend.pid})`);

        // The UI reaches this backend through VITE_API_BASE, and asks for the
        // token: the access gate is part of what is tested.
        const webPort = await freePort();
        const vite = spawn(process.execPath, [
            path.join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
            '--config', path.join(REPO_ROOT, 'test', 'e2e-ui', 'vite.config.ts'),
            '--host', '127.0.0.1', '--port', String(webPort), '--strictPort',
        ], {
            cwd: REPO_ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...cleanEnv(),
                VITE_API_BASE: apiUrl,
                SHELLMIND_E2E_UI_VITE_CACHE: path.join(dataDir, 'vite-cache'),
                WEB_PORT: String(webPort),
            },
        });
        children.push(vite);
        pipeOutput(vite, 'vite', path.join(dataDir, 'vite.log'));
        const webUrl = `http://127.0.0.1:${webPort}`;
        await waitForHttp(`${webUrl}/`, 90_000, vite, 'Vite');
        log(`web ${webUrl} (pid ${vite.pid})`);

        return { apiUrl, webUrl, token, dataDir, pids: children.map((child) => child.pid ?? 0), stop };
    } catch (error) {
        await stop();
        throw error;
    }
}
