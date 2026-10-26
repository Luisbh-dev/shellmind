import type { OpsCapabilities } from "../../../shared/ops";
import type { SshLease } from "../../ssh/pool";

// What a gatherer works with: the server's pooled connection and what it
// offers (server/ops/capabilities.ts), plus the request's cancellation.
export type EvidenceContext = {
    serverId: number;
    lease: SshLease;
    caps: OpsCapabilities;
    signal?: AbortSignal;
};

// How many lines of a log the evidence asks for.
export const EVIDENCE_LOG_LINES = 200;

// Timeouts of the evidence's own remote commands (the ops and status
// helpers it reuses have theirs).
// PowerShell cold starts are slow, and so is reading the event logs (the
// triage pack takes 20-30 s on an idle Windows Server).
export const EVIDENCE_COMMAND_TIMEOUT_MS = { linux: 30_000, windows: 60_000 } as const;
// What one evidence command may print (exec's own cap is 16 MB): its part
// keeps at most MAX_EVIDENCE_SECTION_CHARS of it anyway.
export const EVIDENCE_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
