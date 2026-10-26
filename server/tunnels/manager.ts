import net from "net";
import type { ClientChannel } from "ssh2";
import {
    describeTunnel,
    formatHostPort,
    isWildcardHost,
    supportsTunnels,
    type TunnelErrorCode,
    type TunnelErrorDetails,
    type TunnelErrorInfo,
    type TunnelState,
    type TunnelStatus,
    type TunnelView
} from "../../shared/tunnels";
import type { AuditInput, Tunnel } from "../../shared/types";
import { recordAudit } from "../db/auditRepo";
import { AppError, errorMessage } from "../errors";
import { createLogger } from "../logger";
import { HostKeyMismatchError } from "../ssh/hostKeys";
import { describeSshError, sshPool, type SshLease } from "../ssh/pool";
import { auditTunnel } from "./audit";
import { tunnelsRepo } from "./repo";

// SSH local port forwarding (`ssh -L`): a TCP listener on this machine whose
// connections are forwarded through the saved server's pooled SSH connection
// (and its jump hosts) to remote_host:remote_port as the server sees it.

const log = createLogger("tunnels");

export interface TunnelPool {
    acquire(serverId: number): Promise<SshLease>;
}

export type TunnelManagerOptions = {
    pool?: TunnelPool;
    audit?: (input: AuditInput) => Promise<unknown>;
    loadAutoStart?: () => Promise<Tunnel[]>;
    // How long a client may keep its side open after the remote service closed.
    lingerMs?: number;
};

type Starting = {
    // The endpoints being started.
    tunnel: Tunnel;
    promise: Promise<TunnelStatus>;
};

type Runtime = {
    // The configuration it runs (or last ran) with.
    tunnel: Tunnel;
    state: TunnelState;
    server: net.Server | null;
    sockets: Set<net.Socket>;
    channels: Set<ClientChannel>;
    // Held while listening so the SSH connection stays open between client
    // connections, like `ssh -L` does.
    keeper: SshLease | null;
    // Bumped by every start and stop: async work of an older run gives up.
    generation: number;
    // The start in progress, which later starts of the same endpoints share.
    // A stop drops it, so the next start begins afresh.
    starting: Starting | null;
    // Rejects the start that is waiting for its SSH connection right away
    // (called by shutdown), instead of after the handshake settles.
    cancelStart: (() => void) | null;
    totalConnections: number;
    bytesIn: number;
    bytesOut: number;
    startedAt: number | null;
    lastError: TunnelErrorInfo | null;
};

type TunnelFailure = AppError | HostKeyMismatchError;

// SSH_MSG_CHANNEL_OPEN_FAILURE reason codes (RFC 4254, 5.1) that mean the
// server does not forward at all, as opposed to 2 (connect failed).
const OPEN_ADMINISTRATIVELY_PROHIBITED = 1;
const OPEN_UNKNOWN_CHANNEL_TYPE = 3;

export const STOPPED_STATUS: TunnelStatus = Object.freeze({
    state: "stopped",
    activeConnections: 0,
    totalConnections: 0,
    bytesOut: 0,
    bytesIn: 0,
    startedAt: null,
    lastError: null
});

function tunnelError(code: TunnelErrorCode, message: string, status: number, details?: Record<string, unknown>): AppError {
    return new AppError(code, message, status, details);
}

function listenFailure(err: unknown, tunnel: Tunnel): AppError {
    const address = formatHostPort(tunnel.local_host, tunnel.local_port);
    const details = { host: tunnel.local_host, port: tunnel.local_port };
    switch ((err as NodeJS.ErrnoException)?.code) {
        case "EADDRINUSE":
            return tunnelError("PORT_IN_USE", `${address} is already in use by another program. Pick another local port.`, 409, details);
        case "EACCES":
            return tunnelError(
                "PORT_ACCESS_DENIED",
                `Not allowed to listen on ${address}: ports below 1024 need administrator rights, and Windows reserves some port ranges. Pick another local port.`,
                409,
                details
            );
        case "EADDRNOTAVAIL":
            return tunnelError("BIND_ADDRESS_UNAVAILABLE", `${tunnel.local_host} is not an address of this machine.`, 409, details);
        default:
            return tunnelError("LISTEN_FAILED", `Could not listen on ${address}: ${errorMessage(err)}`, 409, details);
    }
}

function sshFailure(err: unknown): TunnelFailure {
    if (err instanceof AppError || err instanceof HostKeyMismatchError) return err;
    return tunnelError("SSH_CONNECT_FAILED", `Could not open the SSH connection: ${describeSshError(err)}`, 502);
}

function startCancelled(tunnel: Tunnel): AppError {
    return tunnelError(
        "TUNNEL_START_CANCELLED",
        `The start of ${describeTunnel(tunnel)} was cancelled: the tunnel was stopped, or restarted with other settings, while it was starting.`,
        409
    );
}

// The parts of a failure's details the UI explains it with.
function errorDetails(failure: TunnelFailure): TunnelErrorDetails | undefined {
    if (!(failure instanceof AppError) || !failure.details) return undefined;
    const { host, port, tunnelId, tunnelName } = failure.details;
    const details: TunnelErrorDetails = {
        ...(typeof host === "string" ? { host } : {}),
        ...(typeof port === "number" ? { port } : {}),
        ...(typeof tunnelId === "number" ? { tunnelId } : {}),
        ...(typeof tunnelName === "string" ? { tunnelName } : {})
    };
    return Object.keys(details).length ? details : undefined;
}

// Both listeners would claim the same local port.
function sameLocalPort(a: Tunnel, b: Tunnel): boolean {
    if (a.local_port !== b.local_port) return false;
    return a.local_host === b.local_host || isWildcardHost(a.local_host) || isWildcardHost(b.local_host);
}

function sameEndpoints(a: Tunnel, b: Tunnel): boolean {
    return a.server_id === b.server_id
        && a.local_host === b.local_host
        && a.local_port === b.local_port
        && a.remote_host === b.remote_host
        && a.remote_port === b.remote_port;
}

// Rejects as well when the server is closed first (a stop while the address
// is being looked up): it then never listens.
function listen(server: net.Server, host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const settle = (err?: Error) => {
            server.off("error", settle);
            server.off("close", onClose);
            server.off("listening", onListening);
            if (err) reject(err);
            else resolve();
        };
        const onClose = () => settle(new Error("The listener was closed before it started"));
        const onListening = () => settle();
        server.once("error", settle);
        server.once("close", onClose);
        server.once("listening", onListening);
        server.listen({ host, port, exclusive: true });
    });
}

// Resolves once the listener is closed (immediately if it never listened).
function closeServer(server: net.Server): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
}

function destroyQuietly(stream: { destroy(): unknown }): void {
    try {
        stream.destroy();
    } catch (err) {
        log.debug(`Closing a forwarded stream failed: ${errorMessage(err)}`);
    }
}

export class TunnelManager {
    private readonly pool: TunnelPool;
    private readonly audit: (input: AuditInput) => Promise<unknown>;
    private readonly loadAutoStart: () => Promise<Tunnel[]>;
    private readonly lingerMs: number;
    private readonly runtimes = new Map<number, Runtime>();

    constructor(options: TunnelManagerOptions = {}) {
        this.pool = options.pool ?? sshPool;
        this.audit = options.audit ?? recordAudit;
        this.loadAutoStart = options.loadAutoStart ?? (() => tunnelsRepo.listAutoStart());
        this.lingerMs = options.lingerMs ?? 10_000;
    }

    status(id: number): TunnelStatus {
        const runtime = this.runtimes.get(id);
        return runtime ? this.snapshot(runtime) : { ...STOPPED_STATUS };
    }

    view(tunnel: Tunnel): TunnelView {
        return { ...tunnel, status: this.status(tunnel.id) };
    }

    // Listening, or on its way there.
    isRunning(id: number): boolean {
        const runtime = this.runtimes.get(id);
        return !!runtime && (runtime.starting !== null || runtime.state === "listening" || runtime.state === "starting");
    }

    // Starts listening and opens (or reuses) the SSH connection; resolves once
    // it listens. Rejects with an AppError (PORT_IN_USE, SSH_CONNECT_FAILED, a
    // connection target code, TUNNEL_START_CANCELLED when a stop or a restart
    // with other endpoints overtook it) or a HostKeyMismatchError; the status
    // reports every failure but a cancellation. Starting a running tunnel with
    // other endpoints restarts it.
    start(tunnel: Tunnel): Promise<TunnelStatus> {
        const runtime = this.runtime(tunnel);
        if (runtime.starting && sameEndpoints(runtime.starting.tunnel, tunnel)) return runtime.starting.promise;
        if (!runtime.starting && runtime.state === "listening" && sameEndpoints(runtime.tunnel, tunnel)) {
            runtime.tunnel = tunnel;
            return Promise.resolve(this.snapshot(runtime));
        }
        const promise = this.run(runtime, tunnel).finally(() => {
            if (runtime.starting?.promise === promise) runtime.starting = null;
        });
        runtime.starting = { tunnel, promise };
        return promise;
    }

    // Closes the listener and every forwarded connection; a start in progress
    // is cancelled.
    async stop(id: number): Promise<TunnelStatus> {
        const runtime = this.runtimes.get(id);
        if (!runtime) return { ...STOPPED_STATUS };
        runtime.starting = null;
        await this.shutdown(runtime);
        return this.snapshot(runtime);
    }

    // The saved row changed: a running tunnel restarts when its endpoints did.
    // A failure of a stopped tunnel is about the old endpoints: it is dropped.
    async reconfigure(tunnel: Tunnel): Promise<TunnelStatus> {
        const runtime = this.runtimes.get(tunnel.id);
        if (!runtime) return { ...STOPPED_STATUS };
        const current = runtime.starting?.tunnel ?? runtime.tunnel;
        if (sameEndpoints(current, tunnel)) {
            runtime.tunnel = tunnel;
            return this.snapshot(runtime);
        }
        if (this.isRunning(tunnel.id)) {
            await this.stop(tunnel.id);
            return this.start(tunnel);
        }
        Object.assign(runtime, { tunnel, state: "stopped", lastError: null } satisfies Partial<Runtime>);
        return this.snapshot(runtime);
    }

    // Stops the tunnel and drops its status (the row was deleted).
    async forget(id: number): Promise<void> {
        await this.stop(id);
        this.runtimes.delete(id);
    }

    // Every tunnel of a deleted server.
    async forgetServer(serverId: number): Promise<void> {
        await Promise.all(this.idsOfServer(serverId).map((id) => this.forget(id)));
    }

    // A saved server was edited (its pooled connection is no longer handed
    // out). Tunnels of a server that is no longer an SSH server stop; the
    // others let go of the old SSH connection, and their next forwarded
    // connection opens one with the new settings.
    async serverUpdated(server: { id: number; type: string }): Promise<void> {
        if (!supportsTunnels(server.type)) {
            await this.forgetServer(server.id);
            return;
        }
        for (const id of this.idsOfServer(server.id)) {
            const runtime = this.runtimes.get(id);
            if (runtime) this.release(runtime);
        }
    }

    async stopAll(): Promise<void> {
        await Promise.all([...this.runtimes.keys()].map((id) => this.stop(id)));
    }

    // Starts the tunnels saved with auto_start (backend startup). Failures are
    // logged, audited and reported in their status; they never throw.
    async startAutoStart(): Promise<{ started: number; failed: number }> {
        let tunnels: Tunnel[];
        try {
            tunnels = await this.loadAutoStart();
        } catch (err) {
            log.error("Could not load the tunnels to start automatically", err);
            return { started: 0, failed: 0 };
        }

        const results = await Promise.all(tunnels.map(async (tunnel) => {
            try {
                await this.start(tunnel);
                await auditTunnel("auto-start", tunnel, undefined, this.audit);
                return true;
            } catch (err) {
                const failure = sshFailure(err);
                log.warn(`Tunnel #${tunnel.id} (${describeTunnel(tunnel)}) did not start: ${failure.message}`);
                await auditTunnel("auto-start", tunnel, { code: failure.code, message: failure.message }, this.audit);
                return false;
            }
        }));
        const started = results.filter(Boolean).length;
        if (tunnels.length) log.info(`Started ${started} of ${tunnels.length} tunnel(s) set to start automatically`);
        return { started, failed: tunnels.length - started };
    }

    private idsOfServer(serverId: number): number[] {
        return [...this.runtimes.values()].filter((runtime) => runtime.tunnel.server_id === serverId).map((runtime) => runtime.tunnel.id);
    }

    private runtime(tunnel: Tunnel): Runtime {
        let runtime = this.runtimes.get(tunnel.id);
        if (!runtime) {
            runtime = {
                tunnel,
                state: "stopped",
                server: null,
                sockets: new Set(),
                channels: new Set(),
                keeper: null,
                generation: 0,
                starting: null,
                cancelStart: null,
                totalConnections: 0,
                bytesIn: 0,
                bytesOut: 0,
                startedAt: null,
                lastError: null
            };
            this.runtimes.set(tunnel.id, runtime);
        }
        return runtime;
    }

    private snapshot(runtime: Runtime): TunnelStatus {
        return {
            state: runtime.state,
            activeConnections: runtime.sockets.size,
            totalConnections: runtime.totalConnections,
            bytesOut: runtime.bytesOut,
            bytesIn: runtime.bytesIn,
            startedAt: runtime.startedAt,
            lastError: runtime.lastError
        };
    }

    private async run(runtime: Runtime, tunnel: Tunnel): Promise<TunnelStatus> {
        if (this.isRunning(tunnel.id)) {
            // Restart: the run in place (or in progress) gives up first.
            const closing = this.shutdown(runtime);
            const restart = runtime.generation;
            await closing;
            if (runtime.generation !== restart) throw startCancelled(tunnel);
        }

        const clash = [...this.runtimes.values()].find((other) =>
            other !== runtime && this.isRunning(other.tunnel.id) && sameLocalPort(other.starting?.tunnel ?? other.tunnel, tunnel));
        if (clash) {
            const address = formatHostPort(tunnel.local_host, tunnel.local_port);
            const name = clash.tunnel.name || describeTunnel(clash.tunnel);
            runtime.tunnel = tunnel;
            throw this.fail(runtime, tunnelError("PORT_IN_USE", `${address} is already used by the tunnel "${name}". Stop it or pick another local port.`, 409, {
                host: tunnel.local_host,
                port: tunnel.local_port,
                tunnelId: clash.tunnel.id,
                tunnelName: name
            }));
        }

        const generation = ++runtime.generation;
        Object.assign(runtime, {
            tunnel,
            state: "starting",
            lastError: null,
            totalConnections: 0,
            bytesIn: 0,
            bytesOut: 0,
            startedAt: Date.now()
        } satisfies Partial<Runtime>);

        // Paused until the SSH channel is open, so nothing is read too early.
        const server = net.createServer({ allowHalfOpen: true, pauseOnConnect: true });
        server.on("connection", (socket) => this.forward(runtime, generation, socket));
        runtime.server = server;
        try {
            await listen(server, tunnel.local_host, tunnel.local_port);
        } catch (err) {
            if (runtime.generation !== generation) throw startCancelled(tunnel);
            runtime.server = null;
            throw this.fail(runtime, listenFailure(err, tunnel));
        }
        server.on("error", (err) => log.warn(`Tunnel #${tunnel.id} listener error: ${err.message}`));
        if (runtime.generation !== generation) {
            await closeServer(server);
            throw startCancelled(tunnel);
        }

        let lease: SshLease;
        const acquiring = this.pool.acquire(tunnel.server_id);
        try {
            lease = await new Promise<SshLease>((resolve, reject) => {
                runtime.cancelStart = () => reject(startCancelled(tunnel));
                acquiring.then(resolve, reject);
            });
        } catch (err) {
            if (runtime.generation !== generation) {
                // A connection that opens after all goes back to the pool.
                acquiring.then((late) => late.release(), () => undefined);
                throw startCancelled(tunnel);
            }
            const failure = sshFailure(err);
            // The failure is recorded before the port is freed: a start that
            // comes in meanwhile must not be overwritten by it.
            const closing = this.shutdown(runtime);
            this.fail(runtime, failure);
            await closing;
            throw failure;
        }
        if (runtime.generation !== generation) {
            lease.release();
            throw startCancelled(tunnel);
        }
        runtime.cancelStart = null;

        this.hold(runtime, generation, lease);
        runtime.state = "listening";
        log.info(`Tunnel #${tunnel.id} listening: ${describeTunnel(tunnel)}`);
        return this.snapshot(runtime);
    }

    private fail(runtime: Runtime, failure: TunnelFailure): TunnelFailure {
        runtime.state = "error";
        runtime.startedAt = null;
        const details = errorDetails(failure);
        runtime.lastError = { code: failure.code, message: failure.message, at: Date.now(), ...(details ? { details } : {}) };
        return failure;
    }

    private noteError(runtime: Runtime, generation: number, code: string, message: string): void {
        if (runtime.generation !== generation) return;
        runtime.lastError = { code, message, at: Date.now() };
        log.debug(`Tunnel #${runtime.tunnel.id}: ${message}`);
    }

    // Stops the current run: no new connections, open ones are dropped.
    // Resolves once the port is free and every lease is handed back.
    private async shutdown(runtime: Runtime): Promise<void> {
        runtime.generation += 1;
        const cancelStart = runtime.cancelStart;
        runtime.cancelStart = null;
        cancelStart?.();
        runtime.state = "stopped";
        runtime.startedAt = null;
        const server = runtime.server;
        runtime.server = null;
        this.release(runtime);
        const closing = [...runtime.sockets].map((socket) => new Promise<void>((resolve) => {
            if (socket.closed) resolve();
            else socket.once("close", () => resolve());
            socket.destroy();
        }));
        for (const channel of runtime.channels) destroyQuietly(channel);
        runtime.channels.clear();
        await Promise.all([...closing, server ? closeServer(server) : undefined]);
    }

    private hold(runtime: Runtime, generation: number, lease: SshLease): void {
        runtime.keeper = lease;
        lease.onClose((err) => {
            if (runtime.keeper !== lease) return;
            runtime.keeper = null;
            lease.release();
            if (runtime.state !== "listening") return;
            const reason = err ? `: ${describeSshError(err)}` : "";
            this.noteError(runtime, generation, "SSH_DISCONNECTED", `The SSH connection closed${reason}. It is opened again for the next connection.`);
        });
    }

    private release(runtime: Runtime): void {
        const keeper = runtime.keeper;
        runtime.keeper = null;
        keeper?.release();
    }

    // A connection was forwarded over another SSH connection than the held one
    // (it closed, or the server was edited): hold the current one instead.
    private refreshHold(runtime: Runtime, generation: number, lease: SshLease): void {
        if (runtime.generation !== generation || runtime.state !== "listening") return;
        if (runtime.keeper?.client === lease.client) return;
        this.pool.acquire(runtime.tunnel.server_id).then((fresh) => {
            if (runtime.generation !== generation || runtime.keeper?.client === fresh.client) {
                fresh.release();
                return;
            }
            const previous = runtime.keeper;
            this.hold(runtime, generation, fresh);
            previous?.release();
        }, (err) => log.debug(`Tunnel #${runtime.tunnel.id}: could not hold the SSH connection: ${errorMessage(err)}`));
    }

    private forward(runtime: Runtime, generation: number, socket: net.Socket): void {
        socket.on("error", (err) => log.debug(`Tunnel #${runtime.tunnel.id}: local connection error: ${err.message}`));
        if (runtime.generation !== generation) {
            socket.destroy();
            return;
        }

        const { tunnel } = runtime;
        const remote = formatHostPort(tunnel.remote_host, tunnel.remote_port);
        runtime.sockets.add(socket);
        runtime.totalConnections += 1;

        let lease: SshLease | null = null;
        let channel: ClientChannel | null = null;
        let finished = false;
        socket.once("close", () => {
            finished = true;
            runtime.sockets.delete(socket);
            if (channel) {
                runtime.channels.delete(channel);
                destroyQuietly(channel);
            }
            lease?.release();
        });

        this.pool.acquire(tunnel.server_id).then((acquired) => {
            if (finished || runtime.generation !== generation) {
                acquired.release();
                socket.destroy();
                return;
            }
            lease = acquired;
            acquired.onClose(() => socket.destroy());
            this.refreshHold(runtime, generation, acquired);

            const onChannel = (err: (Error & { reason?: unknown }) | undefined, stream: ClientChannel) => {
                if (err) {
                    const description = err.message.replace(/^\(SSH\) Channel open failure:\s*/, "");
                    if (err.reason === OPEN_ADMINISTRATIVELY_PROHIBITED || err.reason === OPEN_UNKNOWN_CHANNEL_TYPE) {
                        this.noteError(runtime, generation, "FORWARDING_DENIED",
                            `The SSH server does not allow forwarding to ${remote} (AllowTcpForwarding / PermitOpen): ${description || "administratively prohibited"}`);
                    } else {
                        this.noteError(runtime, generation, "REMOTE_UNREACHABLE", `The server could not connect to ${remote}: ${description || "refused"}`);
                    }
                    socket.destroy();
                    return;
                }
                stream.on("error", (channelErr: Error) => log.debug(`Tunnel #${tunnel.id}: channel error: ${channelErr.message}`));
                if (finished || runtime.generation !== generation) {
                    destroyQuietly(stream);
                    socket.destroy();
                    return;
                }
                channel = stream;
                this.pipe(runtime, socket, stream);
            };
            try {
                acquired.client.forwardOut(socket.remoteAddress ?? "127.0.0.1", socket.remotePort ?? 0, tunnel.remote_host, tunnel.remote_port, onChannel);
            } catch (err) {
                // "Not connected": the SSH connection closed under us.
                this.noteError(runtime, generation, "SSH_DISCONNECTED", `The SSH connection closed: ${errorMessage(err)}`);
                socket.destroy();
            }
        }, (err) => {
            const failure = sshFailure(err);
            this.noteError(runtime, generation, failure.code, failure.message);
            socket.destroy();
        });
    }

    private pipe(runtime: Runtime, socket: net.Socket, channel: ClientChannel): void {
        runtime.channels.add(channel);
        channel.on("data", (chunk: Buffer) => { runtime.bytesIn += chunk.length; });
        socket.on("data", (chunk: Buffer) => { runtime.bytesOut += chunk.length; });
        channel.once("close", () => {
            runtime.channels.delete(channel);
            // Deliver what the service sent, then let the client go.
            socket.end(() => socket.destroy());
            setTimeout(() => socket.destroy(), this.lingerMs).unref();
        });
        // Half-closes travel both ways (EOF from the client reaches the service
        // while its answer still flows back).
        socket.pipe(channel);
        channel.pipe(socket);
    }
}

export const tunnelManager = new TunnelManager();
