import { fork, type ChildProcess } from 'child_process';

// Supervision of the bundled backend (dist-server/server.js). The backend
// reports over IPC: {type:'ready', port} once it listens, {type:'fatal',
// message} right before it exits on an error. Kept free of Electron imports so
// it can be tested with plain Node child processes, and so `npm run serve`
// (scripts/serve.mjs) can supervise the backend with it too.

type BackendMessage = { type: 'ready'; port: number } | { type: 'fatal'; message: string };

function isBackendMessage(value: unknown): value is BackendMessage {
    const message = value as Partial<BackendMessage> | null;
    return (message?.type === 'ready' && typeof message.port === 'number')
        || (message?.type === 'fatal' && typeof message.message === 'string');
}

export interface BackendOptions {
    entry: string;
    env: NodeJS.ProcessEnv;
    cwd?: string;
    readyTimeoutMs: number;
    // Raw stdout/stderr text of the backend.
    onOutput: (text: string) => void;
}

export type BackendExit = {
    code: number | null;
    signal: NodeJS.Signals | null;
    // The backend's last {type:'fatal'} message, if any.
    reason?: string;
    // true when stop() asked for it.
    expected: boolean;
};

export interface Backend {
    port: number;
    // Settles when the process is gone, whatever the cause.
    exited: Promise<BackendExit>;
    // Asks for a clean shutdown, then kills the process after `graceMs`.
    stop(graceMs?: number): Promise<void>;
}

export class BackendStartError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BackendStartError';
    }
}

export function startBackend(options: BackendOptions): Promise<Backend> {
    return new Promise((resolve, reject) => {
        let child: ChildProcess;
        try {
            child = fork(options.entry, [], {
                env: options.env,
                cwd: options.cwd,
                stdio: ['ignore', 'pipe', 'pipe', 'ipc']
            });
        } catch (error) {
            reject(new BackendStartError(`Could not start the backend: ${(error as Error).message}`));
            return;
        }

        for (const stream of [child.stdout, child.stderr]) {
            stream?.setEncoding('utf8');
            stream?.on('data', (text: string) => options.onOutput(text));
        }

        let started = false;
        let stopping = false;
        let reason: string | undefined;
        let resolveExit!: (exit: BackendExit) => void;
        const exited = new Promise<BackendExit>((done) => { resolveExit = done; });

        const fail = (message: string) => {
            if (started) return;
            started = true;
            clearTimeout(readyTimer);
            if (child.exitCode === null && child.signalCode === null) child.kill();
            reject(new BackendStartError(message));
        };

        const readyTimer = setTimeout(() => {
            fail(`The backend did not report ready within ${Math.round(options.readyTimeoutMs / 1000)} s.`);
        }, options.readyTimeoutMs);

        child.on('message', (message: unknown) => {
            if (!isBackendMessage(message)) return;
            if (message.type === 'fatal') {
                reason = message.message;
                fail(message.message);
                return;
            }
            if (started) return;
            started = true;
            clearTimeout(readyTimer);
            resolve({ port: message.port, exited, stop });
        });

        child.once('error', (error) => fail(`Could not start the backend: ${error.message}`));

        child.once('exit', (code, signal) => {
            fail(reason ?? `The backend exited during startup (${signal ?? `code ${code}`}).`);
            resolveExit({ code, signal, reason, expected: stopping });
        });

        function stop(graceMs = 3000): Promise<void> {
            if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
            stopping = true;
            if (child.connected) child.send({ type: 'shutdown' });
            else child.kill();
            const killTimer = setTimeout(() => child.kill(), graceMs);
            return exited.then(() => clearTimeout(killTimer));
        }
    });
}

export interface SupervisorOptions extends BackendOptions {
    // After every successful start; `restarts` is 0 the first time.
    onReady(backend: Backend, restarts: number): void;
    // The backend stopped on its own (or failed to come back) and is started
    // again after `delayMs`.
    onCrash(reason: string, delayMs: number): void;
    // First restart delay, doubled after every crash in a row up to maxDelayMs.
    initialDelayMs?: number;
    maxDelayMs?: number;
    // A run that lasted this long resets the delay.
    stableMs?: number;
}

export interface Supervisor {
    // Resolves once stop() has finished; rejects when the very first start
    // fails (a configuration problem nobody should wait out).
    done: Promise<void>;
    stop(): Promise<void>;
}

const describeExit = ({ code, signal, reason }: BackendExit) => reason ?? (signal ? `signal ${signal}` : `exit code ${code}`);

// Keeps the backend running for a host without a supervisor of its own
// (`npm run serve`): the backend exits on an uncaught exception by design.
export function superviseBackend(options: SupervisorOptions): Supervisor {
    const { initialDelayMs = 1000, maxDelayMs = 30_000, stableMs = 60_000 } = options;
    let current: Backend | null = null;
    let stopping = false;
    let wakeUp: (() => void) | null = null;

    const pause = (ms: number) => new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        wakeUp = () => {
            clearTimeout(timer);
            resolve();
        };
    });

    const done = (async () => {
        let crashes = 0;
        for (let restarts = 0; !stopping; restarts++) {
            const startedAt = Date.now();
            let reason: string;
            try {
                current = await startBackend(options);
                if (stopping) break;
                options.onReady(current, restarts);
                const exit = await current.exited;
                current = null;
                if (stopping || exit.expected) break;
                reason = describeExit(exit);
            } catch (error) {
                if (stopping) break;
                if (restarts === 0) throw error;
                reason = error instanceof Error ? error.message : String(error);
            }
            crashes = Date.now() - startedAt >= stableMs ? 1 : crashes + 1;
            const delayMs = Math.min(initialDelayMs * 2 ** (crashes - 1), maxDelayMs);
            options.onCrash(reason, delayMs);
            await pause(delayMs);
        }
        await current?.stop();
    })();

    return {
        done,
        stop: () => {
            stopping = true;
            wakeUp?.();
            const running = current;
            return Promise.resolve(running?.stop()).then(() => done.catch(() => undefined));
        }
    };
}
