import type { Socket } from "socket.io";
import type { ClientChannel, SFTPWrapper } from "ssh2";
import type { ClientToServerEvents, ServerToClientEvents } from "../../shared/protocol";
import type { RemoteFs } from "../files/remoteFs";
import { TransferRegistry } from "../files/transfers";
import type { LocalTermHandle } from "../local/pty";
import type { SshLease } from "../ssh/pool";
import { createFtpShellState, type FtpShellState } from "./ftpShell";
import type { TerminalOutput } from "./terminalOutput";

export type ShellMindSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

export type ConnectionType = 'ssh' | 'ftp' | 's3' | 'local';

// Mutable state of one socket connection, shared by all its event handlers.
// A socket holds at most one backend connection at a time; start-ssh replaces it.
export interface SocketSession {
    socket: ShellMindSocket;
    // Bumped whenever the connection is torn down (restart or disconnect), so
    // async steps and events of an older connection can tell they are stale.
    generation: number;
    // Pooled SSH connection held by this socket (shared with other sockets).
    lease: SshLease | null;
    sshStream: ClientChannel | null;
    sftp: SFTPWrapper | null;
    localTerm: LocalTermHandle | null; // Local CLI / pty session
    connectionType: ConnectionType;
    termRows: number;
    termCols: number;
    connectionError: string | null;
    // --- terminal ---
    // Batched, flow-controlled "ssh-output" of a terminal session (SSH shell,
    // local PTY or CLI console); null for other connections.
    output: TerminalOutput | null;
    // --- files (S2) ---
    // File access of the connection (SFTP, FTP or S3): the file manager's
    // requests and the FTP virtual shell go through it.
    fs: RemoteFs | null;
    transfers: TransferRegistry;
    ftpShell: FtpShellState;
}

export function createSession(socket: ShellMindSocket): SocketSession {
    return {
        socket,
        generation: 0,
        lease: null,
        sshStream: null,
        sftp: null,
        localTerm: null,
        connectionType: 'ssh',
        termRows: 24,
        termCols: 80,
        connectionError: null,
        output: null,
        fs: null,
        transfers: new TransferRegistry(),
        ftpShell: createFtpShellState()
    };
}

// True while `generation` is still the session's live connection.
export function isCurrent(session: SocketSession, generation: number): boolean {
    return session.generation === generation && session.socket.connected;
}

// Closes whatever connection the session holds and returns the generation of
// the next one. The pooled SSH connection itself stays open for its other users.
export function resetConnection(session: SocketSession): number {
    session.generation += 1;

    const { sshStream, sftp, lease, fs } = session;
    session.sshStream = null;
    session.sftp = null;
    session.lease = null;
    session.fs = null;
    try { sshStream?.close(); } catch { /* already closed */ }
    const closeFiles = () => {
        fs?.close();
        try { sftp?.end(); } catch { /* already closed */ }
    };
    // Partial uploads are removed while their file channel is still open.
    if (session.transfers.active) void session.transfers.abortAll().then(closeFiles);
    else closeFiles();
    lease?.release();

    if (session.localTerm) { session.localTerm.kill(); session.localTerm = null; }

    session.connectionError = null;
    session.ftpShell = createFtpShellState();
    session.output?.dispose();
    session.output = null;
    return session.generation;
}

// Releases everything the session holds when its socket disconnects.
export function disposeSession(session: SocketSession): void {
    resetConnection(session);
}
