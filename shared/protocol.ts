// Socket.io protocol between the frontend and the backend: event names and
// payload shapes. Used as the type parameters of the socket.io Server/Socket.
import type {
    CountRequest,
    CountResult,
    DeleteRequest,
    DeleteResult,
    DownloadAck,
    DownloadChunk,
    DownloadEnd,
    DownloadFailure,
    DownloadStartRequest,
    DownloadStartResult,
    FileReply,
    FileSessionInfo,
    ListRequest,
    ListResult,
    MkdirRequest,
    PathResult,
    ReadRequest,
    ReadResult,
    RenameRequest,
    RenameResult,
    StatRequest,
    StatResult,
    TransferRequest,
    UploadChunkRequest,
    UploadChunkResult,
    UploadEndResult,
    UploadStartRequest,
    UploadStartResult,
    WriteRequest,
    WriteResult
} from "./files";
import type { FleetBoard, FleetHealthEvent } from "./fleet";
import type { PodTerminalAttach } from "./k8s";
import type { ContainerEngine, LogChunkPayload, LogEndPayload, LogErrorPayload, LogStartPayload } from "./ops";
import type { RdpDisconnectRequest, RdpOpenRequest, RdpOpenResult, RdpStatusEvent, RdpTrustCertificateRequest, RdpTrustCertificateResult } from "./rdp";
import type { ConnectionError, TerminalNotice, TrustHostKeyPayload, TrustHostKeyResult } from "./terminal";

// W7-S3: a terminal session that opens a shell inside one of the server's
// containers (`<engine> exec -it <container> <shell>` over the server's
// pooled SSH connection) instead of the login shell. The container is a name
// or id (isValidContainerRef); `shell` defaults to sh.
export type TerminalAttach = {
    kind: "container";
    engine: ContainerEngine;
    container: string;
    shell?: string;
};

// --- W8-T2 Kubernetes: or a shell inside a pod's container (see shared/k8s.ts).
// What a terminal session may attach to; TerminalAttach stays the container's.
export type AnyTerminalAttach = TerminalAttach | PodTerminalAttach;

// Connection request for a saved server. Everything about the target (type,
// host, port, user, credentials, jump host) comes from the database row; only
// the terminal geometry comes from the client. `files` opens a file session
// only (SFTP for SSH servers, no shell); `terminal` opens the interactive one.
export type StartSshPayload = {
    serverId: number;
    purpose: "terminal" | "files";
    cols?: number;
    rows?: number;
    // Terminal purpose only (W7-S3 implements it; until then it is ignored).
    attach?: AnyTerminalAttach;
};

export type LaunchRdpNativePayload = {
    serverId: number;
};

// An SSH host key pinned on first use (see KnownHost).
export type HostKeyInfo = {
    host: string;
    port: number;
    keyType: string;
    fingerprint: string;
    // V1 (BC-02): the jump hosts it is reached through ("" when direct).
    via?: string;
};

// The host presented a different key than the pinned one; the connection was
// refused. Sent together with the usual "ssh-error" message.
export type HostKeyMismatchPayload = {
    code: "HOST_KEY_MISMATCH";
    host: string;
    port: number;
    keyType: string;
    expected: string;
    actual: string;
    // V1 (BC-02): the jump hosts it is reached through ("" when direct).
    via?: string;
};

export type TerminalSize = { cols: number; rows: number };

export interface ClientToServerEvents {
    "start-ssh": (config: StartSshPayload) => void;
    "ssh-input": (data: string) => void;
    "resize": (size: TerminalSize) => void;

    "launch-rdp-native": (config: LaunchRdpNativePayload) => void;

    // --- terminal ---
    // The client wrote this many more bytes of "ssh-output" to the
    // terminal (V1: bytes of the binary messages; a text message counts its
    // length). Acknowledging turns on flow control for the session: the
    // backend pauses the program while too much output is unacknowledged.
    "ssh-ack": (bytes: number) => void;
    // Replaces the changed host key of a host on the route to the server.
    "trust-host-key": (payload: TrustHostKeyPayload, ack: (result: TrustHostKeyResult) => void) => void;
    // --- files (S2): file manager requests, answered through the ack (see shared/files.ts) ---
    "files-session": (reply: FileReply<FileSessionInfo>) => void;
    "files-list": (request: ListRequest, reply: FileReply<ListResult>) => void;
    "files-stat": (request: StatRequest, reply: FileReply<StatResult>) => void;
    "files-read": (request: ReadRequest, reply: FileReply<ReadResult>) => void;
    "files-write": (request: WriteRequest, reply: FileReply<WriteResult>) => void;
    "files-mkdir": (request: MkdirRequest, reply: FileReply<PathResult>) => void;
    "files-rename": (request: RenameRequest, reply: FileReply<RenameResult>) => void;
    "files-delete": (request: DeleteRequest, reply: FileReply<DeleteResult>) => void;
    "files-count": (request: CountRequest, reply: FileReply<CountResult>) => void;
    "files-upload-start": (request: UploadStartRequest, reply: FileReply<UploadStartResult>) => void;
    "files-upload-chunk": (request: UploadChunkRequest, reply: FileReply<UploadChunkResult>) => void;
    "files-upload-end": (request: TransferRequest, reply: FileReply<UploadEndResult>) => void;
    "files-upload-cancel": (request: TransferRequest, reply: FileReply<TransferRequest>) => void;
    "files-download-start": (request: DownloadStartRequest, reply: FileReply<DownloadStartResult>) => void;
    "files-download-ack": (ack: DownloadAck) => void;
    "files-download-cancel": (request: TransferRequest) => void;
    // --- ops ---
    // Live log tail of a saved server (journal, file or container), until stopped.
    "logs-start": (payload: LogStartPayload) => void;
    "logs-stop": (payload: { id: string }) => void;
    // --- fleet (W7-S1) ---
    // Answers with the whole fleet board, then pushes "fleet-health" changes
    // until "fleet-unsubscribe" (or the socket closes).
    "fleet-subscribe": (ack: (board: FleetBoard) => void) => void;
    "fleet-unsubscribe": () => void;
    // --- W7-S6 embedded RDP (see shared/rdp.ts) ---
    // A one-time gateway ticket for a saved Windows server (with the saved
    // password when connecting with it).
    "rdp-open": (request: RdpOpenRequest, ack: (result: RdpOpenResult) => void) => void;
    // Replaces the changed certificate the gateway refused with the one it saw.
    "rdp-trust-certificate": (request: RdpTrustCertificateRequest, ack: (result: RdpTrustCertificateResult) => void) => void;
    // The user ends (or cancels) a gateway session of this socket.
    "rdp-disconnect": (request: RdpDisconnectRequest) => void;
}

export interface ServerToClientEvents {
    // V1: terminal output as UTF-8 bytes (a binary frame; an ArrayBuffer in
    // the browser), never split inside a character. The FTP shell still
    // sends text.
    "ssh-output": (data: string | Uint8Array | ArrayBuffer) => void;
    // V1 (UX-11): `message` is the backend's English text (kept for older
    // listeners); `error` the same failure with a code to translate.
    "ssh-error": (message: string, error?: ConnectionError) => void;
    "ssh-closed": () => void;
    "connection-ready": () => void;
    "ftp-ready": () => void;
    "os-detected": (detail: string) => void;
    "host-key-trusted": (info: HostKeyInfo) => void;
    "host-key-mismatch": (info: HostKeyMismatchPayload) => void;

    "rdp-native-launched": () => void;
    "rdp-error": (message: string) => void;

    // --- terminal ---
    // A message for the terminal that is not program output (written by the
    // client in the user's language, in order with "ssh-output").
    "terminal-notice": (notice: TerminalNotice) => void;
    // --- files (S2): download stream of a files-download-start request ---
    "files-download-chunk": (chunk: DownloadChunk) => void;
    "files-download-end": (end: DownloadEnd) => void;
    "files-download-error": (failure: DownloadFailure) => void;
    // --- ops ---
    "logs-started": (payload: { id: string }) => void;
    // Acknowledge each chunk: the next one waits for it (flow control).
    "logs-chunk": (payload: LogChunkPayload, ack: () => void) => void;
    "logs-error": (payload: LogErrorPayload) => void;
    "logs-end": (payload: LogEndPayload) => void;
    // --- fleet (W7-S1) ---
    // What changed on the fleet board (snapshots, removed servers, alerts,
    // settings), in batches.
    "fleet-health": (event: FleetHealthEvent) => void;
    // --- W7-S6 embedded RDP ---
    // Progress and outcome of a gateway connection this socket opened.
    "rdp-status": (event: RdpStatusEvent) => void;
}
