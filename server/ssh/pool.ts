import { EventEmitter } from "events";
import { Client, type ClientChannel, type ConnectConfig, type ServerHostKeyAlgorithm } from "ssh2";
import { DEBUG } from "../config";
import { loadSshTarget, type SshTarget } from "../connections/target";
import { knownHostsRepo } from "../db/knownHostsRepo";
import { createLogger } from "../logger";
import { createAgentFor } from "./agent";
import { HostKeyMismatchError, routeVia, sshFingerprint, sshKeyType } from "./hostKeys";

const log = createLogger("ssh");

// One SSH connection per saved server, shared by every terminal tab, file
// session, status poll and command that leases it. Connections are
// ref-counted, closed after an idle period, dropped on error, and replaced
// when the server row (or a row of its jump chain) is edited.

export const SSH_POOL_DEFAULTS = {
    idleTimeoutMs: 60_000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 4,
    readyTimeout: 20_000
};

// Other connections tried when the server refuses another channel (sshd
// MaxSessions) before a terminal tab or a command gives up.
export const MAX_SPARE_CONNECTIONS = 4;

// Host keys are pinned per host, port and `via`, the jump hosts the host is
// reached through (see routeVia): the same private address behind two
// bastions is two different machines.
export interface KnownHostStore {
    find(host: string, port: number, via: string): Promise<{ key_type: string; fingerprint: string } | null>;
    // Pins the key unless one is already pinned and returns the pinned one.
    pin(entry: { host: string; port: number; via: string; key_type: string; fingerprint: string }): Promise<{ fingerprint: string }>;
}

export type SshPoolOptions = Partial<typeof SSH_POOL_DEFAULTS> & {
    loadTarget?: (serverId: number) => Promise<SshTarget>;
    knownHosts?: KnownHostStore;
    debug?: boolean;
};

export type HostKeyTrustedEvent = {
    serverId: number;
    host: string;
    port: number;
    // The jump hosts it is reached through ("" when direct).
    via: string;
    keyType: string;
    fingerprint: string;
};

export interface SshLease {
    readonly serverId: number;
    readonly client: Client;
    readonly target: SshTarget;
    // Hands the connection back; it closes after the idle timeout once unused.
    release(): void;
    // Runs once when the connection closes (`err` says why if it failed).
    // Returns an unsubscribe function; release() drops the listeners too.
    onClose(listener: (err?: Error) => void): () => void;
}

type PoolEntry = {
    serverId: number;
    target: SshTarget;
    client: Client;
    ready: Promise<void>;
    refs: number;
    // No new leases: replaced, invalidated or idle-expired.
    stale: boolean;
    cancelled: boolean;
    closed: boolean;
    lastError?: Error;
    idleTimer: NodeJS.Timeout | null;
    closeListeners: Set<(err?: Error) => void>;
    jumpLease: SshLease | null;
    // Aborted by end(): the connection is no longer wanted, even while its
    // route is still being set up.
    abort: AbortController;
};

// Host key algorithms that make a server present a key of the given type
// (RSA keys sign with the SHA-2 variants first).
const HOST_KEY_ALGORITHMS: Record<string, ServerHostKeyAlgorithm[]> = {
    "ssh-ed25519": ["ssh-ed25519"],
    "ecdsa-sha2-nistp256": ["ecdsa-sha2-nistp256"],
    "ecdsa-sha2-nistp384": ["ecdsa-sha2-nistp384"],
    "ecdsa-sha2-nistp521": ["ecdsa-sha2-nistp521"],
    "ssh-rsa": ["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"],
    "ssh-dss": ["ssh-dss"]
};

// Like OpenSSH, ask first for the key type already pinned for the host, so a
// server that gained another key type (e.g. ed25519 next to a pinned RSA key)
// still presents the pinned key instead of failing as a changed one.
function preferPinnedKeyType(keyType: string | undefined): ConnectConfig["algorithms"] {
    const preferred = keyType ? HOST_KEY_ALGORITHMS[keyType] : undefined;
    if (!preferred) return undefined;
    // Applied in this order: listed algorithms move to the front of the defaults.
    return { serverHostKey: { remove: preferred, prepend: preferred, append: [] } };
}

// keyboard-interactive: a single hidden prompt is a password prompt in any
// language ("Password:", "Contraseña:"), answered once with the saved
// password. Several prompts, echoed ones (one-time codes) or a second round
// cannot be answered unattended, so the attempt fails.
function keyboardInteractiveResponder(password: string | undefined) {
    let answered = false;
    return (prompts: Array<{ prompt: string; echo?: boolean }>): string[] => {
        if (!password || answered || prompts.length !== 1 || prompts[0].echo) return [];
        answered = true;
        return [password];
    };
}

// A failure with a code the client translates (see shared/terminal.ts
// ConnectionError).
function codedError(code: string, message: string, details?: Record<string, string | number>): Error {
    return Object.assign(new Error(message), { code, details });
}

// W7-S2: ssh2 reports an SSH agent it cannot use (not running, refused to
// sign) as an "agent" level error and goes on with the next method. When no
// method signs in after that, the agent is the likelier cause than the
// credentials, and the failure says so (AGENT_FAILED, details.reason).
function withAgentCause(err: Error, agentError: Error | null): Error {
    if (!agentError || (err as { level?: string }).level !== "client-authentication") return err;
    const { methods } = err as { methods?: string[] };
    return codedError(
        "AGENT_FAILED",
        `Auth failed: the SSH agent could not be used (${agentError.message}).${methods?.length ? ` Server accepts: ${methods.join(",")}` : ""}`,
        { reason: agentError.message }
    );
}

function forwardOut(client: Client, host: string, port: number): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
        try {
            client.forwardOut("127.0.0.1", 0, host, port, (err, stream) => {
                if (err) reject(codedError("JUMP_UNREACHABLE", `The jump host could not reach ${host}:${port}: ${err.message}`, { target: `${host}:${port}`, reason: err.message }));
                else resolve(stream);
            });
        } catch (err) {
            // "Not connected": the jump connection ended before its close event.
            reject(err as Error);
        }
    });
}

const seconds = (ms: number) => Math.max(1, Math.round(ms / 1000));

// `step` (part of setting up a connection), bounded by the connection's
// deadline and cancelled when the connection is ended. What it delivers once
// nobody waits for it any more goes to `late` (to be released).
function bounded<T>(step: Promise<T>, deadline: number, signal: AbortSignal, onTimeout: () => Error, late: (value: T) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let done = false;
        const settle = (outcome: () => void): boolean => {
            if (done) return false;
            done = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            outcome();
            return true;
        };
        const onAbort = () => settle(() => reject(new Error("The SSH connection was cancelled")));
        const timer = setTimeout(() => settle(() => reject(onTimeout())), Math.max(0, deadline - Date.now()));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        step.then(
            (value) => {
                if (!settle(() => resolve(value))) late(value);
            },
            (err: unknown) => {
                settle(() => reject(err));
            }
        );
    });
}

// The server would not open another channel on a connection. OpenSSH answers
// "open failed" (administratively prohibited) once MaxSessions channels, 10
// by default, are open on it; other servers report a resource shortage.
export function isChannelRefused(err: unknown): boolean {
    const { reason, message } = (err ?? {}) as { reason?: unknown; message?: unknown };
    return reason === 1 || reason === 4 || (typeof message === "string" && /open failed/i.test(message));
}

// A readable message for an SSH connection failure.
export function describeSshError(err: unknown): string {
    if (err instanceof HostKeyMismatchError) return err.message;
    const { level, message, methods } = (err ?? {}) as { level?: string; message?: string; methods?: string[] };
    if (level === "client-authentication") {
        return methods?.length ? `Auth failed. Server accepts: ${methods.join(",")}` : "Auth failed: the saved credentials were rejected.";
    }
    return message || String(err);
}

// Which pool handed out a lease: commands on it move to a spare connection
// of that pool when the server refuses their channel (see pooledLease).
const leasePools = new WeakMap<object, SshPool>();

export class SshPool {
    readonly options: typeof SSH_POOL_DEFAULTS;
    private readonly loadTarget: (serverId: number) => Promise<SshTarget>;
    private readonly knownHosts: KnownHostStore;
    private readonly debug: boolean;
    private readonly events = new EventEmitter();
    // Current connection per server (accepts new leases).
    private readonly entries = new Map<number, PoolEntry>();
    // Every open connection, including replaced ones still leased and spares.
    private readonly live = new Set<PoolEntry>();
    private readonly leaseEntries = new WeakMap<SshLease, PoolEntry>();

    constructor(options: SshPoolOptions = {}) {
        this.options = {
            idleTimeoutMs: options.idleTimeoutMs ?? SSH_POOL_DEFAULTS.idleTimeoutMs,
            keepaliveInterval: options.keepaliveInterval ?? SSH_POOL_DEFAULTS.keepaliveInterval,
            keepaliveCountMax: options.keepaliveCountMax ?? SSH_POOL_DEFAULTS.keepaliveCountMax,
            readyTimeout: options.readyTimeout ?? SSH_POOL_DEFAULTS.readyTimeout
        };
        this.loadTarget = options.loadTarget ?? loadSshTarget;
        this.knownHosts = options.knownHosts ?? knownHostsRepo;
        this.debug = options.debug ?? DEBUG;
        // Every connecting socket listens while its handshake runs.
        this.events.setMaxListeners(0);
    }

    // Emitted when a host key is pinned on first use.
    onHostKeyTrusted(listener: (event: HostKeyTrustedEvent) => void): () => void {
        this.events.on("host-key-trusted", listener);
        return () => this.events.off("host-key-trusted", listener);
    }

    async acquire(serverId: number): Promise<SshLease> {
        const target = await this.loadTarget(serverId);

        let entry = this.entries.get(target.serverId);
        if (entry && (entry.stale || entry.closed || entry.target.version !== target.version)) {
            this.retire(entry);
            entry = undefined;
        }
        if (!entry) entry = this.open(target);
        return this.leaseWhenReady(entry);
    }

    // Another connection to the same server, for when it refused to open a
    // channel on the connections of the `refused` leases (sshd's MaxSessions,
    // see isChannelRefused): another open connection to it, or a new one. The
    // given leases stay held.
    async acquireSpare(refused: SshLease[]): Promise<SshLease> {
        if (!refused.length) throw new Error("acquireSpare needs the lease whose connection refused a channel");
        const full = new Set(refused.map((lease) => this.leaseEntries.get(lease)));
        const target = await this.loadTarget(refused[0].serverId);
        let entry: PoolEntry | undefined;
        for (const candidate of this.live) {
            if (candidate.serverId === target.serverId && !full.has(candidate) && !candidate.stale && !candidate.closed
                && candidate.target.version === target.version) {
                entry = candidate;
                break;
            }
        }
        return this.leaseWhenReady(entry ?? this.open(target, { spare: true }));
    }

    private async leaseWhenReady(entry: PoolEntry): Promise<SshLease> {
        entry.refs += 1;
        this.clearIdle(entry);
        try {
            await entry.ready;
            if (entry.closed) throw entry.lastError ?? new Error("The SSH connection closed");
        } catch (err) {
            entry.refs -= 1;
            throw err;
        }
        return this.lease(entry);
    }

    // Stops handing out the connections of a server (its row changed). With
    // `close`, also closes every open connection to it right away.
    invalidate(serverId: number, options: { close?: boolean } = {}): void {
        for (const live of [...this.live]) {
            if (live.serverId !== serverId) continue;
            if (options.close) this.end(live);
            else this.retire(live);
        }
    }

    closeAll(): void {
        for (const entry of this.live) this.end(entry);
        this.entries.clear();
    }

    // Leases and open connections of a server (for diagnostics and tests).
    inspect(serverId: number): { connections: number; refs: number } {
        let connections = 0;
        let refs = 0;
        for (const entry of this.live) {
            if (entry.serverId !== serverId) continue;
            connections += 1;
            refs += entry.refs;
        }
        return { connections, refs };
    }

    // A spare connection only becomes the server's current one if it has none.
    private open(target: SshTarget, options: { spare?: boolean } = {}): PoolEntry {
        const entry: PoolEntry = {
            serverId: target.serverId,
            target,
            client: new Client(),
            ready: Promise.resolve(),
            refs: 0,
            stale: false,
            cancelled: false,
            closed: false,
            idleTimer: null,
            closeListeners: new Set(),
            jumpLease: null,
            abort: new AbortController()
        };
        entry.ready = this.connect(entry);
        // Each acquirer awaits `ready`; this only keeps an unobserved failure quiet.
        entry.ready.catch(() => undefined);
        if (!options.spare || !this.entries.has(target.serverId)) this.entries.set(target.serverId, entry);
        this.live.add(entry);
        return entry;
    }

    // One deadline (readyTimeout) for the whole route: the jump connection,
    // the forwarded channel through it and the handshake. A target behind a
    // bastion that cannot reach it fails in time instead of after the
    // bastion's TCP connect timeout, and chained hops do not add up.
    private async connect(entry: PoolEntry): Promise<void> {
        const { target } = entry;
        const budget = this.options.readyTimeout;
        const deadline = Date.now() + budget;
        const signal = entry.abort.signal;
        let sock: ClientChannel | undefined;
        try {
            if (target.jump) {
                const jump = target.jump;
                const hop = `${jump.host}:${jump.port}`;
                const destination = `${target.host}:${target.port}`;
                entry.jumpLease = await bounded(
                    this.acquire(jump.serverId),
                    deadline,
                    signal,
                    () => codedError("JUMP_TIMEOUT", `The jump host ${hop} did not answer within ${seconds(budget)}s`, { jump: hop, seconds: seconds(budget) }),
                    (late) => late.release()
                );
                if (entry.cancelled) throw new Error("The SSH connection was cancelled");
                sock = await bounded(
                    forwardOut(entry.jumpLease.client, target.host, target.port),
                    deadline,
                    signal,
                    () => codedError("JUMP_TIMEOUT", `The jump host could not reach ${destination} within ${seconds(budget)}s`, { target: destination, seconds: seconds(budget) }),
                    (late) => late.destroy()
                );
                if (entry.cancelled) throw new Error("The SSH connection was cancelled");
            }
            const pinned = await this.knownHosts.find(target.host, target.port, routeVia(target));
            if (entry.cancelled) throw new Error("The SSH connection was cancelled");
            await this.handshake(entry, sock, pinned?.key_type, Math.max(1, deadline - Date.now()));
        } catch (err) {
            sock?.destroy();
            entry.lastError = err as Error;
            this.end(entry);
            this.handleClose(entry);
            throw err;
        }
    }

    private handshake(entry: PoolEntry, sock: ClientChannel | undefined, pinnedKeyType: string | undefined, readyTimeout: number): Promise<void> {
        const { target, client } = entry;
        const answerPrompts = keyboardInteractiveResponder(target.password);

        return new Promise((resolve, reject) => {
            let settled = false;
            let rejection: Error | null = null;
            let agentError: Error | null = null;
            const settle = (err?: Error) => {
                if (settled) return;
                settled = true;
                if (err) reject(err);
                else resolve();
            };

            client.once("ready", () => settle());
            client.on("error", (err) => {
                if ((err as { level?: string }).level === "agent") {
                    agentError = err;
                    log.debug(`SSH agent not usable for server #${target.serverId}: ${err.message}`);
                    return;
                }
                const failure = withAgentCause(err, agentError);
                entry.lastError = failure;
                settle(rejection ?? failure);
            });
            client.on("close", () => {
                settle(rejection ?? entry.lastError ?? new Error(`The connection to ${target.host}:${target.port} closed during the handshake`));
                this.handleClose(entry);
            });
            client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => finish(answerPrompts(prompts)));

            const config: ConnectConfig = {
                host: target.host,
                port: target.port,
                username: target.username,
                password: target.password,
                privateKey: target.privateKey,
                passphrase: target.passphrase,
                // Forwarding is never set here: only terminal shells ask for it
                // on their own channel (server/ssh/agent.ts shellChannelOptions).
                agent: target.agent ? createAgentFor(target.agent) : undefined,
                sock,
                tryKeyboard: Boolean(target.password),
                keepaliveInterval: this.options.keepaliveInterval,
                keepaliveCountMax: this.options.keepaliveCountMax,
                readyTimeout,
                algorithms: preferPinnedKeyType(pinnedKeyType),
                hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
                    this.verifyHostKey(target, key).then(
                        () => verify(true),
                        (err) => {
                            rejection = err;
                            verify(false);
                        }
                    );
                },
                debug: this.debug ? (message: string) => log.debug(message) : undefined
            };

            try {
                client.connect(config);
            } catch (err) {
                // e.g. "Cannot parse privateKey": thrown before any socket exists.
                settle(err as Error);
            }
        });
    }

    private async verifyHostKey(target: SshTarget, key: Buffer): Promise<void> {
        const fingerprint = sshFingerprint(key);
        const keyType = sshKeyType(key);
        const { host, port } = target;
        const via = routeVia(target);

        const known = await this.knownHosts.find(host, port, via);
        if (known) {
            if (known.fingerprint !== fingerprint) throw new HostKeyMismatchError(host, port, keyType, known.fingerprint, fingerprint, via);
            return;
        }

        const pinned = await this.knownHosts.pin({ host, port, via, key_type: keyType, fingerprint });
        if (pinned.fingerprint !== fingerprint) throw new HostKeyMismatchError(host, port, keyType, pinned.fingerprint, fingerprint, via);
        this.events.emit("host-key-trusted", { serverId: target.serverId, host, port, via, keyType, fingerprint } satisfies HostKeyTrustedEvent);
    }

    private lease(entry: PoolEntry): SshLease {
        let released = false;
        const listeners = new Set<(err?: Error) => void>();

        const lease: SshLease = {
            serverId: entry.serverId,
            client: entry.client,
            target: entry.target,
            release: () => {
                if (released) return;
                released = true;
                for (const listener of listeners) entry.closeListeners.delete(listener);
                listeners.clear();
                entry.refs -= 1;
                if (entry.refs === 0) this.whenUnused(entry);
            },
            onClose: (listener) => {
                if (released) return () => undefined;
                if (entry.closed) {
                    queueMicrotask(() => listener(entry.lastError));
                    return () => undefined;
                }
                const wrapped = (err?: Error) => listener(err);
                listeners.add(wrapped);
                entry.closeListeners.add(wrapped);
                return () => {
                    listeners.delete(wrapped);
                    entry.closeListeners.delete(wrapped);
                };
            }
        };
        this.leaseEntries.set(lease, entry);
        leasePools.set(lease, this);
        return lease;
    }

    // The lease is on the server's current connection, which also carries
    // its status, ops, log and file channels (not on a spare one).
    isPrimary(lease: SshLease): boolean {
        const entry = this.leaseEntries.get(lease);
        return entry !== undefined && this.entries.get(entry.serverId) === entry;
    }

    // The connection of `lease` looks dead (a channel request went
    // unanswered): no new leases of it, so the next user gets a fresh one.
    // Its holders keep it until they release it or keepalives close it.
    retireConnection(lease: SshLease): void {
        const entry = this.leaseEntries.get(lease);
        if (entry && !entry.closed) this.retire(entry);
    }

    private whenUnused(entry: PoolEntry): void {
        if (entry.closed) return;
        if (entry.stale) {
            this.end(entry);
            return;
        }
        this.clearIdle(entry);
        entry.idleTimer = setTimeout(() => {
            entry.idleTimer = null;
            if (entry.refs === 0) this.retire(entry);
        }, this.options.idleTimeoutMs);
        entry.idleTimer.unref?.();
    }

    private retire(entry: PoolEntry): void {
        entry.stale = true;
        if (this.entries.get(entry.serverId) === entry) this.entries.delete(entry.serverId);
        if (entry.refs === 0) this.end(entry);
    }

    private end(entry: PoolEntry): void {
        entry.stale = true;
        entry.cancelled = true;
        entry.abort.abort();
        this.clearIdle(entry);
        if (this.entries.get(entry.serverId) === entry) this.entries.delete(entry.serverId);
        entry.client.end();
    }

    private handleClose(entry: PoolEntry): void {
        if (entry.closed) return;
        entry.closed = true;
        entry.stale = true;
        this.clearIdle(entry);
        this.live.delete(entry);
        if (this.entries.get(entry.serverId) === entry) this.entries.delete(entry.serverId);

        const jumpLease = entry.jumpLease;
        entry.jumpLease = null;
        jumpLease?.release();

        const listeners = [...entry.closeListeners];
        entry.closeListeners.clear();
        for (const listener of listeners) {
            try {
                listener(entry.lastError);
            } catch (err) {
                log.error("SSH close listener failed:", err);
            }
        }
    }

    private clearIdle(entry: PoolEntry): void {
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
    }
}

export function pooledLease(lease: object): { pool: SshPool; lease: SshLease } | null {
    const pool = leasePools.get(lease);
    return pool ? { pool, lease: lease as SshLease } : null;
}

export const sshPool = new SshPool();
