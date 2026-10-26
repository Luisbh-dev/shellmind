import type { Readable } from "stream";
import type { Client, ClientChannel, SFTPWrapper } from "ssh2";
import { CLI_SUBCOMMANDS } from "../../shared/cliPresets";
import type { OpsCapabilities } from "../../shared/ops";
import type { AnyTerminalAttach, TerminalAttach } from "../../shared/protocol";
import { cliPresetInfo } from "../../shared/shells";
import type { ConnectionError, TerminalNotice } from "../../shared/terminal";
import { AppError, errorMessage } from "../errors";
import { loadConnectionTarget, type FtpTarget, type LocalTarget, type S3Target, type SessionTarget, type SshTarget } from "../connections/target";
import { recordAudit } from "../db/auditRepo";
import { cliHistoryKey, settingsRepo } from "../db/settingsRepo";
import { connectFtpFs, createS3Fs, createSftpFs } from "../files/connect";
import type { FtpFs } from "../files/ftpFs";
import { checkCommandExists, detectLocalContext } from "../local/detect";
import { startLocalTerminal, type LocalTermHandle, type LocalTermHandlers } from "../local/pty";
import { startScopedCli } from "../local/scopedCli";
import { createLogger } from "../logger";
import { getCapabilities } from "../ops/capabilities";
import { containerShellCommand, hangUpContainerShell, newTerminalTag, parseTerminalAttach, requireRunningContainer } from "../ops/containerShell";
import { requestShellChannel } from "../ssh/agent";
import { connectionError } from "../ssh/connectionErrors";
import { exec, MAX_EXEC_CHANNELS, MAX_STREAM_CHANNELS } from "../ssh/exec";
import { HostKeyMismatchError, routeVia } from "../ssh/hostKeys";
import { describeSshError, isChannelRefused, MAX_SPARE_CONNECTIONS, sshPool, type SshLease } from "../ssh/pool";
// --- W8-T2 Kubernetes pod shells ---
import type { PodTerminalAttach } from "../../shared/k8s";
import { hangUpPodShell, preparePodShell, type PodShell } from "../k8s/shell";
import { parsePodAttach } from "../k8s/validate";
import { handleFtpShellInput } from "./ftpShell";
import { trustChangedHostKey } from "./hostKeyTrust";
import { isCurrent, resetConnection, type SocketSession } from "./session";
import { failure, ftpError } from "./terminalErrors";
import { TerminalOutput, Utf8Boundary } from "./terminalOutput";

const log = createLogger("terminal");

const OS_PROBE_TIMEOUT_MS = 10_000;
// The probe prints one line; a server printing without end gets cut short.
const OS_PROBE_MAX_BYTES = 64 * 1024;
const OS_NAME_MAX_CHARS = 200;
// Terminal shells per pooled connection. OpenSSH allows 10 sessions per
// connection (MaxSessions). The server's primary connection also carries the
// exec and stream channels of status, ops and logs (ssh/exec.ts) and one
// SFTP session, which keep theirs: further shells open on a spare connection
// instead of starving them. Spares carry shells only (and, when a server with
// a lower MaxSessions refuses a channel, a command moved there).
const SSHD_MAX_SESSIONS = 10;
export const MAX_SHELLS_PER_CONNECTION = SSHD_MAX_SESSIONS - MAX_EXEC_CHANNELS - MAX_STREAM_CHANNELS - 1;
export const MAX_SHELLS_PER_SPARE = SSHD_MAX_SESSIONS - 1;

/* eslint-disable-next-line no-control-regex -- Ctrl+C and Ctrl+\ */
const INTERRUPT = /[\x03\x1c]/;

// Shells open (or opening) per pooled connection.
const shellCounts = new WeakMap<Client, number>();

// Takes a shell slot on the connection; returns its release (idempotent), or
// null when the connection already has `max` shells.
function takeShellSlot(client: Client, max: number): (() => void) | null {
    const count = shellCounts.get(client) ?? 0;
    if (count >= max) return null;
    shellCounts.set(client, count + 1);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        shellCounts.set(client, Math.max(0, (shellCounts.get(client) ?? 1) - 1));
    };
}

// Sends what the terminal printed so far, then the notice (in that order).
function notify(session: SocketSession, notice: TerminalNotice): void {
    session.output?.flush();
    session.socket.emit("terminal-notice", notice);
}

// The session failed: `legacy` is the English text older listeners (the file
// manager) show, `error` the same failure for the client to translate.
function reportError(session: SocketSession, legacy: string, error: ConnectionError): void {
    session.connectionError = legacy;
    session.output?.flush();
    session.socket.emit("ssh-error", legacy, error);
}

function clampSize(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 1000 ? value : fallback;
}

// Ctrl+C or Ctrl+\ during a flood: drops the output held back for a lagging
// client, so the prompt comes back at once.
function interruptOutput(session: SocketSession): void {
    const dropped = session.output?.interrupt() ?? 0;
    if (dropped > 0) notify(session, { kind: "output-discarded", bytes: dropped });
}

// Terminal sessions: start-ssh opens the socket's backend connection to a
// saved server (local shell or scoped CLI, S3, FTP or SSH), then ssh-input,
// resize and ssh-ack drive it. Each terminal tab of the UI is its own socket;
// SSH tabs of one server share the pooled connection.
export function registerTerminalHandlers(session: SocketSession): void {
    const { socket } = session;

    socket.on("start-ssh", async (payload) => {
        const generation = resetConnection(session);
        session.termCols = clampSize(payload?.cols, session.termCols);
        session.termRows = clampSize(payload?.rows, session.termRows);
        const purpose = payload?.purpose === "files" ? "files" : "terminal";

        let target: SessionTarget;
        let attach: AnyTerminalAttach | null;
        try {
            // W7-S3: a terminal inside a container of the server; W8-T2:
            // inside a Kubernetes pod's container.
            attach = purpose === "terminal" ? parseAttach(payload?.attach) : null;
            target = await loadConnectionTarget(payload?.serverId, purpose);
            if (attach?.kind === "container" && target.kind !== "ssh") {
                throw new AppError("CONTAINER_SHELL_UNSUPPORTED", "Container shells need an SSH connection to a Linux server.", 409);
            }
            if (attach?.kind === "pod" && target.kind !== "ssh" && target.kind !== "local") {
                throw new AppError("K8S_UNSUPPORTED", "Pod shells need an SSH connection to a Linux server, or a local kubectl connection.", 409);
            }
        } catch (err) {
            if (!isCurrent(session, generation)) return;
            reportError(session, errorMessage(err), connectionError(err));
            return;
        }
        if (!isCurrent(session, generation)) return;

        log.info(`start-ssh: server #${target.serverId} (${target.kind}, ${purpose}${attach ? `, ${describeAttach(attach)}` : ""})`);
        switch (target.kind) {
            case "local":
                if (attach?.kind === "pod") await openLocalPodShell(session, target, generation, attach);
                else await openLocalSession(session, target, generation);
                return;
            case "s3":
                openS3Session(session, target);
                return;
            case "ftp":
                await openFtpSession(session, target, purpose, generation);
                return;
            case "ssh":
                await openSshSession(session, target, purpose, generation, attach);
                return;
        }
    });

    socket.on("ssh-input", async (data: string) => {
        if (typeof data !== "string") return;
        if (INTERRUPT.test(data)) interruptOutput(session);

        if (session.connectionType === "local") {
            session.localTerm?.write(data);
            return;
        }

        if (session.connectionType === "ftp") {
            await handleFtpShellInput(session, data);
            return;
        }

        if (session.sshStream?.writable) {
            session.sshStream.write(data);
        }
    });

    socket.on("resize", (size) => {
        const cols = clampSize(size?.cols, session.termCols);
        const rows = clampSize(size?.rows, session.termRows);
        if (cols === session.termCols && rows === session.termRows) return;
        session.termCols = cols;
        session.termRows = rows;
        session.sshStream?.setWindow(rows, cols, 0, 0);
        session.localTerm?.resize(cols, rows);
    });

    socket.on("ssh-ack", (bytes) => {
        session.output?.ack(bytes);
    });

    socket.on("trust-host-key", async (payload, ack) => {
        if (typeof ack !== "function") return;
        try {
            ack(await trustChangedHostKey(payload));
        } catch (err) {
            log.error(`Could not trust the new host key: ${errorMessage(err)}`);
            ack({ ok: false, code: "INTERNAL_ERROR", error: errorMessage(err) });
        }
    });
}

// The batched output stream of a new terminal session (binary frames).
function createOutput(session: SocketSession): TerminalOutput {
    const output = new TerminalOutput((data) => session.socket.emit("ssh-output", data));
    session.output = output;
    return output;
}

async function openLocalSession(session: SocketSession, target: LocalTarget, generation: number): Promise<void> {
    const { socket } = session;
    session.connectionType = "local";
    const output = createOutput(session);
    try {
        // A replaced session's process may still print or exit while it is
        // being killed; only the current one talks to the socket.
        const handlers: LocalTermHandlers = {
            onData: (chunk) => {
                if (isCurrent(session, generation)) output.write(chunk);
            },
            onExit: () => {
                if (!isCurrent(session, generation)) return;
                session.localTerm = null;
                notify(session, { kind: "session-ended" });
                socket.emit("ssh-closed");
            }
        };

        // Known cloud/container CLIs run as a SCOPED console (a `<bin>>`
        // prompt that only runs that tool), not a full shell. "shell"/"custom"
        // presets open the real shell or the configured program.
        const presetInfo = cliPresetInfo(target.cliPreset);
        let handle: LocalTermHandle;
        if (presetInfo) {
            const exists = await checkCommandExists(presetInfo.bin);
            if (!isCurrent(session, generation)) return;

            // Per-server command history persisted in the settings table.
            const historyKey = cliHistoryKey(target.serverId);
            let initialHistory: string[] = [];
            try {
                const raw = await settingsRepo.get(historyKey);
                const parsed: unknown = raw ? JSON.parse(raw) : [];
                if (Array.isArray(parsed)) initialHistory = parsed.filter((entry): entry is string => typeof entry === "string");
            } catch { /* corrupt history: start empty */ }
            if (!isCurrent(session, generation)) return;

            // The console's help line comes before its first prompt.
            notify(session, { kind: "cli-console", name: presetInfo.name, bin: presetInfo.bin, installUrl: exists ? undefined : presetInfo.url });
            handle = startScopedCli(
                {
                    bin: presetInfo.bin,
                    cwd: target.cwd ?? undefined,
                    onRefused: (reason, detail) => {
                        if (isCurrent(session, generation)) notify(session, { kind: "cli-refused", bin: presetInfo.bin, reason, detail });
                    },
                    initialCommand: exists ? target.initialCommand ?? undefined : undefined,
                    subcommands: CLI_SUBCOMMANDS[presetInfo.bin] || [],
                    initialHistory,
                    onHistoryChange: (hist) => {
                        settingsRepo.set(historyKey, JSON.stringify(hist)).catch((err) => {
                            log.warn(`Failed to save the CLI history of server #${target.serverId}: ${errorMessage(err)}`);
                        });
                    }
                },
                handlers
            );
        } else {
            handle = await startLocalTerminal(
                {
                    command: target.command ?? undefined,
                    cwd: target.cwd ?? undefined,
                    initialCommand: target.initialCommand ?? undefined,
                    cols: session.termCols,
                    rows: session.termRows
                },
                handlers
            );
            if (!isCurrent(session, generation)) {
                handle.kill();
                return;
            }
        }
        session.localTerm = handle;
        output.attach(handle);
        socket.emit("connection-ready");

        // Surface the tool/OS version to the chat greeting (best-effort).
        detectLocalContext(presetInfo ? presetInfo.bin : undefined)
            .then((detail) => { if (detail && isCurrent(session, generation)) socket.emit("os-detected", detail); })
            .catch(() => { /* ignore */ });
    } catch (err) {
        log.error(`Local terminal of server #${target.serverId} failed: ${errorMessage(err)}`);
        if (isCurrent(session, generation)) reportError(session, "Local terminal error: " + errorMessage(err), failure("LOCAL_SPAWN_FAILED", err));
    }
}

function openS3Session(session: SocketSession, target: S3Target): void {
    const { socket } = session;
    session.connectionType = "s3";

    try {
        // Listing errors surface on the first files-list.
        session.fs = createS3Fs(target);
        socket.emit("connection-ready");
    } catch (err) {
        log.error(`S3 client of server #${target.serverId} failed: ${errorMessage(err)}`);
        reportError(session, "S3 Error: " + errorMessage(err), failure("S3_CONFIG", err));
    }
}

async function openFtpSession(session: SocketSession, target: FtpTarget, purpose: "terminal" | "files", generation: number): Promise<void> {
    const { socket } = session;
    session.connectionType = "ftp";

    let fs: FtpFs;
    try {
        // FTPS when the server is set up for it; every FTP call of the session
        // (file manager and virtual shell) goes through this connection's queue.
        fs = await connectFtpFs(target);
    } catch (err) {
        if (!isCurrent(session, generation)) return;
        log.warn(`FTP connection to server #${target.serverId} failed: ${errorMessage(err)}`);
        reportError(session, "FTP Error: " + errorMessage(err), ftpError(err));
        return;
    }

    // Replaced or disconnected during the handshake.
    if (!isCurrent(session, generation)) {
        fs.close();
        return;
    }
    session.fs = fs;
    if (purpose === "terminal") socket.emit("terminal-notice", { kind: "connected", protocol: "ftp", target: `${target.host}:${target.port}`, via: [] });
    socket.emit("ftp-ready");
    socket.emit("connection-ready");
}

// host:port of the target and of its jump hosts, nearest first.
function describeRoute(target: SshTarget): { target: string; via: string[] } {
    const via: string[] = [];
    for (let hop = target.jump; hop; hop = hop.jump) via.push(`${hop.host}:${hop.port}`);
    return { target: `${target.host}:${target.port}`, via };
}

// host:port and route of a host key (see routeVia).
const pinKey = (host: string, port: number, via: string) => `${host}:${port}@${via}`;

async function openSshSession(
    session: SocketSession,
    target: SshTarget,
    purpose: "terminal" | "files",
    generation: number,
    attach: AnyTerminalAttach | null = null
): Promise<void> {
    const { socket } = session;
    session.connectionType = "ssh";
    const output = purpose === "terminal" ? createOutput(session) : null;

    // Report host keys pinned while connecting this route (target and jump
    // hosts); the terminal also prints them.
    const route = new Set<string>();
    for (let hop: SshTarget | null = target; hop; hop = hop.jump) route.add(pinKey(hop.host, hop.port, routeVia(hop)));
    const stopTrustNotices = sshPool.onHostKeyTrusted((event) => {
        if (!route.has(pinKey(event.host, event.port, event.via)) || !isCurrent(session, generation)) return;
        socket.emit("host-key-trusted", {
            host: event.host,
            port: event.port,
            keyType: event.keyType,
            fingerprint: event.fingerprint,
            ...(event.via ? { via: event.via } : {})
        });
    });

    let lease: SshLease;
    try {
        lease = await sshPool.acquire(target.serverId);
    } catch (err) {
        if (!isCurrent(session, generation)) return;
        if (err instanceof HostKeyMismatchError) {
            socket.emit("host-key-mismatch", {
                code: "HOST_KEY_MISMATCH",
                host: err.host,
                port: err.port,
                keyType: err.keyType,
                expected: err.expected,
                actual: err.actual,
                ...(err.via ? { via: err.via } : {})
            });
        } else {
            log.warn(`SSH connection to server #${target.serverId} failed: ${describeSshError(err)}`);
        }
        reportError(session, describeSshError(err), connectionError(err));
        return;
    } finally {
        stopTrustNotices();
    }

    if (!isCurrent(session, generation)) {
        lease.release();
        return;
    }
    holdLease(session, lease, purpose);
    const connected: TerminalNotice = { kind: "connected", ...describeRoute(lease.target) };
    if (output) notify(session, connected);
    // A file manager has no terminal to write it in; the event tells that the
    // connection is up and its channel is being opened.
    else socket.emit("terminal-notice", connected);

    if (purpose === "files") {
        openSftp(session, lease, generation, []);
        return;
    }

    if (attach?.kind === "pod") {
        await openPodShell(session, lease, generation, attach);
        return;
    }
    if (attach) {
        await openContainerShell(session, lease, generation, attach);
        return;
    }

    if (!(await openShell(session, lease, generation)) || !session.lease) return;

    // Best-effort OS detection for the sidebar badge and the chat context.
    const osCheckCmd = lease.target.os === "windows" ? "ver" : "grep PRETTY_NAME /etc/os-release || uname -sr";
    exec(session.lease, osCheckCmd, { timeoutMs: OS_PROBE_TIMEOUT_MS, maxOutputBytes: OS_PROBE_MAX_BYTES, truncateOutput: true })
        .then(({ stdout }) => {
            const osName = stdout.replace(/PRETTY_NAME=|"/g, "").trim().split(/\r?\n/)[0]?.slice(0, OS_NAME_MAX_CHARS).trim();
            if (osName && isCurrent(session, generation)) socket.emit("os-detected", osName);
        })
        .catch(() => { /* the badge just stays empty */ });
}

// W7-S3: the terminal is `<engine> exec -it <container> <shell>` on a pty of
// the pooled connection instead of the login shell: the container must be
// running, and opening it is recorded in the audit log (source "ops"). The
// session ends when the shell inside the container exits; when the session
// ends first (tab closed, reconnect, connection lost), the shell is hung up.
async function openContainerShell(session: SocketSession, lease: SshLease, generation: number, attach: TerminalAttach): Promise<void> {
    const stale = () => !isCurrent(session, generation) || session.lease !== lease;
    const tag = newTerminalTag();
    let command: string;
    let caps: OpsCapabilities;
    try {
        if (lease.target.os === "windows") {
            throw new AppError("CONTAINER_SHELL_UNSUPPORTED", "Container shells are available on Linux servers.", 409);
        }
        caps = await getCapabilities(lease, "linux");
        if (stale()) return;
        command = containerShellCommand(caps, attach, tag);
        await requireRunningContainer(lease, caps, attach);
        if (stale()) return;
    } catch (err) {
        if (stale()) return;
        log.info(`Container shell of ${attach.container} on server #${lease.serverId} refused: ${errorMessage(err)}`);
        failChannel(session, lease, errorMessage(err), connectionError(err));
        return;
    }
    try {
        await recordAudit({
            serverId: lease.serverId,
            source: "ops",
            command,
            meta: { kind: "container", action: "shell", target: attach.container, engine: attach.engine, shell: attach.shell ?? "auto" }
        });
    } catch (err) {
        log.error(`Could not record the shell of ${attach.container} in the audit log:`, err);
    }
    if (stale()) return;
    const serverId = lease.serverId;
    await openShell(session, lease, generation, {
        command,
        onClosed: (exited) => {
            if (!exited) endContainerShell(serverId, caps, attach, tag);
        }
    });
}

// Hangs up the shell of a container terminal whose channel closed while the
// shell still ran (the engine would keep it running), on any connection to
// the server, and records that in the audit log. Best effort: a server that
// cannot be reached now keeps the shell.
function endContainerShell(serverId: number, caps: OpsCapabilities, attach: TerminalAttach, tag: string): void {
    void (async () => {
        let lease: SshLease;
        try {
            lease = await sshPool.acquire(serverId);
        } catch (err) {
            log.info(`Could not end the shell in ${attach.container} on server #${serverId}: ${describeSshError(err)}`);
            return;
        }
        try {
            const { command, result, processes } = await hangUpContainerShell(lease, caps, attach, tag);
            if (result.code !== 0) log.info(`Ending the shell in ${attach.container} on server #${serverId} failed (exit ${result.code}): ${result.stdout.trim().slice(0, 300)}`);
            await recordAudit({
                serverId,
                source: "ops",
                command,
                exitCode: result.code,
                meta: { kind: "container", action: "shell-end", target: attach.container, engine: attach.engine, processes }
            });
        } catch (err) {
            log.warn(`Could not end the shell in ${attach.container} on server #${serverId}: ${errorMessage(err)}`);
        } finally {
            lease.release();
        }
    })();
}

// Makes `lease` the session's hold on the pooled connection and reports when
// that connection goes away.
function holdLease(session: SocketSession, lease: SshLease, purpose: "terminal" | "files"): void {
    const { socket } = session;
    session.lease = lease;
    lease.onClose((err) => {
        if (session.lease !== lease) return;
        // ssh2 reports the close before failing the channel opens still
        // pending, whose callbacks then find the lease dropped and stay quiet:
        // a session that was not up yet fails here.
        const wasOpen = purpose === "files" ? session.sftp !== null : session.sshStream !== null;
        dropLease(session, lease);
        session.sshStream = null;
        session.sftp = null;
        const legacy = err ? describeSshError(err) : "The SSH connection closed";
        const error = err ? connectionError(err) : { code: "CONNECTION_CLOSED", message: legacy };
        session.connectionError = legacy;
        if (wasOpen && session.output) notify(session, err ? { kind: "connection-closed", reason: legacy, error } : { kind: "connection-closed" });
        session.output?.flush();
        if (!wasOpen) socket.emit("ssh-error", legacy, error);
        socket.emit("ssh-closed");
    });
}

// Gives up the session's hold on the pooled connection (which stays up for
// its other users).
function dropLease(session: SocketSession, lease: SshLease): void {
    if (session.lease !== lease) return;
    session.lease = null;
    lease.release();
}

// The shell or SFTP channel of a session could not be opened.
function failChannel(session: SocketSession, lease: SshLease, legacy: string, error: ConnectionError): void {
    dropLease(session, lease);
    reportError(session, legacy, error);
}

const channelTimeout = (what: "terminal" | "files", timeoutMs: number): ConnectionError => {
    const seconds = Math.round(timeoutMs / 1000);
    const name = what === "terminal" ? "terminal" : "file session";
    return { code: "CHANNEL_TIMEOUT", message: `The server did not open the ${name} within ${seconds}s.`, details: { what, seconds } };
};

// Bounds the wait for a shell or SFTP channel. A pooled connection can be
// dead without anyone having noticed yet (after sleep or a network change,
// until keepalives catch it): the session then fails after the handshake
// timeout, and the pool stops handing that connection out.
function guardChannelOpen(session: SocketSession, lease: SshLease, generation: number, what: "terminal" | "files"): () => void {
    const timeoutMs = sshPool.options.readyTimeout;
    const timer = setTimeout(() => {
        if (!isCurrent(session, generation) || session.lease !== lease) return;
        sshPool.invalidate(lease.serverId);
        const error = channelTimeout(what, timeoutMs);
        failChannel(session, lease, error.message, error);
    }, timeoutMs);
    return () => clearTimeout(timer);
}

// The connections of `refused` (the last one being the session's) cannot take
// the session's channel: the server refused it, or they hold their share of
// shells. The session moves to another pooled connection to the server.
// Resolves with the new lease, or null when that failed (the session is told)
// or the session went away meanwhile.
async function moveToSpare(
    session: SocketSession,
    lease: SshLease,
    generation: number,
    refused: SshLease[],
    purpose: "terminal" | "files"
): Promise<SshLease | null> {
    let spare: SshLease;
    try {
        spare = await sshPool.acquireSpare(refused);
    } catch (err) {
        if (session.lease === lease && isCurrent(session, generation)) failChannel(session, lease, describeSshError(err), connectionError(err));
        return null;
    }
    if (!isCurrent(session, generation) || session.lease !== lease) {
        spare.release();
        return null;
    }
    dropLease(session, lease);
    holdLease(session, spare, purpose);
    return spare;
}

// Opens the SFTP session of a files socket, on a spare connection when the
// server refuses another channel on this one (sshd MaxSessions).
function openSftp(session: SocketSession, lease: SshLease, generation: number, refused: SshLease[]): void {
    const { socket } = session;
    const stopWaiting = guardChannelOpen(session, lease, generation, "files");
    const onSftp = (err: Error | undefined, sftp: SFTPWrapper | undefined) => {
        stopWaiting();
        if (!isCurrent(session, generation) || session.lease !== lease) {
            sftp?.end();
            return;
        }
        if (err && isChannelRefused(err) && refused.length < MAX_SPARE_CONNECTIONS) {
            log.info(`Server #${lease.serverId} refused an SFTP session on a connection; trying another one`);
            const skipped = [...refused, lease];
            void moveToSpare(session, lease, generation, skipped, "files").then((spare) => {
                if (spare) openSftp(session, spare, generation, skipped);
            });
            return;
        }
        if (err || !sftp) {
            log.warn(`SFTP of server #${lease.serverId} could not start: ${errorMessage(err)}`);
            const error = err && isChannelRefused(err) ? connectionError(Object.assign(err, { code: "CHANNEL_REFUSED" })) : failure("SFTP_FAILED", err);
            failChannel(session, lease, "SFTP Error: " + errorMessage(err), error);
            return;
        }
        session.sftp = sftp;
        const fs = createSftpFs(sftp);
        session.fs = fs;
        let sftpFailure: Error | null = null;
        // Once the session is up ssh2 stops listening for its errors: without
        // this, a malformed SFTP packet would be thrown inside ssh2's parser,
        // which closes the whole pooled connection (every terminal and tunnel
        // of the server). Only the file session ends.
        sftp.on("error", (sftpErr: Error) => {
            log.warn(`SFTP of server #${lease.serverId} failed: ${sftpErr.message}`);
            sftpFailure = sftpErr;
            try { sftp.end(); } catch { /* already closed */ }
        });
        sftp.on("close", () => {
            if (session.sftp === sftp) session.sftp = null;
            if (session.fs === fs) session.fs = null;
            // The SFTP channel ended on its own (sftp-server killed, a session
            // limit, the error above) while the connection stays up: the file
            // manager is told, and may reconnect. A closing connection was
            // already reported by holdLease, which dropped the lease.
            if (!isCurrent(session, generation) || session.lease !== lease) return;
            dropLease(session, lease);
            const ended: Error | null = sftpFailure;
            const error = ended ? failure("SFTP_FAILED", ended) : { code: "SFTP_ENDED", message: "The file session ended." };
            reportError(session, ended ? `The file session failed: ${ended.message}` : error.message, error);
            socket.emit("ssh-closed");
        });
        socket.emit("connection-ready");
    };
    try {
        lease.client.sftp(onSftp);
    } catch (err) {
        // "Not connected": the connection ended before its close event.
        onSftp(err as Error, undefined);
    }
}

type ShellOutcome = { stream: ClientChannel } | { error: Error };

// A command run on a pty instead of the login shell (a container's shell).
// `onClosed` runs once its channel has closed: `exited` tells whether the
// command ended by itself (an exit status came back while the session still
// had it) rather than the session or the connection closing it.
type PtyCommand = { command: string; onClosed: (exited: boolean) => void };

// Asks the connection of `lease` for an interactive shell channel, or for
// `run.command` on a pty (a container's shell).
function requestShell(session: SocketSession, lease: SshLease, generation: number, run?: PtyCommand): Promise<ShellOutcome> {
    return new Promise((resolve) => {
        let settled = false;
        const timeoutMs = sshPool.options.readyTimeout;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            if (isCurrent(session, generation) && session.lease === lease) sshPool.invalidate(lease.serverId);
            const timeout = channelTimeout("terminal", timeoutMs);
            resolve({ error: Object.assign(new Error(timeout.message), { code: timeout.code, details: timeout.details }) });
        }, timeoutMs);
        const onShell = (err: Error | undefined, stream: ClientChannel | undefined) => {
            clearTimeout(timer);
            if (settled) {
                // Opened after the wait was given up: the command may have started.
                if (stream) {
                    stream.close();
                    run?.onClosed(false);
                }
                return;
            }
            settled = true;
            resolve(stream && !err ? { stream } : { error: err ?? new Error("The terminal could not be opened.") });
        };
        const pty = { rows: session.termRows, cols: session.termCols, term: "xterm-256color" };
        try {
            // A container's shell never asks for agent forwarding; a login
            // shell does when the server turned it on (W7-S2).
            if (run) lease.client.exec(run.command, { pty }, onShell);
            else requestShellChannel(lease.client, pty, lease.target, onShell);
        } catch (err) {
            // "Not connected": the connection ended before its close event.
            onShell(err as Error, undefined);
        }
    });
}

// Opens the terminal's shell. A connection that already holds its share of
// shells (MAX_SHELLS_PER_CONNECTION on the server's primary connection,
// MAX_SHELLS_PER_SPARE on a spare), or on which the server refuses another
// channel (sshd MaxSessions), is skipped for a spare pooled connection.
// Resolves true once the shell is live. With `run` the channel runs that
// command on a pty instead (and counts as a shell).
async function openShell(session: SocketSession, initialLease: SshLease, generation: number, run?: PtyCommand): Promise<boolean> {
    let lease = initialLease;
    // Connections this shell will not use; only refusals count against the
    // limit (each full one just leads to the next, or to a new connection).
    const skipped: SshLease[] = [];
    let refusals = 0;
    for (;;) {
        const max = sshPool.isPrimary(lease) ? MAX_SHELLS_PER_CONNECTION : MAX_SHELLS_PER_SPARE;
        const releaseSlot = takeShellSlot(lease.client, max);
        if (!releaseSlot) {
            log.debug(`A connection to server #${lease.serverId} holds ${max} shells; using another one`);
            skipped.push(lease);
            const spare = await moveToSpare(session, lease, generation, skipped, "terminal");
            if (!spare) return false;
            lease = spare;
            continue;
        }

        const outcome = await requestShell(session, lease, generation, run);
        if (!isCurrent(session, generation) || session.lease !== lease) {
            releaseSlot();
            if ("stream" in outcome) {
                outcome.stream.close();
                run?.onClosed(false);
            }
            return false;
        }
        if ("stream" in outcome) {
            // A container's shell exiting ends the session; the connection stays.
            attachShell(session, lease, outcome.stream, releaseSlot, run ? { kind: "session-ended" } : { kind: "connection-closed" }, run?.onClosed);
            return true;
        }
        releaseSlot();
        const refused = isChannelRefused(outcome.error);
        if (!refused || refusals >= MAX_SPARE_CONNECTIONS) {
            const error = refused ? connectionError(Object.assign(outcome.error, { code: "CHANNEL_REFUSED" })) : connectionError(outcome.error);
            failChannel(session, lease, errorMessage(outcome.error), error);
            return false;
        }

        log.info(`Server #${lease.serverId} refused another session on a connection; trying another one`);
        refusals += 1;
        skipped.push(lease);
        const spare = await moveToSpare(session, lease, generation, skipped, "terminal");
        if (!spare) return false;
        lease = spare;
    }
}

// What a paused stream holds (read but not consumed yet), dropped.
function drainBuffered(readable: Readable): number {
    let bytes = 0;
    for (let chunk = readable.read() as Buffer | null; chunk !== null; chunk = readable.read() as Buffer | null) bytes += chunk.length;
    return bytes;
}

function attachShell(
    session: SocketSession,
    lease: SshLease,
    stream: ClientChannel,
    releaseSlot: () => void,
    ended: TerminalNotice,
    onClosed?: PtyCommand["onClosed"]
): void {
    const { socket } = session;
    const output = session.output;
    session.sshStream = stream;
    output?.flush();
    socket.emit("connection-ready");
    // An exit status (not a signal) means the remote command ended by itself.
    let exitStatus: number | null = null;
    stream.on("exit", (code: unknown) => {
        if (typeof code === "number") exitStatus = code;
    });

    // Bytes go out as they came; a character split across packets waits for
    // its rest (per stream, as stdout and stderr interleave).
    const stdout = new Utf8Boundary();
    const stderr = new Utf8Boundary();
    let discarding = false;
    const write = (data: Buffer) => {
        if (!discarding && data.length && session.sshStream === stream) output?.write(data);
    };
    const detach = output?.attach({
        pause: () => stream.pause(),
        resume: () => stream.resume(),
        // While paused, what arrives waits in the channel's buffer (up to
        // ssh2's window): reading it out drops it (its "data" events are
        // ignored meanwhile).
        discard: () => {
            discarding = true;
            try {
                return drainBuffered(stream) + drainBuffered(stream.stderr);
            } finally {
                stdout.end();
                stderr.end();
                discarding = false;
            }
        }
    });
    stream.on("data", (data: Buffer) => write(stdout.push(data)));
    stream.stderr.on("data", (data: Buffer) => write(stderr.push(data)));
    stream.on("error", (err: Error) => {
        log.warn(`SSH shell of server #${lease.serverId} failed: ${err.message}`);
    });
    stream.on("close", () => {
        detach?.();
        releaseSlot();
        const owned = session.sshStream === stream;
        onClosed?.(owned && exitStatus !== null);
        if (!owned) return;
        write(Buffer.concat([stdout.end(), stderr.end()]));
        session.sshStream = null;
        // The shell ended; the pooled connection stays up for other users.
        dropLease(session, lease);
        notify(session, ended);
        socket.emit("ssh-closed");
    });
}

// --- W8-T2 Kubernetes pod shells ---

// The attach field of a start-ssh request: a container's or a pod's.
function parseAttach(value: unknown): AnyTerminalAttach | null {
    if (value && typeof value === "object" && (value as { kind?: unknown }).kind === "pod") return parsePodAttach(value);
    return parseTerminalAttach(value);
}

function describeAttach(attach: AnyTerminalAttach): string {
    return attach.kind === "pod" ? `pod ${attach.namespace}/${attach.pod}/${attach.container}` : `container ${attach.container}`;
}

// The terminal is `kubectl exec -it` into a pod's container on a pty of the
// pooled connection (server/k8s/shell.ts checks the container runs, builds
// the command and audits it). The session ends when the shell exits; when
// the session ends first, the shell left in the container is hung up.
async function openPodShell(session: SocketSession, lease: SshLease, generation: number, attach: PodTerminalAttach): Promise<void> {
    const stale = () => !isCurrent(session, generation) || session.lease !== lease;
    const tag = newTerminalTag();
    let shell: PodShell;
    try {
        shell = await preparePodShell(lease.serverId, attach, tag);
    } catch (err) {
        if (stale()) return;
        log.info(`Pod shell of ${describeAttach(attach)} on server #${lease.serverId} refused: ${errorMessage(err)}`);
        failChannel(session, lease, errorMessage(err), connectionError(err));
        return;
    }
    if (stale() || shell.runner !== "ssh") return;
    const serverId = lease.serverId;
    await openShell(session, lease, generation, {
        command: shell.command,
        onClosed: (exited) => {
            if (!exited) hangUpPodShell(serverId, attach, tag);
        }
    });
}

// A local kubectl server's pod terminal: `kubectl exec -it` in a local
// pseudo-terminal, like the connection's own console.
async function openLocalPodShell(session: SocketSession, target: LocalTarget, generation: number, attach: PodTerminalAttach): Promise<void> {
    const { socket } = session;
    session.connectionType = "local";
    const output = createOutput(session);
    const tag = newTerminalTag();
    let shell: PodShell;
    try {
        shell = await preparePodShell(target.serverId, attach, tag);
    } catch (err) {
        if (!isCurrent(session, generation)) return;
        log.info(`Pod shell of ${describeAttach(attach)} on server #${target.serverId} refused: ${errorMessage(err)}`);
        reportError(session, errorMessage(err), connectionError(err));
        return;
    }
    if (!isCurrent(session, generation) || shell.runner !== "local") return;
    // kubectl exiting by itself means the shell in the container ended.
    let ended = false;
    try {
        const handle = await startLocalTerminal({ command: shell.commandLine, cols: session.termCols, rows: session.termRows }, {
            onData: (chunk) => {
                if (isCurrent(session, generation)) output.write(chunk);
            },
            onExit: () => {
                ended = true;
                if (!isCurrent(session, generation)) return;
                session.localTerm = null;
                notify(session, { kind: "session-ended" });
                socket.emit("ssh-closed");
            }
        });
        // The session going first (tab closed, reconnect) kills kubectl, which
        // may leave the shell running in the container: it is hung up.
        const term: LocalTermHandle = {
            ...handle,
            kill: () => {
                handle.kill();
                if (ended) return;
                ended = true;
                hangUpPodShell(target.serverId, attach, tag);
            }
        };
        if (!isCurrent(session, generation)) {
            term.kill();
            return;
        }
        session.localTerm = term;
        output.attach(term);
        socket.emit("connection-ready");
    } catch (err) {
        log.error(`Pod terminal of server #${target.serverId} failed: ${errorMessage(err)}`);
        if (isCurrent(session, generation)) reportError(session, "Local terminal error: " + errorMessage(err), failure("LOCAL_SPAWN_FAILED", err));
    }
}
