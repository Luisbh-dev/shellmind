import type { OpsActionResult } from "../../shared/ops";
import { recordAudit } from "../db/auditRepo";
import { errorMessage } from "../errors";
import { createLogger } from "../logger";
import type { ExecResult } from "../ssh/exec";
import type { SshLease } from "../ssh/pool";
import { cleanStderr, commandFailure } from "./remote";

const log = createLogger("ops");

// Colours and cursor moves some tools print even without a terminal (the
// banner of `podman compose`): an action's output is shown as plain text.
// eslint-disable-next-line no-control-regex -- escape sequences are what it removes
const ANSI_ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

// A state-changing command (start a service, remove a container...), built
// from validated input before anything runs.
export type PreparedAction = {
    // The command as the user would type it; recorded in the audit log.
    display: string;
    // W8-T4: "disk" for the disk toolkit's cleanups and releases.
    meta: { kind: "service" | "container" | "compose" | "image" | "disk"; action: string; target: string; service?: string };
    run: (lease: SshLease, signal?: AbortSignal) => Promise<ExecResult>;
};

// Runs the action and records every attempt in the audit log (source "ops"),
// including failures (exit code) and timeouts (no exit code).
export async function performAction(lease: SshLease, action: PreparedAction, signal?: AbortSignal): Promise<OpsActionResult> {
    let result: ExecResult;
    try {
        result = await action.run(lease, signal);
    } catch (err) {
        await audit(lease.serverId, action, null, { error: errorMessage(err) });
        throw err;
    }
    await audit(lease.serverId, action, result.code, result.code === 0 ? {} : { error: failureText(result) });
    if (result.code !== 0) throw commandFailure(result, `${action.meta.action} failed`);
    const output = [result.stdout.trim(), cleanStderr(result.stderr)].filter(Boolean).join("\n");
    return { ok: true, command: action.display, output: output.replace(ANSI_ESCAPES, "") };
}

const AUDIT_ERROR_CHARS = 500;

// What a failed action said, for the audit log: its stderr, or the end of its
// output when it had none (engine and Compose commands run with 2>&1).
export function failureText(result: Pick<ExecResult, "stdout" | "stderr">): string {
    const stderr = cleanStderr(result.stderr);
    if (stderr) return stderr.slice(0, AUDIT_ERROR_CHARS);
    return result.stdout.replace(ANSI_ESCAPES, "").trim().slice(-AUDIT_ERROR_CHARS);
}

async function audit(serverId: number, action: PreparedAction, exitCode: number | null, extra: Record<string, unknown>): Promise<void> {
    try {
        await recordAudit({ serverId, source: "ops", command: action.display, exitCode, meta: { ...action.meta, ...extra } });
    } catch (err) {
        log.error(`Could not record "${action.display}" in the audit log:`, err);
    }
}
