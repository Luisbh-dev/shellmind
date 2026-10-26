// The AI chat API (POST /api/chat, /api/chat/history/:serverId), shared by the
// backend and the chat UI.

import type { ContainerEngine, LogSource } from "./ops";
import type { PodTerminalAttach } from "./k8s";

// A conversation turn. "command-output" turns hold the captured output of a
// command that Auto-Run executed: untrusted data, never instructions, so the
// backend hands them to the model inside a delimited data block.
export type ChatMessageKind = "command-output";

export type ChatHistoryItem = {
    role: "user" | "assistant";
    content: string;
    kind?: ChatMessageKind;
    // For "command-output": the command that produced `content`.
    command?: string;
    // Assistant turns: the answer was stopped or cut off before it was
    // complete (a code block left open there must not become runnable).
    partial?: boolean;
    // User turns of a diagnosis: the evidence that was sent with them
    // (untrusted data, like command output).
    evidence?: ChatEvidence;
};

// What the request is for: a message typed by the user, the "Fix it" command
// suggestion, the analysis of a command Auto-Run just executed, or the
// diagnosis of an attachment (the backend writes the instruction for the
// last three; a diagnosis also carries the user's question, if any).
export type ChatPurpose = "chat" | "fix-it" | "autorun-step" | "diagnose";
// The purposes the backend accepts.
export const CHAT_PURPOSES: readonly ChatPurpose[] = ["chat", "fix-it", "autorun-step", "diagnose"];

// What an "Ask AI" button points the chat at (purpose "diagnose"): a
// reference to something on the saved server, never the evidence itself. The
// backend reads the evidence from the server (bounded, redacted, handed to
// the model as untrusted data), so a client cannot put words in its mouth.
export type ChatAttachment =
    // A systemd unit or Windows service, by name.
    | { kind: "service"; name: string }
    // A Docker or Podman container, by name or id (the server's detected
    // engine runs the commands).
    | { kind: "container"; container: string; engine?: ContainerEngine }
    // A log source of the Logs panel: its recent lines, or the lines the
    // user selected there. A client sends those as `excerpt` (the only text
    // an attachment carries, capped at MAX_LOG_EXCERPT_CHARS). The evidence
    // the backend returns names them by `selection` instead, a fingerprint
    // of the redacted lines, so the raw text is neither stored nor sent again.
    | { kind: "logs"; source: LogSource; excerpt?: string; selection?: string }
    // The server's status snapshot and its health verdict.
    | { kind: "status" }
    // The one-click triage pack: failed units, recent errors, disk, memory,
    // the busiest processes and the listening ports.
    | { kind: "triage" }
    // --- W8-T4 disk toolkit ---
    // One filesystem (a mount point, a Windows drive "C:\"): its usage, the
    // largest directories and files, deleted files still held open and the
    // known consumers of space ("why is this disk full?").
    | { kind: "disk"; mount: string }
    // --- W8-T2 Kubernetes ---
    // A pod, by context, namespace and name (kubectl on the server or, for a
    // local kubectl server, on this machine): its state, its events and the
    // last log lines of `container` (by default the one in trouble).
    | { kind: "pod"; context: string; namespace: string; pod: string; container?: string };

export type ChatAttachmentKind = ChatAttachment["kind"];
export const CHAT_ATTACHMENT_KINDS: readonly ChatAttachmentKind[] = ["service", "container", "logs", "status", "triage", "disk", "pod"];

// Size limits of the evidence (characters): the selected log lines a client
// may send, one section, and everything collected for one attachment.
export const MAX_LOG_EXCERPT_CHARS = 16_000;
export const MAX_EVIDENCE_SECTION_CHARS = 16_000;
export const MAX_EVIDENCE_CHARS = 32_000;
export const MAX_EVIDENCE_SECTIONS = 12;
// Older evidence is collected again before it is diagnosed: the answer must
// not rest on a stale picture of the server.
export const EVIDENCE_MAX_AGE_MS = 6 * 60 * 60_000;

// What one part of the evidence is (the UI names it by id).
export type ChatEvidenceSectionId =
    | "service"
    | "journal"
    | "events"
    | "container"
    | "container-logs"
    | "logs"
    | "excerpt"
    | "snapshot"
    | "system"
    | "failed-units"
    | "stopped-services"
    | "errors"
    | "kernel"
    | "disk"
    | "memory"
    | "processes"
    | "ports"
    // The server could not be reached (status, triage): why, and what the
    // fleet board last read of it (dated).
    | "connection"
    | "fleet"
    // --- W8-T4 disk toolkit ("disk" is the filesystems' usage) ---
    | "disk-dirs"
    | "disk-files"
    | "disk-deleted"
    | "disk-consumers"
    // W8-T2: a pod's state, its events and its logs (current and previous instance).
    | "pod"
    | "pod-events"
    | "pod-logs"
    | "pod-previous-logs";

export const CHAT_EVIDENCE_SECTION_IDS: readonly ChatEvidenceSectionId[] = [
    "service", "journal", "events", "container", "container-logs", "logs", "excerpt", "snapshot", "system",
    "failed-units", "stopped-services", "errors", "kernel", "disk", "memory", "processes", "ports", "connection", "fleet",
    // W8-T4
    "disk-dirs", "disk-files", "disk-deleted", "disk-consumers",
    // W8-T2 Kubernetes
    "pod", "pod-events", "pod-logs", "pod-previous-logs"
];

export type ChatEvidenceSection = {
    id: ChatEvidenceSectionId;
    // English title, as the model reads it.
    title: string;
    // What produced it on the server ("journalctl -u nginx.service -n 200").
    source?: string;
    // Redacted and capped; in logs, runs of repeated lines are folded.
    text: string;
    // Part of it was left out to fit the size limits.
    truncated?: boolean;
    // It could not be read: `text` says why.
    failed?: boolean;
    // Read before the evidence was collected (epoch ms): the fleet board's
    // stored reading of a server that cannot be reached now.
    readAt?: number;
};

// Who the commands of a fix would run as, from the server's capabilities:
// its login user, whether that is root (Linux) or an administrator
// (Windows), null when not known, and whether it may use sudo without a
// password. The model is told, so it proposes what this user can run.
export type ChatEvidenceAccess = {
    platform: "linux" | "windows";
    user: string;
    admin: boolean | null;
    sudo: boolean;
};

// What the backend collected for an attachment (POST /api/chat/evidence),
// exactly as the model gets it. The client shows it, then sends it back
// unchanged with the diagnosis; `signature` proves that the backend
// collected it. A signature does not survive a backend restart and the
// evidence expires after EVIDENCE_MAX_AGE_MS: it is then collected again.
export type ChatEvidence = {
    serverId: number;
    attachment: ChatAttachment;
    // Epoch ms.
    collectedAt: number;
    sections: ChatEvidenceSection[];
    // Absent when nothing was read from the server (selected lines, a
    // server that could not be reached).
    access?: ChatEvidenceAccess;
    signature: string;
};

// Body of POST /api/chat/evidence, and its answer.
export type ChatEvidenceRequest = { serverId: number; attachment: ChatAttachment };
export type ChatEvidenceResponse = { evidence: ChatEvidence };

export type ChatCommandOutput = {
    command: string;
    output: string;
    // The output was longer than what is sent (its middle was cut).
    truncated?: boolean;
    // The terminal showed no prompt again before Auto-Run stopped waiting:
    // the command may still be running or waiting for input.
    stillRunning?: boolean;
};

// Body of POST /api/chat. Everything except `message` is optional. The
// terminal output, issues, OS detail and command output are untrusted data
// captured from the user's systems.
// A terminal tab that is a shell inside a container (see TerminalAttach).
export type ChatTerminalShell = { kind: "container"; engine: ContainerEngine; container: string }
    // W8-T2: a shell inside a Kubernetes pod's container.
    | PodTerminalAttach;

export type ChatRequestBody = {
    message?: string;
    purpose?: ChatPurpose;
    model?: string;
    history?: ChatHistoryItem[];
    stream?: boolean;
    // The active connection; the backend reads its type and shell from the DB.
    serverId?: number;
    osDetail?: string;
    terminalOutput?: string;
    issues?: string[];
    commandOutput?: ChatCommandOutput;
    // The focused terminal tab, whose output `terminalOutput` is, is a shell
    // inside one of the server's containers, not the server's own shell.
    terminalShell?: ChatTerminalShell;
    // Purpose "diagnose": what to diagnose, and the evidence the user was
    // shown (POST /api/chat/evidence). Without `evidence` the backend
    // collects it first.
    attachment?: ChatAttachment;
    evidence?: ChatEvidence;
    // The UI language ("en", "es"): the headings of a diagnosis follow it.
    language?: string;
    // Auto-Run is on: the runnable blocks of the answer run by themselves.
    autoRun?: boolean;
};

// Why the model stopped: "max_tokens" means the answer was cut off.
export type ChatStopReason = "end_turn" | "max_tokens" | "stop_sequence" | "other";

// Server-Sent Events of a streamed answer (`stream: true`), one JSON object
// per `data:` line:
//   model  a model attempt starts (a second one means a fallback)
//   delta  incremental answer text
//   done   the final text (canonical, after post-processing)
//   error  generation failed (text already streamed stays valid)
export type ChatStreamEvent =
    | { type: "model"; model: string }
    | { type: "delta"; text: string }
    | { type: "done"; usedModel: string | null; fullText: string; stopReason?: ChatStopReason }
    | { type: "error"; message: string; code?: string };

// JSON answer of POST /api/chat without `stream`.
export type ChatJsonResponse = {
    response: string;
    usedModel?: string | null;
    stopReason?: ChatStopReason;
};

// Error codes of /api/chat ({ error, code } with a 4xx/5xx status, or the
// `code` of an SSE error event).
export const CHAT_ERROR_CODES = {
    invalidRequest: "INVALID_CHAT_REQUEST",
    keyMissing: "AI_KEY_MISSING",
    provider: "AI_PROVIDER_ERROR",
    // The saved API key no longer decrypts (409, details.provider).
    keyUnreadable: "SECRET_UNREADABLE",
    // The evidence sent with a diagnosis is too old, or its signature no
    // longer verifies (the backend restarted) (409): collect it again.
    evidenceExpired: "EVIDENCE_EXPIRED"
} as const;

// A stored conversation message (GET/PUT /api/chat/history/:serverId).
export type StoredChatMessage = ChatHistoryItem;
